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
import { AppSessions } from '../auth/app-login.js';
import { authSettings } from '../auth/profiles.js';
import { SessionVault } from '../auth/session-vault.js';
import { SalesforceSessions } from '../salesforce/session.js';
import { TestDataRepository } from '../../core/repositories/test-data.repository.js';
import { AiActionCache } from '../quality/ai-actions.js';
import { applyThrottling, checkPerformance, pageKey, describePerformance, PERF_INIT_SCRIPT, performanceSettings } from '../quality/performance.js';
import { createFaker, datasetRows, FakeValues, MAX_DATASET_ROWS, rowLabel, seedFor, testDataSettings } from '../quality/test-data-gen.js';

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

/** One test execution: a test case, optionally as a persona and with a data set row. */
interface PlanItem {
  testCase: TestCase;
  persona?: string;
  row?: { index: number; label: string; values: Record<string, any> };
  /** The data set could not be loaded: the test fails with this error */
  dataError?: string;
}

function titleOf(item: PlanItem): string {
  return `${item.testCase.title}${item.persona ? ` [as ${item.persona}]` : ''}${item.row ? ` [${item.row.label}]` : ''}`;
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
  /** Action sequences that completed AI action steps, replayed without the AI */
  private aiActionCache = new AiActionCache();

  constructor(private runId: string, private agent: Agent, private testCases: TestCase[]) {
    this.config = decryptAgentConfig(agent.config);
    this.secrets = this.config.secrets ?? {};
    this.secretList = secretValues(this.config);
    const vault = new SessionVault();
    const sf = salesforceSettings(this.config);
    if (sf) {
      const maxAge = Number(this.config.salesforce?.session_max_age_hours);
      this.salesforce = new SalesforceSessions(sf, { agentId: agent.id, vault, maxAgeHours: maxAge > 0 ? maxAge : 8 });
    }
    const auth = authSettings(this.config);
    if (auth) this.appAuth = new AppSessions(auth, this.config.base_url, { agentId: agent.id, vault });
  }

  /** Login profiles of other applications (agent config auth). */
  private appAuth?: AppSessions;

  /** Who a test starts signed in as: its persona, data.login_as, or the default login profile. */
  private loginFor(testCase: TestCase, persona?: string): string | undefined {
    if (persona) return persona;
    const la = testCase.data?.login_as;
    if (la === false || la === 'none') return undefined;
    if (typeof la === 'string' && la.trim()) return la.trim();
    return this.appAuth?.settings.defaultProfile;
  }

  /** Rows of the data sets the test cases use (data.dataset), loaded once per run. */
  private datasets = new Map<string, { rows: Array<Record<string, any>>; error?: string }>();

  private async loadDatasets(): Promise<void> {
    const repo = new TestDataRepository();
    const { environment } = testDataSettings(this.config);
    for (const tc of this.testCases) {
      const ref = tc.data?.dataset;
      if (ref === undefined || ref === null || ref === '' || this.datasets.has(String(ref))) continue;
      try {
        const set = await repo.findByIdOrName(String(ref), this.agent.projectId, environment);
        if (!set) {
          this.datasets.set(String(ref), { rows: [], error: `Test data set "${ref}" not found in this project` });
          continue;
        }
        let rows = datasetRows(set.data);
        if (!rows.length) {
          this.datasets.set(String(ref), { rows: [], error: `Test data set "${ref}" has no rows` });
          continue;
        }
        if (rows.length > MAX_DATASET_ROWS) {
          this.log(`Test data set "${ref}" has ${rows.length} rows: only the first ${MAX_DATASET_ROWS} run`, {}, 'warn');
          rows = rows.slice(0, MAX_DATASET_ROWS);
        }
        this.datasets.set(String(ref), { rows });
      } catch (e: any) {
        this.datasets.set(String(ref), { rows: [], error: `Test data set "${ref}" could not be loaded: ${e.message}` });
      }
    }
  }

  /**
   * Tests to execute: one per test case, one per persona for tests with data.personas,
   * and one per data set row for tests with data.dataset (personas × rows when both).
   */
  private plan(): PlanItem[] {
    // "all" means every Salesforce persona, or every login profile when the agent has no Salesforce section
    const settings = this.salesforce?.settings ?? (this.appAuth ? { personas: this.appAuth.settings.profiles } as any : null);
    return this.testCases.flatMap((testCase) => {
      const personas: Array<string | undefined> = testPersonas(testCase.data, settings);
      const ref = testCase.data?.dataset;
      const ds = ref !== undefined && ref !== null && ref !== '' ? this.datasets.get(String(ref)) : undefined;
      const rows: Array<Partial<PlanItem>> = !ds
        ? [{}]
        : ds.error
          ? [{ dataError: ds.error }]
          : ds.rows.map((values, index) => ({ row: { index, label: rowLabel(values, index), values } }));
      return (personas.length ? personas : [undefined]).flatMap((persona) =>
        rows.map((r) => ({ testCase, ...(persona ? { persona } : {}), ...r })));
    });
  }

  private mask(text: string): string {
    return maskSecrets(text, this.secretList);
  }

  /**
   * Resolve {{secrets.NAME}} / {{env.NAME}} / {{vars.NAME}} / {{data.FIELD}} / {{fake.KIND}} in a step's target and data values,
   * and apply per-persona overrides: data.by_persona = { rep: { edit: false }, admin: { edit: true } }.
   */
  private resolveStep(step: TestStep, ctx: StepContext): TestStep {
    const persona = ctx.persona;
    // AI action steps: the instruction goes to the AI, so secrets stay placeholders until an action runs
    const keepSecrets = classifyAction(step.action, step) === 'ai_action';
    const extra = { data: ctx.testData?.row ?? null, fake: ctx.testData?.fake, keepSecrets };
    const resolve = (v: any): any => {
      if (typeof v === 'string') return resolvePlaceholders(v, this.secrets, ctx.api?.vars, extra);
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
    await this.loadDatasets();
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
        const { testCase, persona, row } = plan[i];
        const title = titleOf(plan[i]);
        emitRunEvent(this.runId, 'test_started', { testId: testCase.id, title, persona, ...(row ? { dataRow: row.index } : {}), index: i + 1, total });

        let status: string = 'failed';
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) this.log(`Retrying "${title}" (attempt ${attempt + 1}/${retries + 1})`, { testId: testCase.id }, 'warn');
          status = await this.runTestCase(plan[i], attempt);
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

  private async runTestCase(item: PlanItem, attempt: number): Promise<string> {
    const { testCase, persona, row } = item;
    const config = this.config;
    const startedAt = new Date();
    const title = titleOf(item);
    const baseMeta = {
      title, module: testCase.module, priority: testCase.priority, attempt: attempt + 1,
      ...(persona ? { persona } : {}),
      ...(row ? { dataRow: row.index, dataLabel: row.label } : {}),
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
    let testData: StepContext['testData'];

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
      performance: [],
      aiActions: [],
    };
    const perf = performanceSettings(config);
    const measuresSpeed = perf.mode !== 'off' || (testCase.steps ?? []).some((s) => classifyAction(s.action, s) === 'assert_performance');

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
      if (measuresSpeed) await context.addInitScript({ content: PERF_INIT_SCRIPT });
      page = await context.newPage();
      if (measuresSpeed && (await applyThrottling(context, page, perf))) {
        this.log(`  ⚡ Throttled: ${[perf.throttle, perf.cpuSlowdown ? `CPU ${perf.cpuSlowdown}x slower` : ''].filter(Boolean).join(', ')}`, { testId: testCase.id });
      }
      if (item.dataError) throw new Error(item.dataError);
      const td = testDataSettings(config);
      const fake = new FakeValues(await createFaker(td.locale, seedFor(td.seed, testCase.id, persona, row?.index)));
      // Row values may use {{secrets.X}}, {{env.X}} and {{fake.kind}} themselves
      const resolveRow = (v: any): any => typeof v === 'string'
        ? resolvePlaceholders(v, this.secrets, undefined, { fake })
        : Array.isArray(v) ? v.map(resolveRow)
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRow(x)])) : v;
      testData = { fake, ...(row ? { row: resolveRow(row.values) } : {}) };
      const variant = `${persona ?? ''}#${row?.index ?? ''}`;
      const ctxRef: { api?: StepContext['api'] } = {};
      const ctx: StepContext = {
        page,
        baseUrl: config.base_url,
        stepTimeout: parseInt(process.env.STEP_TIMEOUT_MS || '') || Math.min(Number(config.step_timeout) || 10000, 60000),
        config,
        salesforce: this.salesforce,
        auth: this.appAuth,
        persona,
        quality,
        testData,
        api: { vars: {} },
        aiActions: {
          plan: getLLMRouter().hasAnyProvider()
            ? async (system, user) => {
              const r = await getLLMRouter().chat([{ role: 'system', content: system }, { role: 'user', content: user }], 'analysis', { preferred: config.ai?.provider, maxTokens: 600 });
              return { content: r.content, provider: r.provider };
            }
            : undefined,
          cache: {
            get: (stepId, instruction) => this.aiActionCache.get({ agentId: this.agent.id, testCaseId: testCase.id, stepId, variant, instruction }),
            save: (stepId, instruction, actions) => this.aiActionCache.save({ agentId: this.agent.id, testCaseId: testCase.id, stepId, variant, instruction }, actions),
          },
          resolve: (text) => resolvePlaceholders(text, this.secrets, ctxRef.api?.vars, { data: testData?.row ?? null, fake: testData?.fake }),
        },
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

      ctxRef.api = ctx.api;
      const steps: TestStep[] = testCase.steps ?? [];
      if (steps.length === 0) throw new Error('Test case has no steps');

      // Persona tests (and tests of agents with a default login profile) without an explicit login step start signed in.
      const loginAs = this.loginFor(testCase, persona);
      if (loginAs && !steps.some((s) => classifyAction(s.action, s) === 'salesforce_login')) {
        const log = await this.runStep({ stepId: 0, action: 'salesforce_login', data: { persona: loginAs } }, ctx, testCase);
        stepLogs.push(log);
        if (log.status === 'failed') {
          status = 'failed';
          error = `Login as ${loginAs}: ${log.message}`;
        }
      }

      for (const step of status === 'failed' ? [] : steps) {
        if (this.cancelled) throw new CancelledError();
        if (!this.stepAppliesTo(step, persona)) {
          stepLogs.push({ stepId: step.stepId, action: step.action, target: step.target, status: 'skipped', message: `Not for persona ${persona ?? '(none)'}`, durationMs: 0 });
          continue;
        }
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

      // Agent-wide page speed of the page each test ends on (checks.performance: report | fail)
      if (perf.mode !== 'off' && status === 'passed' && !page.isClosed() && !quality.performance!.some((r) => r.page === pageKey(page!.url()))) {
        try {
          const report = await checkPerformance(page, { budgets: perf.budgets, maxRegression: perf.maxRegression, throttle: perf.throttle, agentId: this.agent.id, runId: this.runId });
          quality.performance!.push(report);
          this.log(`  ⚡ ${describePerformance(report)}`, { testId: testCase.id }, report.passed ? 'info' : 'warn');
          if (perf.mode === 'fail' && !report.passed) {
            status = 'failed';
            error = describePerformance(report);
          }
        } catch (e: any) {
          this.log(`  ⚡ Page speed could not be measured: ${e.message}`, { testId: testCase.id }, 'warn');
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
        ...(quality.performance?.length ? { performance: quality.performance } : {}),
        ...(quality.aiActions?.length ? { aiActions: JSON.parse(this.mask(JSON.stringify(quality.aiActions))) } : {}),
        ...(healed.length ? { healing: { steps: healed, applied: healingApplied } } : {}),
        ...(kept.traceMasked ? { traceRedactions: kept.traceMasked } : {}),
        ...this.testDataMeta(row, testData),
        // Lets triage recognise the same failure in later runs
        ...((status === 'failed' || status === 'error') && error
          ? { failureSignature: failureSignature(error, stepLogs.find((l) => l.status === 'failed')?.action) }
          : {}),
      },
    });
    await this.runRepo.updateRunStats(this.runId);

    const icon = status === 'passed' ? '✓' : status === 'skipped' ? '○' : '✗';
    this.log(`${icon} ${title}: ${status}${error ? ` — ${error}` : ''}`, { testId: testCase.id }, status === 'passed' ? 'info' : 'warn');
    emitRunEvent(this.runId, 'test_result', { testId: testCase.id, resultId: result.id, title, persona, ...(row ? { dataRow: row.index } : {}), status, error, duration });
    return status;
  }

  /** Test data shown with the result: the data set row as stored (secrets stay placeholders) and the fake values used. */
  private testDataMeta(row: PlanItem['row'], testData: StepContext['testData']): Record<string, any> {
    const fake = testData?.fake.used() ?? {};
    if (!row && !Object.keys(fake).length) return {};
    const masked = Object.fromEntries(Object.entries(fake).map(([k, v]) => [k, this.mask(v)]));
    return { testData: { ...(row ? { row: row.values } : {}), ...(Object.keys(masked).length ? { fake: masked } : {}) } };
  }

  private async runStep(step: TestStep, ctx: StepContext, testCase: TestCase): Promise<StepLog> {
    const started = Date.now();
    const base = { stepId: step.stepId, action: step.action, target: step.target };
    const kind = classifyAction(step.action, step);
    this.log(`  Step ${step.stepId}: ${step.action}${step.target ? ` → ${step.target}` : ''}`, { testId: testCase.id, stepId: step.stepId });

    try {
      const outcome = await executeStep(this.resolveStep(step, ctx), ctx);
      return { ...base, ...outcome, message: this.mask(outcome.message), durationMs: Date.now() - started };
    } catch (e: any) {
      let message = this.mask(String(e.message || e).split('\n')[0]);
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
    const config = this.config;
    if (!config.ai?.self_healing || !step.target || !isSelectorFailure(kind, error)) return null;

    // Healed earlier in this run on the same page: reuse it, no model call
    const cached = this.healingCache.get(step.target, ctx.page.url());
    if (cached) {
      try {
        const outcome = await executeStep(this.resolveStep(step, ctx), ctx, cached);
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
      const outcome = await executeStep(this.resolveStep(step, ctx), ctx, selector);
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
