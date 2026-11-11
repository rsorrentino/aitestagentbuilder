/**
 * Page speed: lab metrics of the page a test is on, checked against budgets
 * and against the same page in earlier runs (regressions).
 *
 *   { "action": "assert_performance", "target": "/products" (optional: load it fresh),
 *     "data": { "lcp": 2500, "cls": 0.1, "tbt": 200, "load": 3000, "transfer_kb": 1500,
 *               "max_regression": 0.25, "report_only": false } }
 *
 * Metrics come from the browser's own timing APIs (Navigation / Paint / Largest
 * Contentful Paint / Layout Shift / Long Tasks), for the last full page load:
 * ttfb, fcp, lcp, cls, tbt (sum of long-task time over 50 ms), dom_content_loaded,
 * load, transfer_kb and requests. They are lab values from the test machine, so
 * set budgets with headroom, and use throttling to approximate slower devices:
 *
 *   agent config  checks: { performance: report | fail, performance_budgets: {...},
 *                           performance_options: { throttle: slow4g | fast3g, cpu_slowdown: 4 } }
 */

import type { BrowserContext, Page } from 'playwright';
import getDatabaseClient from '../../infra/db/client.js';

export const METRICS = ['ttfb', 'fcp', 'lcp', 'cls', 'tbt', 'dom_content_loaded', 'load', 'transfer_kb', 'requests'] as const;
export type Metric = typeof METRICS[number];
export type Metrics = Partial<Record<Metric, number>>;

export const METRIC_LABELS: Record<Metric, string> = {
  ttfb: 'Time to first byte', fcp: 'First contentful paint', lcp: 'Largest contentful paint', cls: 'Cumulative layout shift',
  tbt: 'Total blocking time', dom_content_loaded: 'DOM content loaded', load: 'Load', transfer_kb: 'Transferred', requests: 'Requests',
};

/** "Good" Core Web Vitals / Lighthouse lab thresholds: the default budgets of assert_performance. */
export const DEFAULT_BUDGETS: Metrics = { ttfb: 800, fcp: 1800, lcp: 2500, cls: 0.1, tbt: 200 };

/** Minimum absolute worsening before a relative regression counts (measurements are noisy). */
const REGRESSION_FLOOR: Record<Metric, number> = {
  ttfb: 100, fcp: 150, lcp: 200, cls: 0.05, tbt: 100, dom_content_loaded: 200, load: 300, transfer_kb: 50, requests: 5,
};

export interface PerfViolation {
  metric: Metric;
  value: number;
  kind: 'budget' | 'regression';
  limit: number;
  baseline?: number;
}

export interface PerfReport {
  url: string;
  /** Origin and path, without query or hash: how a page is compared across runs */
  page: string;
  metrics: Metrics;
  budgets: Metrics;
  violations: PerfViolation[];
  maxRegression?: number;
  baselineRuns?: number;
  throttle?: string;
  passed: boolean;
}

/** Observers installed before any page script runs (long tasks are not buffered otherwise). */
export const PERF_INIT_SCRIPT = `(() => {
  if (window.__atabPerf) return;
  const s = window.__atabPerf = { cls: 0, lcp: 0, longTasks: [] };
  const watch = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) {} };
  watch('layout-shift', (e) => { if (!e.hadRecentInput) s.cls += e.value; });
  watch('largest-contentful-paint', (e) => { s.lcp = e.renderTime || e.startTime; });
  watch('longtask', (e) => { s.longTasks.push(e.duration); });
})();`;

const THROTTLE: Record<string, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  // Lighthouse "slow 4G" and DevTools "fast 3G"
  slow4g: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  fast3g: { latency: 562.5, downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 },
};

export function performanceSettings(config: any): { mode: 'off' | 'report' | 'fail'; budgets: Metrics; throttle?: string; cpuSlowdown?: number; maxRegression?: number } {
  const checks = config?.checks ?? {};
  const mode = ['report', 'fail'].includes(checks.performance) ? checks.performance : 'off';
  const opts = checks.performance_options ?? {};
  const throttle = typeof opts.throttle === 'string' && THROTTLE[opts.throttle] ? opts.throttle : undefined;
  const cpu = Number(opts.cpu_slowdown);
  const budgets = normalizeBudgets(checks.performance_budgets ?? {});
  const maxRegression = Number(checks.performance_budgets?.max_regression ?? opts.max_regression);
  return {
    mode,
    budgets: Object.keys(budgets).length ? budgets : { ...DEFAULT_BUDGETS },
    ...(throttle ? { throttle } : {}),
    ...(Number.isFinite(cpu) && cpu > 1 ? { cpuSlowdown: Math.min(cpu, 20) } : {}),
    ...(Number.isFinite(maxRegression) && maxRegression > 0 ? { maxRegression } : {}),
  };
}

