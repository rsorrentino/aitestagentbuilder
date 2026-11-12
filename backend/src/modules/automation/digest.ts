/**
 * Daily digest: one message in the morning about everything that ran (mostly
 * at night), per agent — instead of reading every run notification.
 *
 * A notification channel subscribed to digest.daily gets it at config.digest_time
 * (HH:MM, default 07:00) in config.digest_timezone (default UTC), once a day,
 * also with several API replicas (the slot is claimed in the database).
 */

import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import { authHealth } from '../auth/health.js';
import { getNotificationService } from './notification.service.js';

export interface AgentDigest {
  agentId: string;
  agentName: string;
  runs: number;
  failedRuns: number;
  lastStatus: string;
  lastRunId: string;
  passed: number;
  failed: number;
  /** Failures of the latest run: title, and whether it was failing before */
  failures: Array<{ title: string; error?: string; known: boolean }>;
  /** Tests that failed, then passed when re-run (likely flaky) */
  passedOnRerun: number;
  preflightFailures: number;
}

export interface Digest {
  projectId: string;
  projectName: string;
  since: string;
  agents: AgentDigest[];
  signInAttention: number;
}

/** Wall-clock HH:MM of a date in a time zone, and that zone's date (YYYY-MM-DD). */
function localParts(d: Date, tz: string): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Is the channel's digest due now (today's slot passed, not sent since)? Pure. */
export function digestDue(now: Date, cfg: { digest_time?: string; digest_timezone?: string }, lastSent?: Date | null): boolean {
  const tz = cfg.digest_timezone || 'UTC';
  const slot = cfg.digest_time || '07:00';
  const today = localParts(now, tz);
  if (today.time < slot) return false;
  if (!lastSent) return true;
  const last = localParts(lastSent, tz);
  // Sent today after the slot already
  return !(last.date === today.date && last.time >= slot);
}

export async function buildDigest(projectId: string, since: Date): Promise<Digest> {
  const db = getDatabaseClient();
  const project = (await db.query('SELECT name FROM projects WHERE id = $1', [projectId])).rows[0];
  const runs = (await db.query(
    `SELECT r.id, r.agent_id, a.name AS agent_name, r.status, r.passed_tests, r.failed_tests, r.started_at, r.metadata
       FROM runs r JOIN agents a ON a.id = r.agent_id
      WHERE r.project_id = $1 AND r.started_at >= $2 AND r.status IN ('completed', 'failed', 'cancelled')
      ORDER BY r.started_at DESC`, [projectId, since])).rows;
  const byAgent = new Map<string, any[]>();
  for (const r of runs) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    byAgent.get(r.agent_id)!.push(r);
  }
  const agents: AgentDigest[] = [];
  for (const [agentId, list] of byAgent) {
    const latest = list[0];
    const results = (await db.query(
      `SELECT DISTINCT ON (test_case_id, COALESCE(metadata->>'persona', '') || COALESCE('#' || (metadata->>'dataRow'), '') || COALESCE('~' || (metadata->>'browser'), ''))
              test_case_id, status, error, metadata
         FROM results WHERE run_id = $1
        ORDER BY test_case_id, COALESCE(metadata->>'persona', '') || COALESCE('#' || (metadata->>'dataRow'), '') || COALESCE('~' || (metadata->>'browser'), ''), started_at DESC`, [latest.id])).rows;
    const triageGroups: any[] = latest.metadata?.triage?.groups ?? [];
    const failures = results.filter((x) => ['failed', 'error', 'timeout'].includes(x.status) && !x.metadata?.quarantined).map((x) => {
      const group = triageGroups.find((g) => g.tests?.some((t: any) => t.testCaseId === x.test_case_id));
      return { title: x.metadata?.title ?? x.test_case_id, error: x.error ? String(x.error).slice(0, 160) : undefined, known: (group?.seenBefore ?? 0) > 0 };
    });
    const rerun = (await db.query(
      `SELECT COUNT(*)::int AS n FROM results r JOIN runs ru ON ru.id = r.run_id
        WHERE ru.agent_id = $1 AND ru.started_at >= $2 AND r.status = 'passed' AND (r.metadata->>'rerun')::boolean`, [agentId, since])).rows[0].n;
    agents.push({
      agentId,
      agentName: latest.agent_name,
      runs: list.length,
      failedRuns: list.filter((r) => r.status === 'failed').length,
      lastStatus: latest.status,
      lastRunId: latest.id,
      passed: latest.passed_tests ?? 0,
      failed: latest.failed_tests ?? 0,
      failures,
      passedOnRerun: rerun,
      preflightFailures: list.filter((r) => r.metadata?.preflight && r.metadata.preflight.ok === false).length,
    });
  }
  const signInAttention = (await authHealth(projectId).catch(() => [])).filter((x) => x.attention).length;
  return { projectId, projectName: project?.name ?? projectId, since: since.toISOString(), agents: agents.sort((a, b) => b.failed - a.failed || a.agentName.localeCompare(b.agentName)), signInAttention };
}

