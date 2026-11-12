/**
 * Step Runner — executes one test step on a Playwright page.
 *
 * Accepts both the canonical actions (navigate, click, fill, assert_text, …)
 * and the natural-language phrasing produced by document extraction
 * ("Click the login button", "Verify the dashboard is shown").
 */

import { cellText, checkResult, DbConnections } from '../database/db.js';
import type { Locator, Page } from 'playwright';
import { TestStep } from '../../core/domain/test-case.js';
import { SalesforceSessions } from '../salesforce/session.js';
import { AppSessions } from '../auth/app-login.js';
import type { CodeFetcher } from '../auth/code-sources.js';
import { A11yReport, describeA11y, scanAccessibility } from '../quality/accessibility.js';
import { checkScreenshot, describeVisual, VisualEntry } from '../quality/visual.js';
import { ApiState, checkJson, describeResponse, extractVars, mockRoute, sendRequest, statusMatches } from '../quality/api-testing.js';
import { AiVerdict, describeVerdict, judgeExpectation, Judge } from '../quality/ai-assert.js';
import { AiAction, AiActionError, AiActionRecord, describeActions, Planner, runAiAction, successfulActions } from '../quality/ai-actions.js';
import { budgetFromSentence, checkPerformance, DEFAULT_BUDGETS, describePerformance, normalizeBudgets, PerfReport, performanceSettings } from '../quality/performance.js';

export type StepKind =
  | 'navigate' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'wait'
  | 'assert_visible' | 'assert_text' | 'assert_url' | 'assert_title' | 'screenshot'
  | 'assert_not_visible' | 'assert_access_denied'
  | 'salesforce_login' | 'salesforce_logout' | 'wait_for_lightning'
  | 'assert_profile' | 'assert_object_access' | 'assert_field_access' | 'assert_record_access'
  | 'assert_accessible' | 'assert_screenshot'
  | 'http_request' | 'assert_status' | 'assert_json' | 'assert_header' | 'assert_response_time' | 'mock_route' | 'block_route'
  | 'assert_ai' | 'assert_performance' | 'ai_action' | 'wait_for_code'
  | 'db_query' | 'assert_db' | 'db_execute'
  | 'mock_service_respond' | 'assert_mock_service_called'
  | 'manual';

export interface StepOutcome {
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  healedSelector?: string;
}

export interface StepContext {
  page: Page;
  baseUrl: string;
  stepTimeout: number;
  config: Record<string, any>;
  /** Salesforce persona sessions for this run (when the agent has a salesforce section). */
  salesforce?: SalesforceSessions;
  /** Login profiles of any application (agent config auth), with saved sessions. */
  auth?: AppSessions;
  /** Verification codes from the agent's mailboxes / phone numbers (code sources). */
  codes?: CodeFetcher;
  /** The agent's databases (database steps) */
  db?: DbConnections;
  /** The project's mock APIs (mock_service_respond, assert_mock_service_called) */
  mocks?: ReturnType<typeof import('../mocks/mocks.js')['mockAccess']>;
  /** When the test started: codes sent before are ignored. */
  testStartedAt?: Date;
  /** Persona this test runs as (persona matrix), used when a step names none. */
  persona?: string;
  /** Where quality checks (accessibility, visual) store baselines and report their findings. */
  quality?: QualityContext;
  /** Last API response and variables captured by http_request steps of this test. */
  api?: ApiState;
  /** Data set row of this test execution ({{data.field}}) and its fake values ({{fake.kind}}) */
  testData?: { row?: Record<string, any>; fake: { get(kind: string, label?: string): string; used(): Record<string, string> } };
  /** AI action steps (instruction carried out by the AI). */
  aiActions?: AiActionContext;
  /** AI judge for assert_ai steps (cache shared across the run). */
  ai?: { judge: Judge; outline: (page: Page) => Promise<string>; mask: (text: string) => string; cache: Map<string, Omit<AiVerdict, 'cached'>> };
}

export interface QualityContext {
  projectId: string;
  agentId: string;
  runId: string;
  resultId: string;
  testCaseId: string;
  accessibility: A11yReport[];
  visual: VisualEntry[];
  aiChecks?: AiVerdict[];
  performance?: PerfReport[];
  aiActions?: AiActionRecord[];
}

/** What AI action steps need from the run: the planner, the replay cache and placeholder resolution. */
export interface AiActionContext {
  plan?: Planner;
  cache?: { get(stepId: number, instruction: string): Promise<AiAction[] | null>; save(stepId: number, instruction: string, actions: AiAction[]): Promise<void> };
  /** Resolves {{secrets.X}} and other placeholders in the values the AI chose */
  resolve: (text: string) => string;
}

/** Default text of Salesforce's "no access" pages. */
const ACCESS_DENIED_RE = /insufficient privileges|you don't have access|you do not have access|you don't have permission|you do not have permission|isn't available to you|not authorized|access denied/i;

