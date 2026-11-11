/**
 * Run Executor — runs a test plan in a real browser (Playwright), records
 * results in the database, and streams progress over WebSocket.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { Agent } from '../../core/domain/agent.js';
import { TestCase, TestStep } from '../../core/domain/test-case.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import { emitRunEvent } from '../../infra/websocket/server.js';
import { getLLMRouter } from '../../infra/llm/router.js';
import { extractJsonArray } from '../../infra/llm/json.js';
import { ARTIFACTS_PATH } from '../../infra/config/paths.js';
import logger from '../../infra/logger/index.js';
import { decryptAgentConfig, resolvePlaceholders, secretValues } from '../../core/domain/agent-secrets.js';
import { maskSecrets } from '../../infra/security/secrets.js';
import { launchBrowser, outlinePage } from './browser.js';
import { classifyAction, executeStep, isSelectorFailure, QualityContext, StepContext } from './step-runner.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { describeA11y, scanAccessibility } from '../quality/accessibility.js';
import { evidenceConfig, keepEvidence, redactTrace } from '../quality/evidence.js';
import { applyHealing, HealingCache, healedStepsOf } from '../quality/healing.js';
import { failureSignature } from '../quality/triage.js';
import { Quarantine, QuarantineRepository } from '../quality/quarantine.js';
import { salesforceSettings, testPersonas } from '../salesforce/personas.js';
import { SalesforceSessions } from '../salesforce/session.js';

export { ARTIFACTS_PATH };

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

  /** Agent config with decrypted secrets — kept in memory only for this run. */
  private config: any;
  private secrets: Record<string, string>;
  private secretList: string[];
  private salesforce?: SalesforceSessions;
  /** assert_ai verdicts by content, so identical pages are judged once per run. */
  private aiCache = new Map<string, any>();
  /** Quarantined tests of the project: they run, but their failures do not fail the run. */
  private quarantined = new Map<string, Quarantine>();
  /** Selectors healed earlier in this run: reused without another model call. */
  private healingCache = new HealingCache();

  constructor(private runId: string, private agent: Agent, private testCases: TestCase[]) {
    this.config = decryptAgentConfig(agent.config);
    this.secrets = this.config.secrets ?? {};
    this.secretList = secretValues(this.config);
    const sf = salesforceSettings(this.config);
    if (sf) this.salesforce = new SalesforceSessions(sf);
  }

  /** Tests to execute: one per test case, or one per persona for tests with data.personas. */
  private plan(): Array<{ testCase: TestCase; persona?: string }> {
    const settings = this.salesforce?.settings ?? null;
    return this.testCases.flatMap((testCase) => {
      const personas = testPersonas(testCase.data, settings);
      return personas.length ? personas.map((persona) => ({ testCase, persona })) : [{ testCase }];
    });
  }

  private mask(text: string): string {
    return maskSecrets(text, this.secretList);
  }

  /**
   * Resolve {{secrets.NAME}} / {{env.NAME}} in a step's target and data values,
   * and apply per-persona overrides: data.by_persona = { rep: { edit: false }, admin: { edit: true } }.
   */
  private resolveStep(step: TestStep, persona?: string, vars?: Record<string, string>): TestStep {
    const resolve = (v: any): any => {
      if (typeof v === 'string') return resolvePlaceholders(v, this.secrets, vars);
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
      return v;
    };
    let data = step.data;
    if (data?.by_persona && typeof data.by_persona === 'object') {
      const { by_persona, ...rest } = data;
      const override = persona ? by_persona[persona] ?? by_persona.default : by_persona.default;
      data = { ...rest, ...(override && typeof override === 'object' ? override : {}) };
    }
    let target = step.target;
    if (step.data?.by_persona && data && data.target !== undefined) {
      const { target: t, ...others } = data;
      target = String(t);
      data = others;
    }
    return { ...step, target: target ? resolve(target) : target, data: data ? resolve(data) : data };
  }

  /** Steps limited with data.only_personas / data.skip_personas do not run for other personas. */
  private stepAppliesTo(step: TestStep, persona?: string): boolean {
    const list = (v: any): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x: any) => String(x).trim()).filter(Boolean);
    const only = list(step.data?.only_personas);
    if (only.length && (!persona || !only.includes(persona))) return false;
    if (persona && list(step.data?.skip_personas).includes(persona)) return false;
    return true;
  }

  cancel(): void {
    this.cancelled = true;
    this.browser?.close().catch(() => undefined);
  }

  private log(message: string, extra: Record<string, any> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
    emitRunEvent(this.runId, 'run_log', { level, message: this.mask(message), ...extra });
  }

  /** Runs every test; resolves with the final run status. */
  async execute(): Promise<'completed' | 'failed' | 'cancelled'> {
    const plan = this.plan();
    const total = plan.length;
    const counts = { passed: 0, failed: 0, skipped: 0, quarantined: 0 };
    const config = this.config;
    this.quarantined = await new QuarantineRepository().ids(this.agent.projectId).catch(() => new Map());
    const retries = Math.min(Math.max(Number(config.retries ?? 0), 0), 3);

    emitRunEvent(this.runId, 'run_started', { total, agentId: this.agent.id, agentName: this.agent.name });
    this.log(`Starting run for agent "${this.agent.name}" — ${total} test(s) against ${config.base_url}`);

    try {
      this.browser = await launchBrowser();
      this.log(`Browser started (${this.browser.browserType().name()} ${this.browser.version()})`);

      for (let i = 0; i < total; i++) {
        if (this.cancelled) throw new CancelledError();
        const { testCase, persona } = plan[i];
        const title = persona ? `${testCase.title} [as ${persona}]` : testCase.title;
        emitRunEvent(this.runId, 'test_started', { testId: testCase.id, title, persona, index: i + 1, total });

        let status: string = 'failed';
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) this.log(`Retrying "${title}" (attempt ${attempt + 1}/${retries + 1})`, { testId: testCase.id }, 'warn');
          status = await this.runTestCase(testCase, attempt, persona);
          if (status !== 'failed' && status !== 'error') break;
          if (this.cancelled) throw new CancelledError();
        }

        if (status === 'passed') counts.passed++;
        else if (status === 'skipped') counts.skipped++;
        else if (this.quarantined.has(testCase.id)) {
          counts.quarantined++;
          this.log(`  🧪 "${title}" is quarantined: its failure does not fail the run`, { testId: testCase.id }, 'warn');
        } else counts.failed++;

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

  private async runTestCase(testCase: TestCase, attempt: number, persona?: string): Promise<string> {
    const config = this.config;
    const startedAt = new Date();
    const title = persona ? `${testCase.title} [as ${persona}]` : testCase.title;
    const baseMeta = {
      title, module: testCase.module, priority: testCase.priority, attempt: attempt + 1,
      ...(persona ? { persona } : {}),
      ...(this.quarantined.has(testCase.id) ? { quarantined: true } : {}),
    };
    const result = await this.runRepo.createResult({
      runId: this.runId,
      testCaseId: testCase.id,
      status: 'running' as any,
      startedAt,
      metadata: baseMeta,
    });

    const stepLogs: StepLog[] = [];
    const screenshots: string[] = [];
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let status: 'passed' | 'failed' | 'skipped' | 'error' = 'passed';
    let error: string | undefined;

    this.log(`▶ ${title}`, { testId: testCase.id });

    const evidence = evidenceConfig(config);
    const videoDir = evidence.video !== 'off' ? mkdtempSync(join(tmpdir(), 'atab-video-')) : undefined;
    const quality: QualityContext = {
      projectId: this.agent.projectId,
      agentId: this.agent.id,
      runId: this.runId,
      resultId: result.id,
      testCaseId: testCase.id,
      accessibility: [],
      visual: [],
      aiChecks: [],
    };

    try {
      context = await this.browser!.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
      });
      if (evidence.trace !== 'off') {
        await context.tracing.start({ title, screenshots: true, snapshots: true, sources: false }).catch((e) => {
          logger.warn('Could not start tracing', { error: e.message });
        });
      }
      page = await context.newPage();
      const ctx: StepContext = {
        page,
        baseUrl: config.base_url,
        stepTimeout: parseInt(process.env.STEP_TIMEOUT_MS || '') || Math.min(Number(config.step_timeout) || 10000, 60000),
        config,
        salesforce: this.salesforce,
        persona,
        quality,
        api: { vars: {} },
        ai: {
          judge: async (system, user) => {
            const router = getLLMRouter();
            if (!router.hasAnyProvider()) throw new Error('assert_ai needs an AI provider, and none is configured');
            const r = await router.chat([{ role: 'system', content: system }, { role: 'user', content: user }], 'analysis', { preferred: config.ai?.provider, maxTokens: 400 });
            return { content: r.content, provider: r.provider };
          },
          outline: (p) => outlinePage(p, 80),
          mask: (text) => this.mask(text),
          cache: this.aiCache,
        },
      };

      const steps: TestStep[] = testCase.steps ?? [];
      if (steps.length === 0) throw new Error('Test case has no steps');

      // Persona tests without an explicit login step start logged in as the persona.
      if (persona && !steps.some((s) => classifyAction(s.action, s) === 'salesforce_login')) {
        const log = await this.runStep({ stepId: 0, action: 'salesforce_login', data: { persona } }, ctx, testCase, persona);
        stepLogs.push(log);
        if (log.status === 'failed') {
          status = 'failed';
          error = `Login as ${persona}: ${log.message}`;
        }
      }

      for (const step of status === 'failed' ? [] : steps) {
        if (this.cancelled) throw new CancelledError();
        if (!this.stepAppliesTo(step, persona)) {
          stepLogs.push({ stepId: step.stepId, action: step.action, target: step.target, status: 'skipped', message: `Not for persona ${persona ?? '(none)'}`, durationMs: 0 });
          continue;
        }
        const log = await this.runStep(step, ctx, testCase, persona);
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

      // Agent-wide accessibility scan of the page each test ends on (checks.accessibility: report | fail)
      const a11yMode = config.checks?.accessibility;
      if ((a11yMode === 'report' || a11yMode === 'fail') && status === 'passed' && !page.isClosed()) {
        try {
          const report = await scanAccessibility(page, config.checks?.accessibility_options ?? {});
          quality.accessibility.push(report);
          this.log(`  ♿ ${describeA11y(report)}`, { testId: testCase.id }, report.failing ? 'warn' : 'info');
          if (a11yMode === 'fail' && report.failing > 0) {
            status = 'failed';
            error = describeA11y(report);
          }
        } catch (e: any) {
          this.log(`  ♿ Accessibility scan failed: ${e.message}`, { testId: testCase.id }, 'warn');
        }
      }
    } catch (e: any) {
      if (e instanceof CancelledError || this.cancelled) {
        status = 'skipped';
        error = 'Run cancelled';
      } else {
        status = 'error';
        error = this.mask(e.message);
      }
    }

    if (page && !page.isClosed()) {
      const file = await this.saveScreenshot(page, result.id, status === 'passed' ? 'final' : 'failure');
      if (file) screenshots.push(file);
    }
    const kept = await this.collectEvidence(context, page, result.id, status, evidence, videoDir);
    await context?.close().catch(() => undefined);
    if (kept.videoTask) kept.video = await kept.videoTask;
    if (videoDir) rmSync(videoDir, { recursive: true, force: true });

    // Keep selectors the AI repaired: write them back to the test case when the agent asks for it
    const healed = healedStepsOf({ steps: stepLogs });
    let healingApplied = false;
    if (healed.length && status === 'passed' && config.ai?.auto_apply_healing === true) {
      healingApplied = await this.writeBackHealing(testCase, healed);
    }

    const finishedAt = new Date();
    const duration = finishedAt.getTime() - startedAt.getTime();
    await this.runRepo.updateResult(result.id, {
      status: status as any,
      finishedAt,
      duration,
      logs: stepLogs.map((l) => `[${l.status.toUpperCase()}] Step ${l.stepId}: ${l.action}${l.target ? ` → ${l.target}` : ''} — ${l.message}`),
      error,
      evidence: { screenshots, ...(kept.trace ? { trace: kept.trace } : {}), ...(kept.video ? { video: kept.video } : {}) },
      metadata: {
        ...baseMeta,
        steps: stepLogs,
        ...(quality.accessibility.length ? { accessibility: quality.accessibility } : {}),
        ...(quality.visual.length ? { visual: quality.visual } : {}),
        ...(quality.aiChecks?.length ? { aiChecks: quality.aiChecks } : {}),
        ...(healed.length ? { healing: { steps: healed, applied: healingApplied } } : {}),
        ...(kept.traceMasked ? { traceRedactions: kept.traceMasked } : {}),
        // Lets triage recognise the same failure in later runs
        ...((status === 'failed' || status === 'error') && error
          ? { failureSignature: failureSignature(error, stepLogs.find((l) => l.status === 'failed')?.action) }
          : {}),
      },
    });
    await this.runRepo.updateRunStats(this.runId);

    const icon = status === 'passed' ? '✓' : status === 'skipped' ? '○' : '✗';
    this.log(`${icon} ${title}: ${status}${error ? ` — ${error}` : ''}`, { testId: testCase.id }, status === 'passed' ? 'info' : 'warn');
    emitRunEvent(this.runId, 'test_result', { testId: testCase.id, resultId: result.id, title, persona, status, error, duration });
    return status;
  }

  private async runStep(step: TestStep, ctx: StepContext, testCase: TestCase, persona?: string): Promise<StepLog> {
    const started = Date.now();
    const base = { stepId: step.stepId, action: step.action, target: step.target };
    const kind = classifyAction(step.action, step);
    this.log(`  Step ${step.stepId}: ${step.action}${step.target ? ` → ${step.target}` : ''}`, { testId: testCase.id, stepId: step.stepId });

    try {
      const outcome = await executeStep(this.resolveStep(step, persona, ctx.api?.vars), ctx);
      return { ...base, ...outcome, message: this.mask(outcome.message), durationMs: Date.now() - started };
    } catch (e: any) {
      let message = this.mask(String(e.message || e).split('\n')[0]);
      if (step.target && /Timeout \d+ms exceeded/.test(message)) {
        message = `Element "${step.target}" was not found or not actionable (${message})`;
      }
      const healed = await this.trySelfHeal(step, ctx, kind, message, testCase, persona);
      if (healed) return { ...base, ...healed, durationMs: Date.now() - started };
      return { ...base, status: 'failed', message, durationMs: Date.now() - started };
    }
  }

  /** Ask the LLM for a replacement selector when a step fails on a selector. */
  private async trySelfHeal(step: TestStep, ctx: StepContext, kind: ReturnType<typeof classifyAction>, error: string, testCase: TestCase, persona?: string) {
    const config = this.config;
    if (!config.ai?.self_healing || !step.target || !isSelectorFailure(kind, error)) return null;

    // Healed earlier in this run on the same page: reuse it, no model call
    const cached = this.healingCache.get(step.target, ctx.page.url());
    if (cached) {
      try {
        const outcome = await executeStep(this.resolveStep(step, persona, ctx.api?.vars), ctx, cached);
        this.log(`  🩹 Reused healed selector "${cached}" for "${step.target}"`, { testId: testCase.id, stepId: step.stepId });
        return { ...outcome, message: `${outcome.message} (healed selector reused: "${step.target}" → "${cached}")`, healedSelector: cached };
      } catch {
        // the page changed again: ask the model
      }
    }

    const router = getLLMRouter();
    if (!router.hasAnyProvider()) return null;

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

      const failedUrl = ctx.page.url();
      const outcome = await executeStep(this.resolveStep(step, persona, ctx.api?.vars), ctx, selector);
      this.healingCache.set(step.target, failedUrl, selector);
      this.log(`  🩹 Healed: "${step.target}" → "${selector}"`, { testId: testCase.id, stepId: step.stepId });
      return { ...outcome, message: `${outcome.message} (self-healed from "${step.target}")`, healedSelector: selector };
    } catch (e: any) {
      logger.debug('Self-healing failed', { error: e.message });
      return null;
    }
  }

  /**
   * Stop tracing and keep the trace / video when the agent's evidence settings ask for it.
   * Traces are redacted: every secret of the run is replaced with •••• inside the file.
   */
  private async collectEvidence(
    context: BrowserContext | undefined,
    page: Page | undefined,
    resultId: string,
    status: string,
    evidence: ReturnType<typeof evidenceConfig>,
    videoDir?: string,
  ): Promise<{ trace?: string; video?: string; videoTask?: Promise<string | undefined>; traceMasked?: number }> {
    const out: { trace?: string; video?: string; videoTask?: Promise<string | undefined>; traceMasked?: number } = {};
    if (!context) return out;
    const dir = join(ARTIFACTS_PATH, this.runId);

    if (evidence.trace !== 'off') {
      try {
        if (keepEvidence(evidence.trace, status)) {
          mkdirSync(dir, { recursive: true });
          // Unredacted trace only ever exists outside the served artifacts folder
          const raw = join(mkdtempSync(join(tmpdir(), 'atab-trace-')), 'trace.zip');
          // Session cookies are credentials too (any app): mask their values in headers
          const cookieValues = (await context.cookies().catch(() => [])).map((c) => c.value).filter((v) => v.length >= 16);
          await context.tracing.stop({ path: raw });
          const secrets = [...this.secretList, ...(this.salesforce?.sessionSecrets() ?? []), ...cookieValues];
          const { zip, masked } = await redactTrace(readFileSync(raw), secrets);
          writeFileSync(join(dir, `${resultId}-trace.zip`), zip);
          rmSync(join(raw, '..'), { recursive: true, force: true });
          out.trace = `${this.runId}/${resultId}-trace.zip`;
          if (masked) out.traceMasked = masked;
        } else {
          await context.tracing.stop();
        }
      } catch (e: any) {
        logger.warn('Could not save the trace', { error: e.message });
      }
    }

    const video = page?.video();
    if (video && videoDir) {
      const keep = keepEvidence(evidence.video, status);
      // The video is finalised when the context closes; saveAs waits for that.
      out.videoTask = (async () => {
        try {
          if (!keep) return undefined;
          mkdirSync(dir, { recursive: true });
          await video.saveAs(join(dir, `${resultId}-video.webm`));
          return `${this.runId}/${resultId}-video.webm`;
        } catch (e: any) {
          logger.warn('Could not save the video', { error: e.message });
          return undefined;
        } finally {
          await video.delete().catch(() => undefined);
        }
      })();
    }
    return out;
  }

  /** Write healed selectors back into the test case (agent config ai.auto_apply_healing). */
  private async writeBackHealing(testCase: TestCase, healed: ReturnType<typeof healedStepsOf>): Promise<boolean> {
    try {
      const repo = new TestCaseRepository();
      const current = await repo.findById(testCase.id, this.agent.projectId);
      if (!current) return false;
      const { steps, applied } = applyHealing(current.steps, healed);
      if (!applied.length) return false;
      await repo.update(current.id, { steps }, this.agent.projectId);
      this.log(`  🩹 Saved ${applied.length} healed selector(s) to "${testCase.title}"`, { testId: testCase.id });
      return true;
    } catch (e: any) {
      logger.warn('Could not save healed selectors', { error: e.message });
      return false;
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