/** The digest as a notification message (headline + lines). */
export function digestMessage(d: Digest, appUrl: string): { headline: string; lines: Array<{ title: string; error?: string }>; status: string; failed: number } {
  const failing = d.agents.filter((a) => a.lastStatus !== 'completed');
  const headline = d.agents.length === 0
    ? `🌅 ${d.projectName}: no runs in the last 24 h`
    : failing.length === 0
      ? `🌅 ${d.projectName}: all ${d.agents.length} agent(s) passed`
      : `🌅 ${d.projectName}: ${failing.length} of ${d.agents.length} agent(s) failing`;
  const lines: Array<{ title: string; error?: string }> = [];
  for (const a of d.agents) {
    const status = a.lastStatus === 'completed' ? '✅' : a.preflightFailures && a.failed === 0 ? '⚠️' : '❌';
    const extra = [
      a.runs > 1 ? `${a.runs} runs` : '',
      a.passedOnRerun ? `${a.passedOnRerun} passed only when re-run` : '',
      a.preflightFailures ? `${a.preflightFailures} pre-flight failure(s): application unreachable` : '',
    ].filter(Boolean).join(', ');
    lines.push({ title: `${status} ${a.agentName}: ${a.passed} passed, ${a.failed} failed${extra ? ` (${extra})` : ''}`, error: `${appUrl}/runs/${a.lastRunId}` });
    for (const f of a.failures.slice(0, 5)) lines.push({ title: `   ${f.known ? '↺ still failing' : '🆕 new'}: ${f.title}`, error: f.error });
    if (a.failures.length > 5) lines.push({ title: `   …and ${a.failures.length - 5} more` });
  }
  if (d.signInAttention) lines.push({ title: `🔐 ${d.signInAttention} test user(s) may need a person to sign in (see the dashboard)` });
  return { headline, lines, status: failing.length ? 'failed' : 'completed', failed: failing.length };
}

/** Send the digest of a channel now (also used by the "Send now" button). */
export async function sendDigest(channel: { id: string; projectId: string }, now = new Date()): Promise<{ ok: boolean; status: string; error?: string }> {
  const appUrl = (process.env.PUBLIC_APP_URL || 'http://localhost:4000').replace(/\/$/, '');
  const d = await buildDigest(channel.projectId, new Date(now.getTime() - 24 * 3_600_000));
  const m = digestMessage(d, appUrl);
  const summary: any = {
    id: `DIGEST-${now.toISOString().slice(0, 10)}`, status: m.status, agentId: '', agentName: d.projectName, projectId: d.projectId, projectName: d.projectName,
    total: d.agents.length, passed: d.agents.length - m.failed, failed: m.failed, skipped: 0, durationMs: 0, startedAt: new Date(d.since), finishedAt: now,
    triggeredBy: 'digest', error: undefined, url: `${appUrl}/runs`, triage: undefined, headline: m.headline, failures: m.lines, digest: d,
  };
  return getNotificationService().deliverMessage(channel.id, 'digest.daily', summary);
}

/** Background job: send the digests that are due (each slot claimed once in the database). */
export async function sendDueDigests(now = new Date()): Promise<number> {
  const db = getDatabaseClient();
  const rows = (await db.query(
    `SELECT id, project_id, config, last_digest_at FROM notification_channels WHERE enabled AND events ? 'digest.daily'`)).rows;
  let sent = 0;
  for (const row of rows) {
    const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    if (!digestDue(now, cfg, row.last_digest_at ? new Date(row.last_digest_at) : null)) continue;
    // Claim: only one replica sends it
    const claimed = await db.query(
      `UPDATE notification_channels SET last_digest_at = $1 WHERE id = $2 AND (last_digest_at IS NULL OR last_digest_at = $3) RETURNING id`,
      [now, row.id, row.last_digest_at]);
    if (!claimed.rowCount) continue;
    try {
      await sendDigest({ id: row.id, projectId: row.project_id }, now);
      sent++;
    } catch (e: any) {
      logger.error('Daily digest failed', { channel: row.id, error: e.message });
    }
  }
  return sent;
}