export function validatePerformanceConfig(checks: any): string[] {
  const errors: string[] = [];
  if (!checks || typeof checks !== 'object') return errors;
  if (checks.performance !== undefined && !['off', 'report', 'fail'].includes(checks.performance)) errors.push('config.checks.performance must be off, report or fail');
  const throttle = checks.performance_options?.throttle;
  if (throttle !== undefined && throttle !== 'none' && !THROTTLE[throttle]) errors.push(`config.checks.performance_options.throttle must be none, ${Object.keys(THROTTLE).join(' or ')}`);
  for (const [k, v] of Object.entries(checks.performance_budgets ?? {})) {
    if (k !== 'max_regression' && !(METRICS as readonly string[]).includes(k)) errors.push(`Unknown performance budget "${k}" (${METRICS.join(', ')}, max_regression)`);
    else if (!(Number(v) > 0)) errors.push(`Performance budget ${k} must be a positive number`);
  }
  return errors;
}

/** Budgets from step data or agent config: known metrics with positive numbers (aliases accepted). */
export function normalizeBudgets(data: Record<string, any>): Metrics {
  const alias: Record<string, Metric> = { domcontentloaded: 'dom_content_loaded', dom_content_loaded: 'dom_content_loaded', transfer: 'transfer_kb', transferkb: 'transfer_kb', load_ms: 'load', max_ms: 'load' };
  const out: Metrics = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    const key = (alias[k.toLowerCase()] ?? k.toLowerCase()) as Metric;
    if ((METRICS as readonly string[]).includes(key) && Number(v) > 0) out[key] = Number(v);
  }
  return out;
}

/** A load-time budget from the action sentence: "Verify the page loads in under 2 seconds" → { load: 2000 }. */
export function budgetFromSentence(action: string): Metrics {
  const m = action.match(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i);
  if (!m) return {};
  const ms = /^m/i.test(m[2]) ? Number(m[1]) : Number(m[1]) * 1000;
  return ms > 0 ? { load: Math.round(ms) } : {};
}

/** Apply network / CPU throttling to a page (Chromium only; silently skipped elsewhere). */
export async function applyThrottling(context: BrowserContext, page: Page, settings: { throttle?: string; cpuSlowdown?: number }): Promise<boolean> {
  if (!settings.throttle && !settings.cpuSlowdown) return false;
  try {
    const cdp = await context.newCDPSession(page);
    if (settings.throttle) {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...THROTTLE[settings.throttle] });
    }
    if (settings.cpuSlowdown) await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpuSlowdown });
    return true;
  } catch {
    return false;
  }
}

