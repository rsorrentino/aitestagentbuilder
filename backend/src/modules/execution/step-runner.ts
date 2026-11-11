/**
 * Step Runner — executes one test step on a Playwright page.
 *
 * Accepts both the canonical actions (navigate, click, fill, assert_text, …)
 * and the natural-language phrasing produced by document extraction
 * ("Click the login button", "Verify the dashboard is shown").
 */

import type { Locator, Page } from 'playwright';
import { TestStep } from '../../core/domain/test-case.js';

export type StepKind =
  | 'navigate' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover' | 'wait'
  | 'assert_visible' | 'assert_text' | 'assert_url' | 'assert_title' | 'screenshot'
  | 'salesforce_login' | 'wait_for_lightning' | 'manual';

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
}

export function classifyAction(rawAction: string, step: Pick<TestStep, 'target' | 'data'>): StepKind {
  const a = rawAction.toLowerCase().trim().replace(/[_-]+/g, ' ');

  if (a === 'salesforce login') return 'salesforce_login';
  if (a === 'wait for lightning') return 'wait_for_lightning';
  if (/^(assert|verify|expect|validate|confirm|ensure|check that|should|observe|see)\b/.test(a)) {
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
    case 'salesforce_login': {
      const sf = ctx.config.salesforce ?? {};
      const username = step.data?.username ?? sf.username;
      const password = step.data?.password ?? sf.password;
      if (!username || !password) throw new Error('Salesforce username/password are not configured on this agent');
      await page.goto(absoluteUrl(ctx.baseUrl, target || '/'), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('#username').fill(username, { timeout: stepTimeout });
      await page.locator('#password').fill(password, { timeout: stepTimeout });
      await page.locator('#Login').click({ timeout: stepTimeout });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
      if (/login|verify/i.test(new URL(page.url()).pathname) && (await page.locator('#error').count()) > 0) {
        throw new Error(`Salesforce login failed: ${(await page.locator('#error').innerText()).trim()}`);
      }
      return { status: 'passed', message: `Logged in to Salesforce as ${username}` };
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

/** Whether a failure looks like a selector problem that self-healing could fix. */
export function isSelectorFailure(kind: StepKind, error: string): boolean {
  if (!['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'assert_visible', 'wait', 'press', 'assert_text'].includes(kind)) return false;
  return /timeout|waiting for|locator|selector|strict mode|not visible|resolved to/i.test(error);
}
