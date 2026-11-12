/**
 * Flaky-test quarantine.
 *
 * A quarantined test still runs and reports its result, but its failure does
 * not fail the run (so CI, wait mode and failure notifications stay green).
 * Tests are quarantined by hand, or automatically when an agent's policy
 * sees them flip between pass and fail; automatically quarantined tests are
 * released after a streak of clean passes.
 *
 * agent.config.quarantine = {
 *   auto: false,          // quarantine flaky tests automatically
 *   flips: 3,             // pass↔fail changes …
 *   window: 10,           // … within the last N runs of the test
 *   passed_on_retry: 3,   // or passing only on retry this many times in the window
 *   release_after: 5,     // release after N consecutive first-attempt passes
 * }
 */

import getDatabaseClient from '../../infra/db/client.js';

export interface Quarantine {
  testCaseId: string;
  projectId: string;
  reason: string;
  auto: boolean;
  quarantinedBy?: string;
  quarantinedAt: Date;
  stats?: FlakeStats;
  title?: string;
}

export interface FlakeStats {
  runs: number;
  flips: number;
  passedOnRetry: number;
  failures: number;
  /** Consecutive most recent first-attempt passes */
  cleanStreak: number;
}

export interface QuarantinePolicy {
  auto: boolean;
  flips: number;
  window: number;
  passedOnRetry: number;
  releaseAfter: number;
}

const num = (v: unknown, d: number, min = 1, max = 100) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};

export function quarantinePolicy(config: any): QuarantinePolicy {
  const q = config?.quarantine ?? {};
  return {
    auto: q.auto === true,
    flips: num(q.flips, 3, 1, 50),
    window: num(q.window, 10, 2, 100),
    passedOnRetry: num(q.passed_on_retry ?? q.passedOnRetry, 3, 1, 50),
    releaseAfter: num(q.release_after ?? q.releaseAfter, 5, 1, 100),
  };
}

/**
 * Flakiness of one test from its final results, oldest first.
 * Each entry: status of the final attempt and how many attempts it took.
 */
export function flakeStats(history: Array<{ status: string; attempt: number }>): FlakeStats {
  const outcomes = history.filter((h) => h.status !== 'skipped');
  let flips = 0;
  for (let i = 1; i < outcomes.length; i++) {
    if ((outcomes[i].status === 'passed') !== (outcomes[i - 1].status === 'passed')) flips++;
  }
  let cleanStreak = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i].status === 'passed' && outcomes[i].attempt <= 1; i--) cleanStreak++;
  return {
    runs: outcomes.length,
    flips,
    passedOnRetry: outcomes.filter((h) => h.status === 'passed' && h.attempt > 1).length,
    failures: outcomes.filter((h) => h.status !== 'passed').length,
    cleanStreak,
  };
}

/** Whether a test should be quarantined (auto) or released, under a policy. */
export function decide(stats: FlakeStats, policy: QuarantinePolicy, current?: Quarantine): 'quarantine' | 'release' | null {
  if (!current) {
    if (!policy.auto) return null;
    // Consistently failing is a real failure, not flakiness: it needs at least one pass.
    const flaky = (stats.flips >= policy.flips && stats.runs - stats.failures > 0) || stats.passedOnRetry >= policy.passedOnRetry;
    return flaky ? 'quarantine' : null;
  }
  if (current.auto && stats.cleanStreak >= policy.releaseAfter) return 'release';
  return null;
}

export function describeFlake(stats: FlakeStats, policy: QuarantinePolicy): string {
  const parts = [];
  if (stats.flips >= policy.flips) parts.push(`flipped between pass and fail ${stats.flips} times in its last ${stats.runs} runs`);
  if (stats.passedOnRetry >= policy.passedOnRetry) parts.push(`passed only on retry ${stats.passedOnRetry} times`);
  return `Flaky: ${parts.join(' and ') || 'unstable results'}`;
}

const fromRow = (r: any): Quarantine => ({
  testCaseId: r.test_case_id,
  projectId: r.project_id,
  reason: r.reason,
  auto: r.auto,
  quarantinedBy: r.quarantined_by ?? undefined,
  quarantinedAt: r.quarantined_at,
  stats: r.stats ?? undefined,
  ...(r.title ? { title: r.title } : {}),
});

export class QuarantineRepository {
  private db = getDatabaseClient();

  async list(projectId: string): Promise<Quarantine[]> {
    const res = await this.db.query(
      `SELECT q.*, tc.title FROM test_quarantine q JOIN test_cases tc ON tc.id = q.test_case_id
        WHERE q.project_id = $1 ORDER BY q.quarantined_at DESC`, [projectId]);
    return res.rows.map(fromRow);
  }