export function classifyAction(rawAction: string, step: Pick<TestStep, 'target' | 'data'>): StepKind {
  const a = rawAction.toLowerCase().trim().replace(/[_-]+/g, ' ');

  const exact: Record<string, StepKind> = {
    'salesforce login': 'salesforce_login', 'login as': 'salesforce_login', 'log in as': 'salesforce_login',
    'sign in as': 'salesforce_login', 'app login': 'salesforce_login',
    'salesforce logout': 'salesforce_logout',
    'wait for lightning': 'wait_for_lightning',
    'assert profile': 'assert_profile', 'assert object access': 'assert_object_access',
    'assert field access': 'assert_field_access', 'assert record access': 'assert_record_access',
    'assert not visible': 'assert_not_visible', 'assert access denied': 'assert_access_denied',
    'assert accessible': 'assert_accessible', 'assert accessibility': 'assert_accessible', 'check accessibility': 'assert_accessible',
    'accessibility check': 'assert_accessible', 'assert screenshot': 'assert_screenshot', 'compare screenshot': 'assert_screenshot',
    'visual check': 'assert_screenshot', 'assert visual': 'assert_screenshot',
    'http request': 'http_request', 'api request': 'http_request', 'request': 'http_request',
    'assert status': 'assert_status', 'assert json': 'assert_json', 'assert header': 'assert_header',
    'assert response time': 'assert_response_time', 'mock route': 'mock_route', 'mock api': 'mock_route', 'block route': 'block_route',
    'assert ai': 'assert_ai', 'ai assert': 'assert_ai', 'ai check': 'assert_ai', 'assert with ai': 'assert_ai',
    'assert performance': 'assert_performance', 'check performance': 'assert_performance', 'measure performance': 'assert_performance',
    'performance check': 'assert_performance', 'page speed': 'assert_performance', 'assert page speed': 'assert_performance',
    'check page speed': 'assert_performance', 'web vitals': 'assert_performance', 'assert web vitals': 'assert_performance',
    'ai': 'ai_action', 'ai action': 'ai_action', 'ai step': 'ai_action', 'do with ai': 'ai_action',
    'wait for code': 'wait_for_code', 'read code': 'wait_for_code', 'read email code': 'wait_for_code', 'read sms code': 'wait_for_code',
    'get verification code': 'wait_for_code', 'wait for verification code': 'wait_for_code',
    'db query': 'db_query', 'query database': 'db_query', 'query db': 'db_query', 'run query': 'db_query', 'sql query': 'db_query', 'sql': 'db_query',
    'assert db': 'assert_db', 'assert database': 'assert_db', 'check database': 'assert_db', 'verify database': 'assert_db', 'db check': 'assert_db',
    'mock respond': 'mock_service_respond', 'mock service respond': 'mock_service_respond', 'set mock response': 'mock_service_respond',
    'assert mock called': 'assert_mock_service_called', 'assert mock service called': 'assert_mock_service_called', 'verify mock called': 'assert_mock_service_called',
    'db execute': 'db_execute', 'execute sql': 'db_execute', 'run sql': 'db_execute', 'db update': 'db_execute',
  };
  if (exact[a]) return exact[a];
  // "Log in as buyer", "Sign in as the admin user"
  if (/^(log ?in|sign ?in) as\s+\S/.test(a)) return 'salesforce_login';
  // "GET /api/orders", "POST https://…"
  // The method alone with a target, or followed by a path / URL (not "Get started")
  const verb = rawAction.trim().match(/^(get|post|put|patch|delete|head|options)(?:\s+(\S+))?\s*$/i);
  if (verb && (verb[2] ? /^(\/|https?:\/\/|[\w.{}-]+\/)/.test(verb[2]) : !!step.target)) return 'http_request';
  if (/^(send|make|call|invoke)\b.*\b(request|api|endpoint)\b/.test(a)) return 'http_request';
  if (/^(mock|stub|fake)\b/.test(a)) return 'mock_route';
  if (/^(verify|check|assert|confirm|ensure|validate|judge)\s+(with|using|by)\s+(the\s+)?ai\b/.test(a)) return 'assert_ai';
  if (/^(measure|check|test|audit)\b.*\b(performance|page ?speed|web vitals|load(ing)? time)\b/.test(a)) return 'assert_performance';
  // "AI: add the cheapest product to the cart", "Do with AI: …"
  if (/^(ai|ai action|ai step|with ai|using ai|do with (the )?ai)\s*:/.test(a) || /^(do|perform|complete|carry out)\s+(with|using)\s+(the\s+)?ai\b/.test(a)) return 'ai_action';
  if (/^(assert|verify|expect|validate|confirm|ensure|check that|should|observe|see)\b/.test(a)) {
    if (/\b(access denied|insufficient privileges|no access|not authori[sz]ed|forbidden|cannot access|can't access)\b/.test(a)) return 'assert_access_denied';
    if (/\b(status code|http status|response status)\b/.test(a)) return 'assert_status';
    if (/\bresponse time\b|\bresponds? (with)?in\b/.test(a)) return 'assert_response_time';
    if (/\b(response|http) headers?\b/.test(a)) return 'assert_header';
    if (/\bjson\b|\bresponse (body|field|contains)\b/.test(a)) return 'assert_json';
    if (/\b(accessib\w*|a11y|wcag)\b/.test(a)) return 'assert_accessible';
    if (/\b(performance|page ?speed|web vitals|lcp|fcp|cls|ttfb|time to first byte|largest contentful paint|layout shift|blocking time)\b|\bloads? (with)?in (under |less than )?\d|\bload(ing)? time\b/.test(a)) return 'assert_performance';
    if (/\b(visual(ly)?|pixel|baseline|looks the same|screenshot match\w*|matches the screenshot)\b/.test(a)) return 'assert_screenshot';
    if (step.target && /\b(not (be )?(visible|displayed|shown|present)|hidden|absent|isn't (visible|shown|displayed)|is not shown|does not (appear|exist))\b/.test(a)) return 'assert_not_visible';
    if (/\burl\b/.test(a)) return 'assert_url';
    if (/\btitle\b/.test(a)) return 'assert_title';
    if (/\b(visible|displayed|shown|present|appears|exists)\b/.test(a) && step.target) return 'assert_visible';
    if (/\btext\b|\bcontains?\b|\bmessage\b/.test(a)) return 'assert_text';
    return step.target && !stepValue(step) ? 'assert_visible' : 'assert_text';
  }
  if (/^(navigate|go ?to|goto|open|visit|load|browse)\b/.test(a)) return 'navigate';
  if (/^(uncheck|untick|deselect)\b/.test(a)) return 'uncheck';
  if (/^(check|tick)\b/.test(a)) return 'check';
  if (/^(fill|enter|type|input|set|write|provide)\b/.test(a)) return 'fill';
  if (/^(select|choose|pick)\b/.test(a)) return step.target && /select|dropdown|option/.test(a + ' ' + step.target) || stepValue(step) ? 'select' : 'click';
  if (/^press\b/.test(a)) return step.target && !stepValue(step) ? 'click' : 'press';
  if (/^(click|tap|submit|hit|double click)\b/.test(a)) return 'click';
  if (/^(hover|mouse over)\b/.test(a)) return 'hover';
  if (/^(wait|pause|sleep)\b/.test(a)) return 'wait';
  if (/^(screenshot|take (a )?screenshot|capture)\b/.test(a)) return 'screenshot';
  return 'manual';
}

export function stepValue(step: Pick<TestStep, 'data'>): string | undefined {
  const d = step.data;
  if (!d) return undefined;
  const v = d.value ?? d.text ?? d.option ?? d.url ?? d.expected;
  if (v !== undefined && v !== null) return String(v);
  const values = Object.values(d).filter((x) => typeof x === 'string' || typeof x === 'number');
  return values.length === 1 ? String(values[0]) : undefined;
}

/** True when the target already looks like a Playwright/CSS/XPath selector. */
export function looksLikeSelector(target: string): boolean {
  return /^(#|\.|\[|\/\/|xpath=|css=|text=|role=|id=|data-testid=|internal:)/.test(target)
    || /[#.\[\]=>:]/.test(target) && !/\s{2,}/.test(target)
    || /^[a-z]+[0-9]?$/.test(target); // bare tag name like "button" or "h1"
}

/**
 * Resolve a target into a locator. Plain-text targets ("Sign in button",
 * "Username") are matched in priority order — label, placeholder, button,
 * link, then any text — so a heading with the same words never wins over
 * the control the step meant.
 */
export async function resolveLocator(page: Page, target: string): Promise<Locator> {
  if (looksLikeSelector(target)) return page.locator(target).first();
  const name = target.replace(/\b(button|link|field|input|textbox|checkbox|dropdown)\b/gi, '').trim() || target;
  const candidates = [
    page.getByLabel(name, { exact: false }),
    page.getByPlaceholder(name, { exact: false }),
    page.getByRole('button', { name }),
    page.getByRole('link', { name }),
    page.getByText(name, { exact: false }),
  ];
  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) > 0) return candidate.first();
  }
  // Nothing yet (page still rendering): wait on any of them.
  return candidates.reduce((acc, c) => acc.or(c)).first();
}

function absoluteUrl(baseUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  if (!baseUrl) return target;
  return new URL(target, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function waitFor<T>(fn: () => Promise<T> | T, check: (v: T) => boolean, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  let last = await fn();
  while (!check(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    last = await fn();
  }
  return last;
}

export async function executeStep(step: TestStep, ctx: StepContext, targetOverride?: string): Promise<StepOutcome> {
  const { page, stepTimeout } = ctx;
  const kind = classifyAction(step.action, step);
  const target = (targetOverride ?? step.target ?? '').trim();
  const value = stepValue(step);
  const need = (what: string) => { throw new Error(`"${step.action}" needs ${what}`); };

  switch (kind) {
    case 'navigate': {
      const url = absoluteUrl(ctx.baseUrl, target || value || '/');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(stepTimeout, 30000) });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => undefined);
      return { status: 'passed', message: `Opened ${url}${response ? ` (HTTP ${response.status()})` : ''}` };
    }
    case 'click': {
      if (!target) need('a target');
      await (await resolveLocator(page, target)).click({ timeout: stepTimeout });
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      return { status: 'passed', message: `Clicked ${target}` };
    }
    case 'fill': {
      if (!target) need('a target');
      if (value === undefined) need('data.value');
      await (await resolveLocator(page, target)).fill(value!, { timeout: stepTimeout });
      const shown = /password|secret|token/i.test(target) ? '••••' : `"${value}"`;
      return { status: 'passed', message: `Filled ${target} with ${shown}` };
    }
    case 'select': {
      if (!target) need('a target');
      if (value === undefined) need('data.value');
      const locator = (await resolveLocator(page, target));
      try {
        await locator.selectOption({ label: value! }, { timeout: stepTimeout });
      } catch {
        await locator.selectOption(value!, { timeout: stepTimeout });
      }
      return { status: 'passed', message: `Selected "${value}" in ${target}` };
    }
    case 'check':
    case 'uncheck': {
      if (!target) need('a target');
      const locator = (await resolveLocator(page, target));
      if (kind === 'check') await locator.check({ timeout: stepTimeout });
      else await locator.uncheck({ timeout: stepTimeout });
      return { status: 'passed', message: `${kind === 'check' ? 'Checked' : 'Unchecked'} ${target}` };
    }
    case 'press': {
      const key = value || 'Enter';
      if (target) await (await resolveLocator(page, target)).press(key, { timeout: stepTimeout });
      else await page.keyboard.press(key);
      return { status: 'passed', message: `Pressed ${key}` };
    }
    case 'hover': {
      if (!target) need('a target');
      await (await resolveLocator(page, target)).hover({ timeout: stepTimeout });
      return { status: 'passed', message: `Hovered ${target}` };
    }
    case 'wait': {
      const ms = Number(step.data?.ms ?? step.data?.milliseconds ?? (target && /^\d+$/.test(target) ? target : NaN));
      if (!Number.isNaN(ms)) {
        await page.waitForTimeout(Math.min(ms, 30000));
        return { status: 'passed', message: `Waited ${ms}ms` };
      }
      if (target) {
        await (await resolveLocator(page, target)).waitFor({ state: 'visible', timeout: stepTimeout });
        return { status: 'passed', message: `${target} is visible` };
      }
      await page.waitForLoadState('networkidle', { timeout: stepTimeout }).catch(() => undefined);
      return { status: 'passed', message: 'Page settled' };
    }
    case 'assert_visible': {
      if (!target) need('a target');
      await (await resolveLocator(page, target)).waitFor({ state: 'visible', timeout: stepTimeout });
      return { status: 'passed', message: `${target} is visible` };
    }
    case 'assert_text': {
      const expected = value ?? step.expectedResult;
      if (!expected) need('data.value with the expected text');
      if (target) {
        const locator = (await resolveLocator(page, target));
        await locator.waitFor({ state: 'attached', timeout: stepTimeout });
        const text = await waitFor(() => locator.innerText().catch(() => ''), (t) => t.includes(expected!), stepTimeout);
        if (!text.includes(expected!)) throw new Error(`Expected ${target} to contain "${expected}" but found "${text.slice(0, 200)}"`);
      } else {
        const text = await waitFor(() => page.locator('body').innerText().catch(() => ''), (t) => t.includes(expected!), stepTimeout);
        if (!text.includes(expected!)) throw new Error(`Expected the page to contain "${expected}"`);
      }
      return { status: 'passed', message: `Found text "${expected}"` };
    }
    case 'assert_url': {
      const expected = value ?? target;
      if (!expected) need('data.value with the expected URL fragment');
      const url = await waitFor(() => page.url(), (u) => u.includes(expected!), stepTimeout);
      if (!url.includes(expected!)) throw new Error(`Expected URL to contain "${expected}" but was ${url}`);
      return { status: 'passed', message: `URL contains "${expected}"` };
    }
    case 'assert_title': {
      const expected = value ?? target;
      if (!expected) need('data.value with the expected title');
      const title = await waitFor(() => page.title(), (t) => t.includes(expected!), stepTimeout);
      if (!title.includes(expected!)) throw new Error(`Expected title to contain "${expected}" but was "${title}"`);
      return { status: 'passed', message: `Title contains "${expected}"` };
    }
    case 'screenshot':
      return { status: 'passed', message: 'Screenshot captured' };
    case 'assert_not_visible': {
      if (!target) need('a target');
      const locator = looksLikeSelector(target) ? page.locator(target) : await resolveLocator(page, target);
      const visible = await waitFor(() => locator.first().isVisible().catch(() => false), (v) => !v, Math.min(stepTimeout, 5000));
      if (visible) throw new Error(`Expected ${target} not to be visible, but it is`);
      return { status: 'passed', message: `${target} is not visible` };
    }
    case 'assert_access_denied': {
      if (target) await page.goto(absoluteUrl(ctx.baseUrl, target), { waitUntil: 'domcontentloaded', timeout: Math.max(stepTimeout, 30000) });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => undefined);
      const pattern = value ? new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : ACCESS_DENIED_RE;
      const text = await waitFor(() => page.locator('body').innerText().catch(() => ''), (t) => pattern.test(t), stepTimeout);
      if (!pattern.test(text)) throw new Error(`Expected access to be denied${target ? ` for ${target}` : ''}, but the page shows no access-denied message (${page.url()})`);
      return { status: 'passed', message: `Access denied${target ? ` to ${target}` : ''} as expected` };
    }
    case 'assert_accessible': {
      const data = step.data ?? {};
      const report = await scanAccessibility(page, {
        level: data.level,
        minImpact: data.min_impact ?? data.minImpact,
        ignore: data.ignore,
        exclude: data.exclude,
        include: target ? [target] : data.include,
      });
      ctx.quality?.accessibility.push(report);
      if (report.failing > 0 && data.report_only !== true) throw new Error(describeA11y(report));
      return { status: 'passed', message: describeA11y(report) };
    }
    case 'assert_screenshot': {
      if (!ctx.quality) throw new Error('Visual checks need a run context');
      const data = step.data ?? {};
      const locator = target ? await resolveLocator(page, target) : null;
      const name = String(data.name ?? `${ctx.quality.testCaseId}#${step.stepId}`).slice(0, 200);
      const entry = await checkScreenshot(page, locator, name, {
        projectId: ctx.quality.projectId,
        agentId: ctx.quality.agentId,
        runId: ctx.quality.runId,
        resultId: ctx.quality.resultId,
        persona: ctx.persona,
        index: ctx.quality.visual.length + 1,
      }, data);
      ctx.quality.visual.push(entry);
      if (entry.status === 'failed') throw new Error(describeVisual(entry));
      return { status: 'passed', message: describeVisual(entry) };
    }
    case 'http_request': {
      if (!ctx.api) throw new Error('API steps need a run context');
      const data = { ...(step.data ?? {}) };
      const first = step.action.trim().split(/\s+/);
      if (!data.method && /^(get|post|put|patch|delete|head|options)$/i.test(first[0])) data.method = first[0];
      const url = target || (first.length > 1 ? first.slice(1).join(' ') : '') || String(data.url ?? '');
      if (!url) need('the URL or path as target');
      const response = await sendRequest(page, ctx.config, url, data, stepTimeout);
      ctx.api.last = response;
      const extracted = extractVars(response, data.extract, ctx.api.vars);
      // Expected status given on the request itself
      if (data.status !== undefined && !statusMatches(response.status, data.status)) {
        throw new Error(`Expected status ${JSON.stringify(data.status)} but got ${describeResponse(response)}`);
      }
      return { status: 'passed', message: `${describeResponse(response)}${extracted.length ? ` · saved ${extracted.map((n) => `{{vars.${n}}}`).join(', ')}` : ''}` };
    }
    case 'assert_status': {
      const r = lastResponse(ctx);
      // "Verify the status code is 201" carries the expectation in the sentence
      const expected = step.data?.status ?? step.data?.value ?? (target || step.action.match(/\b([1-5]\d\d|[1-5]xx)\b/i)?.[1]);
      if (expected === undefined || expected === '') need('the expected status in data.value, e.g. 200 or "2xx"');
      if (!statusMatches(r.status, expected)) throw new Error(`Expected status ${JSON.stringify(expected)} but got ${r.status} (${r.method} ${r.url})`);
      return { status: 'passed', message: `Status ${r.status}` };
    }
    case 'assert_json': {
      const r = lastResponse(ctx);
      return { status: 'passed', message: checkJson(r.json, { ...(target && !step.data?.path ? { path: target } : {}), ...(step.data ?? {}) }) };
    }
    case 'assert_header': {
      const r = lastResponse(ctx);
      const name = String(target || step.data?.name || '').toLowerCase();
      if (!name) need('the header name as target');
      const actual = r.headers[name];
      if (actual === undefined) throw new Error(`The response has no "${name}" header`);
      const expected = step.data?.value ?? step.data?.contains;
      if (expected !== undefined && !actual.toLowerCase().includes(String(expected).toLowerCase())) {
        throw new Error(`Expected header ${name} to contain "${expected}" but it is "${actual}"`);
      }
      return { status: 'passed', message: `${name}: ${actual.slice(0, 120)}` };
    }
    case 'assert_response_time': {
      const r = lastResponse(ctx);
      const max = Number(step.data?.max_ms ?? step.data?.value ?? (target || step.action.match(/(\d+)\s*ms\b/i)?.[1]));
      if (!Number.isFinite(max) || max <= 0) need('the maximum in milliseconds in data.value');
      if (r.durationMs > max) throw new Error(`Response took ${r.durationMs} ms, more than ${max} ms (${r.method} ${r.url})`);
      return { status: 'passed', message: `Responded in ${r.durationMs} ms (max ${max} ms)` };
    }
    case 'mock_route':
    case 'block_route':
      return { status: 'passed', message: await mockRoute(page, target || String(step.data?.url ?? ''), step.data ?? {}, kind === 'block_route') };
    case 'assert_ai': {
      if (!ctx.ai) throw new Error('AI checks need a run context');
      const data = step.data ?? {};
      // The expectation: data.value, else the sentence after "Verify with AI that …", else the expected result
      const fromAction = step.action.replace(/^\s*(verify|check|assert|confirm|ensure|validate|judge)\s+(with|using|by)\s+(the\s+)?ai\s*(that|whether|if)?\s*/i, '').trim();
      const expectation = String(data.value ?? data.expect ?? (fromAction && fromAction !== step.action.trim() ? fromAction : '') ?? '').trim()
        || String(step.expectedResult ?? '').trim();
      if (!expectation || /^assert[_ ]ai$/i.test(expectation)) need('the expectation in plain language in data.value');
      const locator = target ? await resolveLocator(page, target) : null;
      const minConfidence = data.min_confidence ?? data.minConfidence;
      const verdict = await judgeExpectation(page, locator, expectation, {
        ...ctx.ai, minConfidence, onUnsure: data.on_unsure ?? data.onUnsure,
      });
      ctx.quality?.aiChecks?.push(verdict);
      const message = describeVerdict(verdict, Number(minConfidence ?? 0.7));
      if (!verdict.passed) throw new Error(message);
      return { status: 'passed', message };
    }
    case 'assert_performance': {
      const data = step.data ?? {};
      // A target loads that page fresh first; otherwise the last page load is measured
      if (target) {
        await page.goto(absoluteUrl(ctx.baseUrl, target), { waitUntil: 'load', timeout: Math.max(stepTimeout, 30000) });
      }
      const agent = performanceSettings(ctx.config);
      const own = { ...normalizeBudgets(data), ...budgetFromSentence(step.action) };
      const budgets = Object.keys(own).length ? own : agent.mode !== 'off' || ctx.config?.checks?.performance_budgets ? agent.budgets : { ...DEFAULT_BUDGETS };
      const maxRegression = Number(data.max_regression ?? agent.maxRegression);
      const report = await checkPerformance(page, {
        budgets,
        ...(Number.isFinite(maxRegression) && maxRegression > 0 ? { maxRegression } : {}),
        throttle: agent.throttle,
        agentId: ctx.quality?.agentId,
        runId: ctx.quality?.runId,
      });
      ctx.quality?.performance?.push(report);
      const message = describePerformance(report);
      if (!report.passed && data.report_only !== true) throw new Error(message);
      return { status: 'passed', message };
    }
    case 'ai_action': {
      const ai = ctx.aiActions;
      if (!ai) throw new Error('AI action steps need a run context');
      const data = step.data ?? {};
      const fromAction = step.action.replace(/^\s*(ai|ai[ _]action|ai[ _]step|with ai|using ai|do with (the )?ai)\s*:\s*/i, '')
        .replace(/^\s*(do|perform|complete|carry out)\s+(with|using)\s+(the\s+)?ai\s*:?\s*/i, '').trim();
      const instruction = String(data.value ?? data.instruction ?? (fromAction && fromAction !== step.action.trim() ? fromAction : '')).trim();
      if (!instruction) need('the instruction in data.value, or written as "AI: …"');
      const useCache = data.cache !== false && ctx.config?.ai?.action_cache !== false && !!ai.cache;
      const cached = useCache ? await ai.cache!.get(step.stepId, instruction).catch(() => null) : null;
      const inner: StepContext = { ...ctx, aiActions: undefined };
      const execute = async (a: AiAction) => {
        const v = a.value !== undefined ? ai.resolve(a.value) : undefined;
        const sub: TestStep = {
          stepId: step.stepId,
          action: a.action,
          ...(a.target ? { target: ai.resolve(a.target) } : {}),
          ...(v !== undefined ? { data: a.action === 'wait' ? { ms: v } : { value: v } } : {}),
        };
        await executeStep(sub, inner);
      };
      let record: AiActionRecord;
      try {
        record = await runAiAction(page, instruction, {
          stepId: step.stepId, baseUrl: ctx.baseUrl, plan: ai.plan, outline: ctx.ai?.outline ?? (async () => ''), mask: ctx.ai?.mask ?? ((t) => t),
          execute, cached, maxActions: data.max_actions,
        });
      } catch (e: any) {
        if (e instanceof AiActionError) ctx.quality?.aiActions?.push(e.record);
        throw e;
      }
      if (useCache && !record.replayed) {
        await ai.cache!.save(step.stepId, instruction, successfulActions(record)).then(() => { record.cacheSaved = true; }).catch(() => undefined);
      }
      ctx.quality?.aiActions?.push(record);
      const how = record.replayed ? 'replayed from earlier runs, no AI call' : `${record.rounds} AI round(s)${record.provider ? `, ${record.provider}` : ''}`;
      return { status: 'passed', message: `AI did "${instruction}" (${how}): ${describeActions(record.actions) || 'nothing to do'}` };
    }
    case 'db_query':
    case 'assert_db':
    case 'db_execute': {
      if (!ctx.db) throw new Error('Database steps need a run context');
      const sql = String(step.data?.sql ?? step.data?.query ?? value ?? '').trim();
      const params = Array.isArray(step.data?.params) ? step.data!.params : [];
      const r = await ctx.db.query(target || undefined, sql, params, { write: kind === 'db_execute' });
      const preview = r.rows.length ? ` First row: ${JSON.stringify(r.rows[0], (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 300)}` : '';
      if (kind === 'db_execute') return { status: 'passed', message: `${r.database}: ${r.rowCount} row(s) affected` };
      // Keep values for later steps: save_as = first column of the first row, extract = { var: column }
      if (ctx.api && r.rows[0]) {
        const first = r.rows[0];
        const pick = (col: string) => {
          const key = Object.keys(first).find((k) => k.toLowerCase() === col.toLowerCase());
          if (key === undefined) throw new Error(`No column "${col}" in the result (columns: ${Object.keys(first).join(', ')})`);
          return cellText(first[key]);
        };
        if (step.data?.save_as) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(step.data.save_as))) throw new Error('data.save_as must be a variable name');
          ctx.api.vars[String(step.data.save_as)] = cellText(Object.values(first)[0]);
        }
        for (const [name, col] of Object.entries(step.data?.extract ?? {})) ctx.api.vars[name] = pick(String(col));
      } else if (step.data?.save_as || step.data?.extract) {
        throw new Error(`The query returned no rows, so there is nothing to keep in ${step.data?.save_as ? `{{vars.${step.data.save_as}}}` : 'variables'}`);
      }
      if (kind === 'assert_db') {
        const expect = { rows: step.data?.rows, equals: step.data?.equals, contains: step.data?.contains, empty: step.data?.empty };
        if (expect.rows === undefined && !expect.equals && expect.contains === undefined && expect.empty === undefined) expect.empty = false;
        const problems = checkResult(r, expect);
        if (problems.length) throw new Error(`Database ${r.database}: ${problems.join('; ')}`);
        return { status: 'passed', message: `${r.database}: ${r.rowCount} row(s) as expected.${preview}` };
      }
      return { status: 'passed', message: `${r.database}: ${r.rowCount} row(s).${preview}` };
    }
    case 'mock_service_respond': {
      if (!ctx.mocks) throw new Error('Mock steps need a run context');
      const d = step.data ?? {};
      if (!d.path || !String(d.path).startsWith('/')) need('data.path (e.g. /payments)');
      const s = await ctx.mocks.respond(target || undefined, { method: String(d.method ?? '*').toUpperCase(), path: String(d.path), status: Number(d.status ?? 200), body: d.body, headers: d.headers, delay_ms: d.delay_ms, times: d.times });
      return { status: 'passed', message: `${s.name}: the next ${d.times ?? 1} ${String(d.method ?? 'request').toUpperCase()} ${d.path} answer${(d.times ?? 1) > 1 ? '' : 's'} ${d.status ?? 200}` };
    }
    case 'assert_mock_service_called': {
      if (!ctx.mocks) throw new Error('Mock steps need a run context');
      const d = step.data ?? {};
      const { service, calls } = await ctx.mocks.calls(target || undefined, ctx.testStartedAt);
      const { pathRegex } = await import('../mocks/mocks.js');
      const matching = calls.filter((c) => (!d.method || c.method === String(d.method).toUpperCase()) && (!d.path || pathRegex(String(d.path)).test(c.path))
        && (d.body_contains === undefined || JSON.stringify(c.body ?? '').includes(String(d.body_contains))));
      const what = `${d.method ? String(d.method).toUpperCase() : 'any'} ${d.path ?? '*'}${d.body_contains !== undefined ? ` containing "${d.body_contains}"` : ''}`;
      if (d.times !== undefined ? matching.length !== Number(d.times) : matching.length === 0) {
        const seen = calls.slice(-5).map((c) => `${c.method} ${c.path}`).join(', ') || 'none';
        throw new Error(`${service.name}: expected ${d.times !== undefined ? `${d.times} call(s)` : 'a call'} ${what} during this test, got ${matching.length} (latest calls: ${seen})`);
      }
      return { status: 'passed', message: `${service.name}: ${matching.length} call(s) ${what}` };
    }
    case 'wait_for_code': {
      if (!ctx.codes) throw new Error('This agent has no code sources (Agent → Sign-in & MFA → mailboxes and phone numbers)');
      const source = String(step.data?.source ?? target ?? '').trim();
      if (!source) need('the code source (target), e.g. qa_inbox');
      const saveAs = String(step.data?.save_as ?? 'code');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(saveAs)) throw new Error('data.save_as must be a variable name');
      const timeoutS = Math.min(Math.max(Number(step.data?.timeout_s) || 90, 5), 600);
      const { message } = await ctx.codes(source, { since: ctx.testStartedAt ?? new Date(Date.now() - 120_000), to: step.data?.to, timeoutMs: timeoutS * 1000 })
        .then((r) => {
          if (ctx.api) ctx.api.vars[saveAs] = r.code;
          return r;
        });
      if (!ctx.api) throw new Error('Codes need a run context');
      return { status: 'passed', message: `Code received ${message.subject ? `by email ("${message.subject}")` : 'by SMS'} at ${message.at.toISOString().slice(11, 19)} UTC: use {{vars.${saveAs}}}` };
    }
    case 'salesforce_login': {
      const named = step.action.match(/^\s*(?:log ?in|sign ?in) as\s+(?:the\s+)?([A-Za-z0-9][\w.-]*)/i)?.[1];
      const persona = step.data?.persona ?? step.data?.profile ?? (target && !/^(https?:|\/)/.test(target) ? target : undefined) ?? named ?? ctx.persona;
      // "Log in as X" also signs in login profiles of other applications
      const sfHas = !!ctx.salesforce && ctx.salesforce.settings.personas.some((p) => p.name.toLowerCase() === String(persona ?? ctx.salesforce!.settings.defaultPersona ?? '').toLowerCase());
      if (ctx.auth && !sfHas && (persona ? ctx.auth.settings.profiles.some((p) => p.name.toLowerCase() === String(persona).toLowerCase()) : !ctx.salesforce)) {
        const r = await ctx.auth.login(page, persona, { fresh: step.data?.fresh === true, landing: step.data?.landing ?? step.data?.url ?? (target && /^\//.test(target) ? target : undefined) });
        return { status: 'passed', message: r.message };
      }
      const sessions = requireSalesforce(ctx);
      const landing = step.data?.landing ?? step.data?.url ?? (target && /^\//.test(target) ? target : undefined);
      const result = await sessions.login(page, persona, { landing, fresh: step.data?.fresh === true });
      if (step.data?.verify_identity !== false && (result.persona.expected_profile || result.persona.expected_permission_sets?.length)) {
        const identity = await sessions.identity(page, result.persona.name);
        const problems = SalesforceSessions.identityMismatches(result.persona, identity);
        if (problems.length) throw new Error(`Persona "${result.persona.name}" is misconfigured in Salesforce: ${problems.join('; ')}`);
        return { status: 'passed', message: `${result.message}; identity verified (${identity.profile})` };
      }
      return { status: 'passed', message: result.message };
    }
    case 'salesforce_logout': {
      await requireSalesforce(ctx).logout(page);
      return { status: 'passed', message: 'Logged out of Salesforce' };
    }
    case 'assert_profile': {
      const sessions = requireSalesforce(ctx);
      const persona = step.data?.persona ?? sessions.currentPersona(page) ?? ctx.persona;
      const identity = await sessions.identity(page, persona);
      const expectedProfile = step.data?.profile ?? (target || undefined);
      if (expectedProfile && identity.profile?.toLowerCase() !== String(expectedProfile).toLowerCase()) {
        throw new Error(`Expected profile "${expectedProfile}" but ${identity.username} has "${identity.profile}"`);
      }
      const sets = toList(step.data?.permission_sets ?? step.data?.permission_set);
      const missing = sets.filter((s) => !identity.permissionSets.some((x) => x.toLowerCase() === s.toLowerCase()));
      if (missing.length) throw new Error(`${identity.username} is missing permission set(s): ${missing.join(', ')} (has: ${identity.permissionSets.join(', ') || 'none'})`);
      const absent = toList(step.data?.not_permission_sets).filter((s) => identity.permissionSets.some((x) => x.toLowerCase() === s.toLowerCase()));
      if (absent.length) throw new Error(`${identity.username} must not have permission set(s): ${absent.join(', ')}`);
      return { status: 'passed', message: `${identity.username}: profile ${identity.profile}${identity.permissionSets.length ? `, permission sets ${identity.permissionSets.join(', ')}` : ''}` };
    }
    case 'assert_object_access':
    case 'assert_field_access':
    case 'assert_record_access': {
      const sessions = requireSalesforce(ctx);
      const subject = step.data?.object ?? step.data?.field ?? step.data?.record_id ?? target;
      if (!subject) need(kind === 'assert_object_access' ? 'the object API name as target' : kind === 'assert_field_access' ? 'Object.Field as target' : 'the record Id as target');
      const persona = step.data?.persona ?? sessions.currentPersona(page) ?? ctx.persona;
      let actual: Record<string, any>;
      if (kind === 'assert_object_access') actual = await sessions.objectAccess(page, persona, subject);
      else if (kind === 'assert_field_access') {
        const [object, field] = String(subject).split('.');
        if (!object || !field) need('target in the form Object.Field');
        actual = await sessions.fieldAccess(page, persona, object, field);
      } else actual = await sessions.recordAccess(page, persona, subject);
      return { status: 'passed', message: compareAccess(subject, actual, step.data ?? {}, persona) };
    }
    case 'wait_for_lightning': {
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
      await page.locator('.slds-spinner_container').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => undefined);
      return { status: 'passed', message: 'Lightning page ready' };
    }
    case 'manual':
    default:
      return { status: 'skipped', message: `Not automatable (no recognised action): "${step.action}"` };
  }
}

function lastResponse(ctx: StepContext) {
  if (!ctx.api?.last) throw new Error('No API response yet: send one with an http_request step first');
  return ctx.api.last;
}

function requireSalesforce(ctx: StepContext): SalesforceSessions {
  if (!ctx.salesforce) throw new Error('This agent has no Salesforce configuration or login profile for that name (Agent → Sign-in & MFA)');
  return ctx.salesforce;
}

function toList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['true', 'yes', 'y', '1', 'allowed', 'granted'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'denied', 'none'].includes(s)) return false;
  throw new Error(`Expected true/false but got "${v}"`);
}

