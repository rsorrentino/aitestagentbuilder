/**
 * Quality analytics for a project over a time window.
 *
 * Every metric uses the final attempt of each test in each run, so retries do
 * not double count; "passed on retry" is reported separately as a flakiness signal.
 */

import getDatabaseClient from '../../infra/db/client.js';

export interface Analytics {
  days: number;
  totals: {
    runs: number;
    runsFailed: number;
    testsExecuted: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number | null;
    avgRunDurationMs: number | null;
    byTrigger: Record<string, number>;
  };
  trend: Array<{ day: string; runs: number; passed: number; failed: number; skipped: number; passRate: number | null }>;
  flaky: Array<{ testCaseId: string; title: string; runs: number; passes: number; failures: number; flips: number; passedOnRetry: number }>;
  topFailing: Array<{ testCaseId: string; title: string; failures: number; runs: number; lastError?: string; lastFailedAt?: Date }>;
  slowest: Array<{ testCaseId: string; title: string; avgMs: number; maxMs: number; runs: number }>;
}

export class AnalyticsService {
  private db = getDatabaseClient();

  async get(projectId: string, days = 30): Promise<Analytics> {
    const window = Math.min(Math.max(Math.floor(days), 1), 365);
    const params = [projectId, window];

    // Final attempt of each test in each run within the window
    const finalAttempts = `
      WITH final AS (
        SELECT DISTINCT ON (r.run_id, r.test_case_id, COALESCE(r.metadata->>'persona', '') || COALESCE('#' || (r.metadata->>'dataRow'), '') || COALESCE('~' || (r.metadata->>'browser'), ''))
               r.run_id, r.test_case_id || COALESCE('@' || (r.metadata->>'persona'), '') || COALESCE('#' || (r.metadata->>'dataRow'), '') || COALESCE('~' || (r.metadata->>'browser'), '') AS test_case_id, r.status, r.duration, r.error, r.started_at,
               COALESCE(r.metadata->>'title', tc.title, r.test_case_id) AS title,
               COALESCE((r.metadata->>'attempt')::int, 1) AS attempt
          FROM results r
          JOIN runs ru ON ru.id = r.run_id
          LEFT JOIN test_cases tc ON tc.id = r.test_case_id
         WHERE ru.project_id = $1 AND ru.started_at >= NOW() - ($2 || ' days')::interval
           AND r.status <> 'running'
         ORDER BY r.run_id, r.test_case_id, COALESCE(r.metadata->>'persona', '') || COALESCE('#' || (r.metadata->>'dataRow'), '') || COALESCE('~' || (r.metadata->>'browser'), ''), r.started_at DESC
      )`;

    const [runStats, triggers, trend, flaky, failing, slow, testTotals] = await Promise.all([
      this.db.query(
        `SELECT COUNT(*)::int AS runs,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS runs_failed,
                AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL) AS avg_ms
           FROM runs WHERE project_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval`, params),
      this.db.query(
        `SELECT COALESCE(metadata->>'triggeredBy', 'user') AS trigger, COUNT(*)::int AS n
           FROM runs WHERE project_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval GROUP BY 1`, params),
      this.db.query(
        `${finalAttempts}
         SELECT to_char(date_trunc('day', ru.started_at), 'YYYY-MM-DD') AS day,
                COUNT(DISTINCT ru.id)::int AS runs,
                COUNT(*) FILTER (WHERE f.status = 'passed')::int AS passed,
                COUNT(*) FILTER (WHERE f.status IN ('failed', 'error', 'timeout'))::int AS failed,
                COUNT(*) FILTER (WHERE f.status = 'skipped')::int AS skipped
           FROM runs ru LEFT JOIN final f ON f.run_id = ru.id
          WHERE ru.project_id = $1 AND ru.started_at >= NOW() - ($2 || ' days')::interval
          GROUP BY 1 ORDER BY 1`, params),
      this.db.query(
        `${finalAttempts},
         ordered AS (
           SELECT test_case_id, title, status, attempt,
                  LAG(status) OVER (PARTITION BY test_case_id ORDER BY started_at) AS prev
             FROM final WHERE status IN ('passed', 'failed', 'error')
         )
         SELECT test_case_id, MAX(title) AS title, COUNT(*)::int AS runs,
                COUNT(*) FILTER (WHERE status = 'passed')::int AS passes,
                COUNT(*) FILTER (WHERE status <> 'passed')::int AS failures,
                COUNT(*) FILTER (WHERE prev IS NOT NULL AND (prev = 'passed') <> (status = 'passed'))::int AS flips,
                COUNT(*) FILTER (WHERE status = 'passed' AND attempt > 1)::int AS passed_on_retry
           FROM ordered GROUP BY test_case_id
         HAVING (COUNT(*) FILTER (WHERE status = 'passed') > 0 AND COUNT(*) FILTER (WHERE status <> 'passed') > 0)
             OR COUNT(*) FILTER (WHERE status = 'passed' AND attempt > 1) > 0
          ORDER BY flips DESC, passed_on_retry DESC, failures DESC LIMIT 15`, params),
      this.db.query(
        `${finalAttempts}
         SELECT test_case_id, MAX(title) AS title,
                COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'timeout'))::int AS failures,
                COUNT(*)::int AS runs,
                (ARRAY_AGG(error ORDER BY started_at DESC) FILTER (WHERE status IN ('failed', 'error', 'timeout')))[1] AS last_error,
                MAX(started_at) FILTER (WHERE status IN ('failed', 'error', 'timeout')) AS last_failed_at
           FROM final GROUP BY test_case_id
         HAVING COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'timeout')) > 0
          ORDER BY failures DESC, last_failed_at DESC LIMIT 10`, params),
      this.db.query(
        `${finalAttempts}
         SELECT test_case_id, MAX(title) AS title, AVG(duration)::float AS avg_ms, MAX(duration)::float AS max_ms, COUNT(*)::int AS runs
           FROM final WHERE duration IS NOT NULL AND status = 'passed'
          GROUP BY test_case_id ORDER BY avg_ms DESC LIMIT 10`, params),
      this.db.query(
        `${finalAttempts}
         SELECT COUNT(*)::int AS executed,
                COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
                COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'timeout'))::int AS failed,
                COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
           FROM final`, params),
    ]);

    const t = testTotals.rows[0];
    const rate = (p: number, f: number) => (p + f > 0 ? Math.round((p / (p + f)) * 1000) / 10 : null);

    return {
      days: window,
      totals: {
        runs: runStats.rows[0].runs,
        runsFailed: runStats.rows[0].runs_failed,
        testsExecuted: t.executed,
        passed: t.passed,
        failed: t.failed,
        skipped: t.skipped,
        passRate: rate(t.passed, t.failed),
        avgRunDurationMs: runStats.rows[0].avg_ms !== null ? Math.round(Number(runStats.rows[0].avg_ms)) : null,
        byTrigger: Object.fromEntries(triggers.rows.map((r) => [r.trigger, r.n])),
      },
      trend: trend.rows.map((r) => ({
        day: r.day, runs: r.runs, passed: r.passed, failed: r.failed, skipped: r.skipped, passRate: rate(r.passed, r.failed),
      })),
      flaky: flaky.rows.map((r) => ({
        testCaseId: r.test_case_id, title: r.title, runs: r.runs, passes: r.passes, failures: r.failures, flips: r.flips, passedOnRetry: r.passed_on_retry,
      })),
      topFailing: failing.rows.map((r) => ({
        testCaseId: r.test_case_id, title: r.title, failures: r.failures, runs: r.runs, lastError: r.last_error ?? undefined, lastFailedAt: r.last_failed_at ?? undefined,
      })),
      slowest: slow.rows.map((r) => ({
        testCaseId: r.test_case_id, title: r.title, avgMs: Math.round(r.avg_ms), maxMs: Math.round(r.max_ms), runs: r.runs,
      })),
    };
  }
}
