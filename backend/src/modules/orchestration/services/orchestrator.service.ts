/**
 * Orchestrator Service
 * Plans a run, executes it in the background and keeps run state up to date.
 *
 * EXECUTOR=node   (default) built-in Playwright executor (modules/execution)
 * EXECUTOR=python legacy Python executor in /executor (optional)
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { Agent } from '../../../core/domain/agent.js';
import { TestRun, TestRunCreateInput } from '../../../core/domain/run.js';
import { AgentRepository } from '../../../core/repositories/agent.repository.js';
import { RunRepository } from '../../../core/repositories/run.repository.js';
import { PlannerAgentService, TestPlan } from '../../agents/services/planner-agent.service.js';
import { RunExecutor } from '../../execution/run-executor.js';
import { emitRunEvent } from '../../../infra/websocket/server.js';
import { REPO_ROOT } from '../../../infra/config/env.js';
import logger from '../../../infra/logger/index.js';
import { runEvents } from '../../automation/run-events.js';

export class RunValidationError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'RunValidationError';
  }
}

interface QueuedRun {
  runId: string;
  agent: Agent;
  plan: TestPlan;
}

export class OrchestratorService {
  private static instance: OrchestratorService | null = null;

  static get(): OrchestratorService {
    if (!this.instance) this.instance = new OrchestratorService();
    return this.instance;
  }

  private agentRepo = new AgentRepository();
  private runRepo = new RunRepository();
  private planner = new PlannerAgentService();
  private maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_RUNS || '2'));
  private active = new Map<string, { cancel: () => void; done: Promise<void> }>();
  private queue: QueuedRun[] = [];

  async previewPlan(agentId: string, projectId: string): Promise<TestPlan> {
    const agent = await this.agentRepo.findById(agentId, projectId);
    if (!agent) throw new RunValidationError(`Agent not found: ${agentId}`, 404);
    return this.planner.createTestPlan(agent.config, agent.projectId);
  }

  async startRun(input: TestRunCreateInput & { testIds?: string[] }): Promise<TestRun> {
    const agent = await this.agentRepo.findById(input.agentId, input.projectId);
    if (!agent) throw new RunValidationError(`Agent not found: ${input.agentId}`, 404);
    if (agent.status !== 'active') throw new RunValidationError(`Agent "${agent.name}" is ${agent.status}`);
    if (!agent.config?.base_url) throw new RunValidationError('Agent has no base_url configured');

    const config = input.testIds?.length
      ? { ...agent.config, test_selection: { testIds: input.testIds } }
      : agent.config;
    const plan = await this.planner.createTestPlan(config, agent.projectId);
    if (plan.tests.length === 0) {
      throw new RunValidationError(
        "No test cases match this agent's test selection. Add test cases (Documents → Extract, " +
        'Generate Tests, or Test Cases → New) or widen the agent\'s module/priority filters.',
      );
    }

    const run = await this.runRepo.createRun({
      agentId: agent.id,
      projectId: agent.projectId,
      metadata: { ...(input.metadata ?? {}), strategy: plan.strategy, environment: agent.config.environment },
    });
    await this.runRepo.updateRun(run.id, { totalTests: plan.tests.length });
    run.totalTests = plan.tests.length;
    run.agentName = agent.name;

    this.queue.push({ runId: run.id, agent, plan });
    this.pump();
    return run;
  }

  async getRunStatus(runId: string, projectId?: string): Promise<TestRun | null> {
    return this.runRepo.findRunById(runId, projectId);
  }

  async cancelRun(runId: string, projectId?: string): Promise<TestRun> {
    const run = await this.runRepo.findRunById(runId, projectId);
    if (!run) throw new RunValidationError(`Run not found: ${runId}`, 404);
    if (run.status !== 'running' && run.status !== 'pending') {
      throw new RunValidationError(`Cannot cancel a run with status "${run.status}"`, 409);
    }

    const queuedIndex = this.queue.findIndex((q) => q.runId === runId);
    if (queuedIndex !== -1) this.queue.splice(queuedIndex, 1);
    this.active.get(runId)?.cancel();

    await this.runRepo.updateRun(runId, { status: 'cancelled', finishedAt: new Date() });
    emitRunEvent(runId, 'run_completed', { status: 'cancelled', total: run.totalTests, passed: run.passedTests, failed: run.failedTests, skipped: run.skippedTests });
    const cancelled = (await this.runRepo.findRunById(runId))!;
    runEvents.emitFinished(cancelled);
    return cancelled;
  }

  getConcurrencyStats(): { running: number; queued: number; maxConcurrent: number } {
    return { running: this.active.size, queued: this.queue.length, maxConcurrent: this.maxConcurrent };
  }

  /** Cancel everything and wait for in-flight runs to stop (graceful shutdown). */
  async shutdown(): Promise<void> {
    this.queue = [];
    const pending = [...this.active.values()];
    pending.forEach(({ cancel }) => cancel());
    await Promise.allSettled(pending.map(({ done }) => done));
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.executeRun(next).catch((error) => {
        logger.error('Run execution crashed', { runId: next.runId, error: error.message });
      });
    }
  }

  private async executeRun({ runId, agent, plan }: QueuedRun): Promise<void> {
    const useLegacyPython = (process.env.EXECUTOR || 'node').toLowerCase() === 'python';
    const executor = useLegacyPython ? null : new RunExecutor(runId, agent, plan.testCases);
    let pythonCancel: (() => void) | undefined;
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { markDone = resolve; });
    this.active.set(runId, { cancel: () => { executor?.cancel(); pythonCancel?.(); }, done });

    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
    let error: string | undefined;

    try {
      await this.runRepo.updateRun(runId, { status: 'running' });
      logger.info('Run started', { runId, agent: agent.name, tests: plan.tests.length });

      if (executor) {
        finalStatus = await executor.execute();
      } else {
        finalStatus = await this.executeWithPython(runId, agent, plan, (cancel) => { pythonCancel = cancel; });
      }
    } catch (e: any) {
      error = e.message;
      finalStatus = 'failed';
      logger.error('Run failed', { runId, error });
    } finally {
      this.active.delete(runId);
    }

    const current = await this.runRepo.findRunById(runId);
    if (current && current.status !== 'cancelled') {
      await this.runRepo.updateRunStats(runId);
      await this.runRepo.updateRun(runId, {
        status: finalStatus,
        finishedAt: new Date(),
        ...(error ? { metadata: { error } } : {}),
      });
      const done = await this.runRepo.findRunById(runId);
      emitRunEvent(runId, 'run_completed', {
        status: finalStatus,
        total: done?.totalTests,
        passed: done?.passedTests,
        failed: done?.failedTests,
        skipped: done?.skippedTests,
        error,
      });
      logger.info('Run finished', { runId, status: finalStatus, passed: done?.passedTests, failed: done?.failedTests });
      if (done) runEvents.emitFinished(done);
    }

    markDone();
    this.pump();
  }

  /** Legacy Python executor (requires `pip install -r executor/requirements.txt`). */
  private executeWithPython(
    runId: string,
    agent: Agent,
    plan: TestPlan,
    registerCancel: (cancel: () => void) => void,
  ): Promise<'completed' | 'failed'> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'), [
        '-m', 'src.runner.test_runner',
        '--run-id', runId,
        '--agent-config', JSON.stringify(agent.config),
        '--test-ids', plan.tests.join(','),
      ], { cwd: join(REPO_ROOT, 'executor'), env: process.env });

      registerCancel(() => child.kill('SIGTERM'));
      child.stdout.on('data', (d) => emitRunEvent(runId, 'run_log', { level: 'info', message: d.toString().trim() }));
      child.stderr.on('data', (d) => emitRunEvent(runId, 'run_log', { level: 'warn', message: d.toString().trim() }));
      child.on('error', (e) => reject(new Error(`Could not start Python executor: ${e.message}`)));
      child.on('close', async (code) => {
        await this.runRepo.updateRunStats(runId);
        const run = await this.runRepo.findRunById(runId);
        if (code !== 0) return reject(new Error(`Python executor exited with code ${code}`));
        resolve(run && run.failedTests > 0 ? 'failed' : 'completed');
      });
    });
  }
}