/** Compare expected permissions (only the keys given) with actual ones; throws on mismatch. */
export function compareAccess(subject: string, actual: Record<string, any>, expected: Record<string, any>, persona?: string): string {
  const keys = ['read', 'create', 'edit', 'delete'].filter((k) => k in actual && toBool(expected[k]) !== undefined);
  if (keys.length === 0) throw new Error('Give the expected access in data, e.g. {"read": true, "edit": false}');
  const wrong = keys.filter((k) => toBool(expected[k]) !== !!actual[k]);
  const who = persona ? ` for ${persona}` : '';
  const describe = (k: string) => `${k}=${actual[k] ? 'yes' : 'no'}`;
  if (wrong.length) {
    throw new Error(`Unexpected access to ${subject}${who}: ${wrong.map((k) => `${k} is ${actual[k] ? 'allowed' : 'denied'} (expected ${toBool(expected[k]) ? 'allowed' : 'denied'})`).join(', ')}`);
  }
  return `Access to ${subject}${who} as expected (${keys.map(describe).join(', ')}${actual.via === 'admin' ? ', checked via admin API' : ''})`;
}

/** Whether a failure looks like a selector problem that self-healing could fix. */
export function isSelectorFailure(kind: StepKind, error: string): boolean {
  if (!['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'assert_visible', 'wait', 'press', 'assert_text'].includes(kind)) return false;
  return /timeout|waiting for|locator|selector|strict mode|not visible|resolved to/i.test(error);
}