  async ids(projectId: string): Promise<Map<string, Quarantine>> {
    return new Map((await this.list(projectId)).map((q) => [q.testCaseId, q]));
  }

  async add(input: { testCaseId: string; projectId: string; reason: string; auto: boolean; by: string; stats?: FlakeStats }): Promise<Quarantine> {
    const res = await this.db.query(
      `INSERT INTO test_quarantine (test_case_id, project_id, reason, auto, quarantined_by, stats)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (test_case_id) DO UPDATE SET reason = EXCLUDED.reason, auto = EXCLUDED.auto,
         quarantined_by = EXCLUDED.quarantined_by, quarantined_at = CURRENT_TIMESTAMP, stats = EXCLUDED.stats
       RETURNING *`,
      [input.testCaseId, input.projectId, input.reason, input.auto, input.by, input.stats ? JSON.stringify(input.stats) : null]);
    return fromRow(res.rows[0]);
  }

  async remove(testCaseId: string, projectId: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM test_quarantine WHERE test_case_id = $1 AND project_id = $2', [testCaseId, projectId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Final attempt of each test in the agent's last `window` runs, oldest first. */
  async history(agentId: string, testCaseIds: string[], window: number): Promise<Map<string, Array<{ status: string; attempt: number }>>> {
    const out = new Map<string, Array<{ status: string; attempt: number }>>();
    if (!testCaseIds.length) return out;
    const res = await this.db.query(
      `WITH variant AS (
         -- final attempt of each persona / data row of a test in a run
         SELECT DISTINCT ON (r.run_id, r.test_case_id, COALESCE(r.metadata->>'persona', '') || COALESCE('#' || (r.metadata->>'dataRow'), '') || COALESCE('~' || (r.metadata->>'browser'), ''))
                r.run_id, r.test_case_id, r.status, COALESCE((r.metadata->>'attempt')::int, 1) AS attempt, ru.started_at
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.agent_id = $1 AND r.test_case_id = ANY($2) AND r.status <> 'running' AND ru.status IN ('completed', 'failed')
          ORDER BY r.run_id, r.test_case_id, COALESCE(r.metadata->>'persona', '') || COALESCE('#' || (r.metadata->>'dataRow'), '') || COALESCE('~' || (r.metadata->>'browser'), ''), r.started_at DESC
       ), final AS (
         -- one outcome per test and run: a failing persona or row fails the test
         SELECT test_case_id, MIN(started_at) AS started_at,
                CASE WHEN bool_or(status IN ('failed', 'error', 'timeout')) THEN 'failed'
                     WHEN bool_or(status = 'passed') THEN 'passed' ELSE MIN(status) END AS status,
                MAX(attempt) AS attempt
           FROM variant GROUP BY run_id, test_case_id
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY test_case_id ORDER BY started_at DESC) AS n FROM final
       )
       SELECT test_case_id, status, attempt FROM ranked WHERE n <= $3 ORDER BY test_case_id, started_at ASC`,
      [agentId, testCaseIds, window]);
    for (const row of res.rows) {
      if (!out.has(row.test_case_id)) out.set(row.test_case_id, []);
      out.get(row.test_case_id)!.push({ status: row.status, attempt: row.attempt });
    }
    return out;
  }
}

/** After a run: apply the agent's policy to the tests it ran. Returns what changed. */
export async function applyQuarantinePolicy(
  agent: { id: string; projectId: string; config: any },
  testCaseIds: string[],
): Promise<{ quarantined: string[]; released: string[] }> {
  const policy = quarantinePolicy(agent.config);
  const repo = new QuarantineRepository();
  const current = await repo.ids(agent.projectId);
  const changed = { quarantined: [] as string[], released: [] as string[] };
  // Nothing to decide: no auto policy and no auto-quarantined test in this run
  if (!policy.auto && !testCaseIds.some((id) => current.get(id)?.auto)) return changed;
  const histories = await repo.history(agent.id, [...new Set(testCaseIds)], policy.window);
  for (const [testCaseId, history] of histories) {
    const stats = flakeStats(history);
    const decision = decide(stats, policy, current.get(testCaseId));
    if (decision === 'quarantine') {
      await repo.add({ testCaseId, projectId: agent.projectId, reason: describeFlake(stats, policy), auto: true, by: 'auto', stats });
      changed.quarantined.push(testCaseId);
    } else if (decision === 'release') {
      await repo.remove(testCaseId, agent.projectId);
      changed.released.push(testCaseId);
    }
  }
  return changed;
}
