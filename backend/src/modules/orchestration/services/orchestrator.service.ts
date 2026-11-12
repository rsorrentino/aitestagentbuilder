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
import { decryptAgentConfig } from '../../../core/domain/agent-secrets.js';
import { describePreflight, isUnattended, runPreflight, unattendedSettings } from '../../automation/unattended.js';
import { RunExecutor } from '../../execution/run-executor.js';
import { emitRunEvent } from '../../../infra/websocket/server.js';
import { REPO_ROOT } from '../../../infra/config/env.js';
import logger from '../../../infra/logger/index.js';
import { triageRun } from '../../quality/triage.js';
import { applyQuarantinePolicy } from '../../quality/quarantine.js';
import { runEvents } from '../../automation/run-events.js';
import { syncRun } from '../../integrations/sync.js';

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
  /** Who started it: schedule, api, cli, ci, … (unattended) or user (a person in the UI) */
  triggeredBy?: string;
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
      metadata: {
        ...(input.metadata ?? {}), strategy: plan.strategy, environment: agent.config.environment,
        // Kept so an interrupted run can be started again with the same tests
        ...(input.testIds?.length ? { testIds: input.testIds.slice(0, 1000) } : {}),
      },
    });
    await this.runRepo.updateRun(run.id, { totalTests: plan.tests.length });
    run.totalTests = plan.tests.length;
    run.agentName = agent.name;

    this.queue.push({ runId: run.id, agent, plan, triggeredBy: input.metadata?.triggeredBy });
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

  /**
   * Unattended runs interrupted by a server restart (within 12 hours) are started again once,
   * unless the agent says unattended.resume_interrupted: false.
   */
  async resumeInterruptedRuns(runs: Array<{ id: string; agentId: string; projectId: string; startedAt: Date; metadata: Record<string, any> }>): Promise<string[]> {
    const started: string[] = [];
    for (const r of runs) {
      const m = r.metadata ?? {};
      if (!isUnattended(m.triggeredBy) || m.resumedFrom || Date.now() - r.startedAt.getTime() > 12 * 3_600_000) continue;
      try {
        const agent = await this.agentRepo.findById(r.agentId, r.projectId);
        if (!agent || !unattendedSettings(agent.config, m.triggeredBy).resumeInterrupted) continue;
        const { error: _e, preflight: _p, strategy: _s, environment: _env, testIds, ...keep } = m;
        const run = await this.startRun({ agentId: r.agentId, projectId: r.projectId, testIds: Array.isArray(testIds) ? testIds : undefined, metadata: { ...keep, resumedFrom: r.id } });
        await this.runRepo.updateRun(r.id, { metadata: { resumedAs: run.id } as any });
        logger.warn('Interrupted run started again', { interrupted: r.id, run: run.id });
        started.push(run.id);
      } catch (e: any) {
        logger.error('Could not start an interrupted run again', { runId: r.id, error: e.message });
      }
    }
    return started;
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

  private async executeRun({ runId, agent, plan, triggeredBy }: QueuedRun): Promise<void> {
    const useLegacyPython = (process.env.EXECUTOR || 'node').toLowerCase() === 'python';
    const unattended = unattendedSettings(agent.config, triggeredBy);
    const executor = useLegacyPython ? null : new RunExecutor(runId, agent, plan.testCases, { rerunFailed: unattended.rerunFailed });
    let pythonCancel: (() => void) | undefined;
    let cancelled = false;
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { markDone = resolve; });
    this.active.set(runId, { cancel: () => { cancelled = true; executor?.cancel(); pythonCancel?.(); }, done });

    let finalStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
    let error: string | undefined;
    // Watchdog: a run that takes too long (hung application, endless waits) is stopped and fails
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      logger.warn('Run exceeded its maximum duration, stopping it', { runId, maxRunMinutes: unattended.maxRunMinutes });
      executor?.cancel();
      pythonCancel?.();
    }, unattended.maxRunMinutes * 60_000);
    watchdog.unref?.();

    try {
      await this.runRepo.updateRun(runId, { status: 'running' });
      logger.info('Run started', { runId, agent: agent.name, tests: plan.tests.length });

      // Pre-flight: is the application there? Retried, so a restart or deploy at night does not fail every test
      let preflightOk = true;
      if (unattended.preflight) {
        const config = decryptAgentConfig(agent.config);
        const pre = await runPreflight(config, plan.testCases, unattended, {
          cancelled: () => cancelled,
          onRetry: (checks, attempt) => emitRunEvent(runId, 'run_log', {
            level: 'warn',
            message: `Pre-flight attempt ${attempt} failed (${checks.filter((c) => c.blocking && !c.ok).map((c) => c.detail).join('; ')}): retrying in ${Math.round(unattended.waitMs / 1000)} s`,
          }),
        });
        await this.runRepo.updateRun(runId, { metadata: { preflight: pre } as any });
        emitRunEvent(runId, 'run_log', { level: pre.ok ? 'info' : 'error', message: describePreflight(pre) });
        if (!pre.ok) {
          preflightOk = false;
          finalStatus = cancelled ? 'cancelled' : 'failed';
          error = describePreflight(pre);
        }
      }

      if (preflightOk && !cancelled) {
        if (executor) {
          finalStatus = await executor.execute();
        } else {
          finalStatus = await this.executeWithPython(runId, agent, plan, (cancel) => { pythonCancel = cancel; });
        }
      }
      if (timedOut) {
        finalStatus = 'failed';
        error = `Stopped after ${unattended.maxRunMinutes} minutes (unattended.max_run_minutes): the run took too long`;
      }
    } catch (e: any) {
      error = e.message;
      finalStatus = 'failed';
      logger.error('Run failed', { runId, error });
    } finally {
      clearTimeout(watchdog);
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
      if (finalStatus === 'failed') await this.triage(runId, agent);
      if (finalStatus !== 'cancelled') await this.updateQuarantine(runId, agent, plan);
      // Jira / GitHub / …: file or update defects, show results on linked stories
      if (finalStatus !== 'cancelled') await syncRun(runId).catch((e) => logger.warn('Integration sync failed', { runId, error: e.message }));
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

  /** Apply the agent's flaky-test policy to the tests of this run (quarantine / release). */
  private async updateQuarantine(runId: string, agent: Agent, plan: TestPlan): Promise<void> {
    try {
      const changed = await applyQuarantinePolicy(agent, plan.testCases.map((tc) => tc.id));
      if (changed.quarantined.length || changed.released.length) {
        await this.runRepo.updateRun(runId, { metadata: { quarantine: changed } });
        logger.info('Quarantine updated', { runId, ...changed });
      }
    } catch (e: any) {
      logger.warn('Quarantine policy failed', { runId, error: e.message });
    }
  }

  /** Group and classify the failures of a finished run (rules; AI too when the agent asks for it). */
  private async triage(runId: string, agent: Agent): Promise<void> {
    try {
      const run = await this.runRepo.findRunById(runId);
      if (!run || !(run.results ?? []).some((r) => ['failed', 'error', 'timeout'].includes(r.status))) return;
      const cfg: any = agent.config ?? {};
      const { getLLMRouter } = await import('../../../infra/llm/router.js');
      const ai = cfg.ai?.triage === true && getLLMRouter().hasAnyProvider();
      const triage = await triageRun(run, { ai, preferred: cfg.ai?.provider }).catch(async (e) => {
        logger.warn('AI triage failed, using rules only', { runId, error: e.message });
        return triageRun(run, { ai: false });
      });
      await this.runRepo.updateRun(runId, { metadata: { triage } });
    } catch (e: any) {
      logger.warn('Failure triage failed', { runId, error: e.message });
    }
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
