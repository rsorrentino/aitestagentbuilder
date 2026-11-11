/**
 * Run Executor — runs a test plan in a real browser (Playwright), records
 * results in the database, and streams progress over WebSocket.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { Agent } from '../../core/domain/agent.js';
import { TestCase, TestStep } from '../../core/domain/test-case.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import { emitRunEvent } from '../../infra/websocket/server.js';
import { getLLMRouter } from '../../infra/llm/router.js';
import { extractJsonArray } from '../../infra/llm/json.js';
import { BACKEND_ROOT } from '../../infra/config/env.js';
import logger from '../../infra/logger/index.js';
import { launchBrowser, outlinePage } from './browser.js';
import { classifyAction, executeStep, isSelectorFailure, StepContext } from './step-runner.js';

export const ARTIFACTS_PATH = process.env.ARTIFACTS_PATH || join(BACKEND_ROOT, 'artifacts');

export interface StepLog {
  stepId: number;
  action: string;
  target?: string;
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  durationMs: number;
  healedSelector?: string;
}

class CancelledError extends Error {
  constructor() {
    super('Run cancelled');
  }
}

export class RunExecutor {
  private runRepo = new RunRepository();
  private cancelled = false;
  private browser?: Browser;

  constructor(private runId: string, private agent: Agent, private testCases: TestCase[]) {}

  cancel(): void {
    this.cancelled = true;
    this.browser?.close().catch(() => undefined);
  }

  private log(message: string, extra: Record<string, any> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
    emitRunEvent(this.runId, 'run_log', { level, message, ...extra });
  }

  /** Runs every test; resolves with the final run status. */
  async execute(): Promise<'completed' | 'failed' | 'cancelled'> {
    const total = this.testCases.length;
    const counts = { passed: 0, failed: 0, skipped: 0 };
    const config = this.agent.config as any;
    const retries = Math.min(Math.max(Number(config.retries ?? 0), 0), 3);

    emitRunEvent(this.runId, 'run_started', { total, agentId: this.agent.id, agentName: this.agent.name });
    this.log(`Starting run for agent "${this.agent.name}" — ${total} test(s) against ${config.base_url}`);

    try {
      this.browser = await launchBrowser();
      this.log(`Browser started (${this.browser.browserType().name()} ${this.browser.version()})`);

      for (let i = 0; i < total; i++) {
        if (this.cancelled) throw new CancelledError();
        const testCase = this.testCases[i];
        emitRunEvent(this.runId, 'test_started', { testId: testCase.id, title: testCase.title, index: i + 1, total });

        let status: string = 'failed';
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) this.log(`Retrying "${testCase.title}" (attempt ${attempt + 1}/${retries + 1})`, { testId: testCase.id }, 'warn');
          status = await this.runTestCase(testCase, attempt);
          if (status !== 'failed' && status !== 'error') break;
          if (this.cancelled) throw new CancelledError();
        }

        if (status === 'passed') counts.passed++;
        else if (status === 'skipped') counts.skipped++;
        else counts.failed++;

        emitRunEvent(this.runId, 'run_progress', { status: 'running', completed: i + 1, total, ...counts });
      }

      return counts.failed > 0 ? 'failed' : 'completed';
    } catch (error: any) {
      if (error instanceof CancelledError || this.cancelled) {
        this.log('Run cancelled', {}, 'warn');
        return 'cancelled';
      }
      this.log(`Run aborted: ${error.message}`, {}, 'error');
      await this.runRepo.updateRun(this.runId, { metadata: { error: error.message } as any }).catch(() => undefined);
      throw error;
    } finally {
      await this.browser?.close().catch(() => undefined);
    }
  }

  private async runTestCase(testCase: TestCase, attempt: number): Promise<string> {
    const config = this.agent.config as any;
    const startedAt = new Date();
    const result = await this.runRepo.createResult({
      runId: this.runId,
      testCaseId: testCase.id,
      status: 'running' as any,
      startedAt,
      metadata: { title: testCase.title, module: testCase.module, priority: testCase.priority, attempt: attempt + 1 },
    });

    const stepLogs: StepLog[] = [];
    const screenshots: string[] = [];
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let status: 'passed' | 'failed' | 'skipped' | 'error' = 'passed';
    let error: string | undefined;

    this.log(`▶ ${testCase.title}`, { testId: testCase.id });

    try {
      context = await this.browser!.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
      page = await context.newPage();
      const ctx: StepContext = {
        page,
        baseUrl: config.base_url,
        stepTimeout: parseInt(process.env.STEP_TIMEOUT_MS || '') || Math.min(Number(config.step_timeout) || 10000, 60000),
        config,
      };

      const steps: TestStep[] = testCase.steps ?? [];
      if (steps.length === 0) throw new Error('Test case has no steps');

      for (const step of steps) {
        if (this.cancelled) throw new CancelledError();
        const log = await this.runStep(step, ctx, testCase);
        stepLogs.push(log);
        await this.streamScreenshot(page, testCase.id);
        if (log.status === 'failed') {
          status = 'failed';
          error = `Step ${log.stepId} (${log.action}): ${log.message}`;
          break;
        }
      }

      const executed = stepLogs.filter((l) => l.status !== 'skipped').length;
      if (status === 'passed' && executed === 0) {
        status = 'skipped';
        error = 'No automatable steps — use actions such as navigate, click, fill, assert_text.';
      }
    } catch (e: any) {
      if (e instanceof CancelledError || this.cancelled) {
        status = 'skipped';
        error = 'Run cancelled';
      } else {
        status = 'error';
        error = e.message;
      }
    }

    if (page && !page.isClosed()) {
      const file = await this.saveScreenshot(page, result.id, status === 'passed' ? 'final' : 'failure');
      if (file) screenshots.push(file);
    }
    await context?.close().catch(() => undefined);

    const finishedAt = new Date();
    const duration = finishedAt.getTime() - startedAt.getTime();
    await this.runRepo.updateResult(result.id, {
      status: status as any,
      finishedAt,
      duration,
      logs: stepLogs.map((l) => `[${l.status.toUpperCase()}] Step ${l.stepId}: ${l.action}${l.target ? ` → ${l.target}` : ''} — ${l.message}`),
      error,
      evidence: { screenshots },
      metadata: { title: testCase.title, module: testCase.module, priority: testCase.priority, attempt: attempt + 1, steps: stepLogs },
    });
    await this.runRepo.updateRunStats(this.runId);

    const icon = status === 'passed' ? '✓' : status === 'skipped' ? '○' : '✗';
    this.log(`${icon} ${testCase.title}: ${status}${error ? ` — ${error}` : ''}`, { testId: testCase.id }, status === 'passed' ? 'info' : 'warn');
    emitRunEvent(this.runId, 'test_result', { testId: testCase.id, resultId: result.id, title: testCase.title, status, error, duration });
    return status;
  }

  private async runStep(step: TestStep, ctx: StepContext, testCase: TestCase): Promise<StepLog> {
    const started = Date.now();
    const base = { stepId: step.stepId, action: step.action, target: step.target };
    const kind = classifyAction(step.action, step);
    this.log(`  Step ${step.stepId}: ${step.action}${step.target ? ` → ${step.target}` : ''}`, { testId: testCase.id, stepId: step.stepId });

    try {
      const outcome = await executeStep(step, ctx);
      return { ...base, ...outcome, durationMs: Date.now() - started };
    } catch (e: any) {
      let message = String(e.message || e).split('\n')[0];
      if (step.target && /Timeout \d+ms exceeded/.test(message)) {
        message = `Element "${step.target}" was not found or not actionable (${message})`;
      }
      const healed = await this.trySelfHeal(step, ctx, kind, message, testCase);
      if (healed) return { ...base, ...healed, durationMs: Date.now() - started };
      return { ...base, status: 'failed', message, durationMs: Date.now() - started };
    }
  }

  /** Ask the LLM for a replacement selector when a step fails on a selector. */
  private async trySelfHeal(step: TestStep, ctx: StepContext, kind: ReturnType<typeof classifyAction>, error: string, testCase: TestCase) {
    const config = this.agent.config as any;
    const router = getLLMRouter();
    if (!config.ai?.self_healing || !step.target || !isSelectorFailure(kind, error) || !router.hasAnyProvider()) return null;

    try {
      this.log(`  🩹 Self-healing selector "${step.target}"…`, { testId: testCase.id, stepId: step.stepId }, 'warn');
      const outline = await outlinePage(ctx.page, 120);
      const response = await router.chat([
        {
          role: 'system',
          content: 'You fix broken UI test selectors. Reply with JSON only: [{"selector": "<playwright selector>"}]. ' +
            'Use a selector from the page outline. If nothing matches, reply [{"selector": null}].',
        },
        {
          role: 'user',
          content: `Step: ${step.action}\nFailed selector: ${step.target}\nError: ${error}\n\nPage outline:\n${outline}`,
        },
      ], 'healing', { preferred: config.ai?.provider, maxTokens: 300 });

      const selector = extractJsonArray(response.content)[0]?.selector;
      if (!selector || selector === step.target) return null;

      const outcome = await executeStep(step, ctx, selector);
      this.log(`  🩹 Healed: "${step.target}" → "${selector}"`, { testId: testCase.id, stepId: step.stepId });
      return { ...outcome, message: `${outcome.message} (self-healed from "${step.target}")`, healedSelector: selector };
    } catch (e: any) {
      logger.debug('Self-healing failed', { error: e.message });
      return null;
    }
  }

  private async streamScreenshot(page: Page, testId: string): Promise<void> {
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 5000 });
      emitRunEvent(this.runId, 'run_screenshot', { testId, image: buffer.toString('base64') });
    } catch {
      // screenshots are best-effort
    }
  }

  private async saveScreenshot(page: Page, resultId: string, label: string): Promise<string | null> {
    try {
      const dir = join(ARTIFACTS_PATH, this.runId);
      mkdirSync(dir, { recursive: true });
      const fileName = `${resultId}-${label}.png`;
      writeFileSync(join(dir, fileName), await page.screenshot({ type: 'png', timeout: 5000 }));
      return `${this.runId}/${fileName}`;
    } catch {
      return null;
    }
  }
}