/** Runs in the page (a string, so no transpiler helpers leak into it). */
const MEASURE_SCRIPT = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
  const buffered = (type) => new Promise((resolve) => {
    try {
      const po = new PerformanceObserver((l) => { resolve(l.getEntries()); po.disconnect(); });
      po.observe({ type, buffered: true });
      setTimeout(() => { resolve([]); po.disconnect(); }, 150);
    } catch (e) { resolve([]); }
  });
  const s = window.__atabPerf;
  let lcp = s && s.lcp ? s.lcp : 0;
  let cls = s ? s.cls : undefined;
  if (!lcp) {
    const entries = await buffered('largest-contentful-paint');
    const last = entries[entries.length - 1];
    lcp = last ? last.renderTime || last.startTime : 0;
  }
  if (cls === undefined) cls = (await buffered('layout-shift')).reduce((sum, e) => sum + (e.hadRecentInput ? 0 : e.value), 0);
  const resources = performance.getEntriesByType('resource');
  const bytes = resources.reduce((sum, r) => sum + (r.transferSize || 0), nav ? nav.transferSize || 0 : 0);
  return {
    ttfb: nav ? nav.responseStart : undefined,
    fcp: paint ? paint.startTime : undefined,
    lcp: lcp || undefined,
    cls,
    tbt: s ? s.longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0) : undefined,
    dom_content_loaded: nav && nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd : undefined,
    load: nav && nav.loadEventEnd ? nav.loadEventEnd : undefined,
    transfer_kb: bytes / 1024,
    requests: resources.length + (nav ? 1 : 0),
  };
})()`;

/** Collect the metrics of the last full page load. */
export async function measurePage(page: Page): Promise<Metrics> {
  await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
  // Let late paints, layout shifts and long tasks land
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  const raw = await page.evaluate(MEASURE_SCRIPT);
  const out: Metrics = {};
  for (const k of METRICS) {
    const v = (raw as any)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = k === 'cls' ? Math.round(v * 1000) / 1000 : k === 'transfer_kb' ? Math.round(v * 10) / 10 : Math.round(v);
  }
  return out;
}

export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Compare metrics with budgets and, when given, with the median of earlier runs (pure). */
export function evaluate(metrics: Metrics, budgets: Metrics, history: Metrics[] = [], maxRegression?: number): PerfViolation[] {
  const out: PerfViolation[] = [];
  for (const k of METRICS) {
    const v = metrics[k];
    if (v === undefined) continue;
    const budget = budgets[k];
    if (budget !== undefined && v > budget) out.push({ metric: k, value: v, kind: 'budget', limit: budget });
    if (maxRegression && history.length >= 3) {
      const past = history.map((h) => h[k]).filter((x): x is number => typeof x === 'number');
      if (past.length >= 3) {
        const base = median(past);
        const limit = base * (1 + maxRegression);
        if (v > limit && v - base >= REGRESSION_FLOOR[k]) out.push({ metric: k, value: v, kind: 'regression', limit: Math.round(limit * 1000) / 1000, baseline: Math.round(base * 1000) / 1000 });
      }
    }
  }
  return out;
}

export function formatMetric(k: Metric, v: number): string {
  if (k === 'cls') return v.toFixed(3);
  if (k === 'transfer_kb') return v >= 1024 ? `${(v / 1024).toFixed(1)} MB` : `${Math.round(v)} KB`;
  if (k === 'requests') return String(v);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function describePerformance(r: PerfReport): string {
  const shown = (['lcp', 'fcp', 'cls', 'tbt', 'load'] as Metric[]).filter((k) => r.metrics[k] !== undefined)
    .map((k) => `${k.toUpperCase()} ${formatMetric(k, r.metrics[k]!)}`).join(', ');
  if (!r.violations.length) return `Page speed of ${r.page}: ${shown || 'no metrics'} — within budget`;
  const problems = r.violations.map((v) => v.kind === 'budget'
    ? `${v.metric.toUpperCase()} ${formatMetric(v.metric, v.value)} exceeds the performance budget of ${formatMetric(v.metric, v.limit)}`
    : `${v.metric.toUpperCase()} ${formatMetric(v.metric, v.value)} is slower than the baseline ${formatMetric(v.metric, v.baseline!)} of earlier runs (+${Math.round((v.value / v.baseline! - 1) * 100)}%)`);
  return `Page speed of ${r.page}: ${problems.join('; ')}`;
}

/** Metrics of the same page in the agent's earlier runs (most recent first, last 30 days). */
export async function performanceHistory(agentId: string, runId: string, page: string, limit = 10): Promise<Metrics[]> {
  const res = await getDatabaseClient().query(
    `SELECT p->'metrics' AS metrics
       FROM results r JOIN runs ru ON ru.id = r.run_id,
            LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.metadata->'performance') = 'array' THEN r.metadata->'performance' ELSE '[]'::jsonb END) p
      WHERE ru.agent_id = $1 AND ru.id <> $2 AND ru.started_at >= NOW() - INTERVAL '30 days' AND p->>'page' = $3
      ORDER BY r.started_at DESC LIMIT $4`,
    [agentId, runId, page, limit]);
  return res.rows.map((row) => row.metrics ?? {});
}

/** Measure the page and check it; history is only read when a regression limit is set. */
export async function checkPerformance(
  page: Page,
  opts: { budgets: Metrics; maxRegression?: number; throttle?: string; agentId?: string; runId?: string },
): Promise<PerfReport> {
  const metrics = await measurePage(page);
  const key = pageKey(page.url());
  const history = opts.maxRegression && opts.agentId && opts.runId
    ? await performanceHistory(opts.agentId, opts.runId, key).catch(() => [])
    : [];
  const violations = evaluate(metrics, opts.budgets, history, opts.maxRegression);
  return {
    url: page.url(),
    page: key,
    metrics,
    budgets: opts.budgets,
    violations,
    ...(opts.maxRegression ? { maxRegression: opts.maxRegression, baselineRuns: history.length } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
    passed: violations.length === 0,
  };
}

/** Per-page trend of an agent: samples (oldest first), latest and median per metric. */
export async function performanceTrend(agentId: string, days = 30): Promise<Array<{ page: string; samples: Array<{ runId: string; at: string; metrics: Metrics }>; latest: Metrics; median: Metrics }>> {
  const window = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const res = await getDatabaseClient().query(
    `SELECT p->>'page' AS page, p->'metrics' AS metrics, r.run_id, r.started_at
       FROM results r JOIN runs ru ON ru.id = r.run_id,
            LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.metadata->'performance') = 'array' THEN r.metadata->'performance' ELSE '[]'::jsonb END) p
      WHERE ru.agent_id = $1 AND ru.started_at >= NOW() - ($2 || ' days')::interval
      ORDER BY r.started_at ASC LIMIT 5000`,
    [agentId, window]);
  const pages = new Map<string, Array<{ runId: string; at: string; metrics: Metrics }>>();
  for (const row of res.rows) {
    if (!pages.has(row.page)) pages.set(row.page, []);
    pages.get(row.page)!.push({ runId: row.run_id, at: new Date(row.started_at).toISOString(), metrics: row.metrics ?? {} });
  }
  return [...pages.entries()].map(([page, samples]) => {
    const med: Metrics = {};
    for (const k of METRICS) {
      const xs = samples.map((s) => s.metrics[k]).filter((x): x is number => typeof x === 'number');
      if (xs.length) med[k] = Math.round(median(xs) * 1000) / 1000;
    }
    return { page, samples: samples.slice(-50), latest: samples[samples.length - 1].metrics, median: med };
  }).sort((a, b) => b.samples.length - a.samples.length);
}
