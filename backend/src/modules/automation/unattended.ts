/**
 * Unattended runs: what makes a nightly / scheduled / CI run trustworthy
 * without a person watching it.
 *
 * agent.config.unattended:
 *   preflight              true    check before running that the application (and Salesforce login) answers;
 *                                  when it does not, wait and retry, then fail the run once with the reason
 *                                  instead of failing every test
 *   preflight_retries      3       attempts after the first one
 *   preflight_wait_seconds 300     wait between attempts
 *   rerun_failed           auto    re-run failed tests once at the end, in a fresh browser
 *                                  (auto = for runs not started by a person in the UI)
 *   max_run_minutes        240     stop a run that takes longer (hung application, endless waits)
 *   resume_interrupted     true    a scheduled / CI run interrupted by a server restart is started again
 */

import logger from '../../infra/logger/index.js';
import type { TestCase } from '../../core/domain/test-case.js';
import { getLLMRouter } from '../../infra/llm/router.js';
import { classifyAction } from '../execution/step-runner.js';

/** Runs that nobody watches (anything not started by a person in the UI). */
export const isUnattended = (triggeredBy?: string) => !!triggeredBy && triggeredBy !== 'user';

export interface UnattendedSettings {
  preflight: boolean;
  retries: number;
  waitMs: number;
  rerunFailed: boolean;
  maxRunMinutes: number;
  resumeInterrupted: boolean;
}

export function unattendedSettings(config: any, triggeredBy?: string): UnattendedSettings {
  const u = config?.unattended ?? {};
  const num = (v: any, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
  };
  const rerun = u.rerun_failed;
  return {
    preflight: u.preflight !== false,
    retries: Math.round(num(u.preflight_retries, 3, 0, 20)),
    waitMs: Math.round(num(u.preflight_wait_seconds, 300, 1, 3600) * 1000),
    rerunFailed: rerun === true || ((rerun === undefined || rerun === 'auto') && isUnattended(triggeredBy)),
    maxRunMinutes: num(u.max_run_minutes, 240, 0.05, 24 * 60),
    resumeInterrupted: u.resume_interrupted !== false,
  };
}

export function validateUnattended(u: any): string[] {
  if (u === undefined || u === null) return [];
  if (typeof u !== 'object' || Array.isArray(u)) return ['config.unattended must be an object'];
  const errors: string[] = [];
  for (const k of ['preflight_retries', 'preflight_wait_seconds', 'max_run_minutes']) {
    if (u[k] !== undefined && !(Number(u[k]) >= 0)) errors.push(`config.unattended.${k} must be a number`);
  }
  if (u.rerun_failed !== undefined && ![true, false, 'auto'].includes(u.rerun_failed)) errors.push('config.unattended.rerun_failed must be true, false or "auto"');
  return errors;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed blocking check stops the run (retried first) */
  blocking: boolean;
}

export interface PreflightResult {
  ok: boolean;
  attempts: number;
  checks: PreflightCheck[];
  at: string;
}

/** Does the URL answer? Any HTTP answer below 500 counts (a login page or 401 is fine). */
async function reachable(url: string): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'ai-test-agent-builder (pre-flight)' } });
    await res.body?.cancel().catch(() => undefined);
    const ms = Date.now() - started;
    return res.status < 500
      ? { ok: true, detail: `HTTP ${res.status} in ${ms} ms` }
      : { ok: false, detail: `HTTP ${res.status} (server error)` };
  } catch (e: any) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? '';
    return { ok: false, detail: `no answer (${[e?.message, cause].filter(Boolean).join(': ')})` };
  }
}

const usesAi = (tests: TestCase[]) => tests.some((tc) => (tc.steps ?? []).some((s) => ['ai_action', 'assert_ai'].includes(classifyAction(s.action, s))));

/** One round of checks. */
export async function preflightChecks(config: any, tests: TestCase[]): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const app = await reachable(config.base_url);
  checks.push({ name: 'application', ok: app.ok, detail: `${config.base_url}: ${app.detail}`, blocking: true });
  const sfLogin = config.salesforce?.login_url;
  if (sfLogin && sfLogin !== config.base_url) {
    const sf = await reachable(String(sfLogin).includes('://') ? sfLogin : `https://${sfLogin}`);
    checks.push({ name: 'salesforce login', ok: sf.ok, detail: `${sfLogin}: ${sf.detail}`, blocking: true });
  }
  if (usesAi(tests)) {
    const ok = getLLMRouter().hasAnyProvider();
    checks.push({ name: 'ai provider', ok, detail: ok ? 'configured' : 'no AI provider configured: AI action / AI check steps will fail', blocking: false });
  }
  return checks;
}

/**
 * Checks with retries: a blocking failure is retried `retries` times, `waitMs` apart
 * (applications that restart at night, a deploy in progress). `cancelled` stops the wait.
 */
export async function runPreflight(config: any, tests: TestCase[], s: UnattendedSettings, opts: { cancelled?: () => boolean; onRetry?: (checks: PreflightCheck[], attempt: number) => void } = {}): Promise<PreflightResult> {
  let checks: PreflightCheck[] = [];
  let attempt = 0;
  for (;;) {
    attempt++;
    checks = await preflightChecks(config, tests);
    const blocked = checks.some((c) => c.blocking && !c.ok);
    if (!blocked || attempt > s.retries || opts.cancelled?.()) break;
    opts.onRetry?.(checks, attempt);
    logger.warn('Pre-flight failed, retrying', { attempt, checks: checks.filter((c) => !c.ok).map((c) => c.detail) });
    const until = Date.now() + s.waitMs;
    while (Date.now() < until && !opts.cancelled?.()) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
    if (opts.cancelled?.()) break;
  }
  return { ok: !checks.some((c) => c.blocking && !c.ok), attempts: attempt, checks, at: new Date().toISOString() };
}

export function describePreflight(p: PreflightResult): string {
  const failed = p.checks.filter((c) => c.blocking && !c.ok);
  return failed.length
    ? `Pre-flight failed after ${p.attempts} attempt(s): ${failed.map((c) => `${c.name} — ${c.detail}`).join('; ')}. No tests were run`
    : `Pre-flight passed: ${p.checks.map((c) => `${c.name} ${c.ok ? 'ok' : `warning (${c.detail})`}`).join(', ')}`;
}
