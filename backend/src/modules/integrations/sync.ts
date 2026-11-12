/**
 * After every run, for each enabled integration of the project:
 *
 *  - Defects: a failure group of a category the integration files (default: app_bug) gets one
 *    issue, deduplicated by agent + failure signature. It is commented (at most once a day) when it
 *    fails again, and commented and resolved when its tests pass again. The first failing test's
 *    screenshot is attached.
 *  - Requirements: tests linked to issues (stories) show their latest result on the issue, as a link
 *    that is updated, not duplicated.
 *
 * Errors never fail the run: they are logged and kept in run.metadata.integrations.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import crypto from 'crypto';
import logger from '../../infra/logger/index.js';
import { ARTIFACTS_PATH } from '../../infra/config/paths.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import type { TestRun } from '../../core/domain/run.js';
import { isUnattended } from '../automation/unattended.js';
import { DefectRepository, IntegrationRepository, TestLinkRepository } from './repository.js';
import { codeHostFor, trackerFor } from './registry.js';
import { CommitState, defectPolicy, Integration, IssueTracker } from './types.js';

const appUrl = () => (process.env.PUBLIC_APP_URL || 'http://localhost:4000').replace(/\/$/, '');
const DAY = 24 * 3_600_000;

export interface SyncReport {
  integration: string;
  type: string;
  filed: Array<{ key: string; url: string; title: string }>;
  commented: string[];
  resolved: string[];
  linked: number;
  /** Code hosts: commit status set and pull request comment */
  status?: CommitState;
  comment?: string;
  errors: string[];
}

/** Short, stable label for a failure signature (also put on the issue to find it by hand). */
export const signatureLabel = (agentId: string, signature: string) => `atab-${crypto.createHash('sha1').update(`${agentId}|${signature}`).digest('hex').slice(0, 10)}`;

/** Bug title and description for a triage group (pure). */
export function defectText(run: Pick<TestRun, 'id' | 'agentName' | 'agentId'>, group: any): { title: string; body: string } {
  const step = group.sample?.action ? `${group.sample.action}${group.sample.target ? ` → ${group.sample.target}` : ''}` : 'a step';
  const error = String(group.sample?.error ?? 'Unknown error').replace(/^Step \d+ \([^)]*\):\s*/, '');
  const title = `[Automated test] ${run.agentName ?? run.agentId}: ${error.split('\n')[0].slice(0, 120)}`;
  const tests = (group.tests ?? []).map((t: any) => `- ${t.title}${t.persona ? ` (as ${t.persona})` : ''}`).join('\n');
  const body = [
    `Found by AI Test Agent Builder in run ${run.id}: ${appUrl()}/runs/${run.id}`,
    `Failed step: ${step}\nError: ${error.slice(0, 1500)}`,
    `Failing test(s):\n${tests}`,
    `Category: ${group.category} (${group.reason})${group.cause ? `\nLikely cause (AI): ${group.cause}` : ''}${group.suggestion ? `\nSuggestion (AI): ${group.suggestion}` : ''}`,
    'This issue is updated automatically: a comment is added when the failure happens again, and it is resolved when the tests pass.',
  ].join('\n\n');
  return { title, body };
}

async function screenshotOf(run: TestRun, resultId: string): Promise<{ name: string; data: Buffer; contentType: string } | null> {
  const result = run.results?.find((r) => r.id === resultId);
  const shot = (result?.evidence?.screenshots ?? []).slice(-1)[0] as string | undefined;
  if (!shot) return null;
  try {
    const data = await readFile(join(ARTIFACTS_PATH, ...shot.split('?')[0].split('/')));
    return { name: `failure-${resultId}.png`, data, contentType: 'image/png' };
  } catch {
    return null;
  }
}

async function syncDefects(run: TestRun, integration: Integration, tracker: IssueTracker, report: SyncReport): Promise<void> {
  const policy = defectPolicy(integration.config);
  if (!policy.enabled) return;
  if (policy.onlyUnattended && !isUnattended(run.metadata?.triggeredBy)) return;
  if (policy.agents.length && !policy.agents.includes(run.agentId)) return;
  const defects = new DefectRepository();
  const open = await defects.open(integration.id, run.agentId);
  const groups: any[] = run.metadata?.triage?.groups ?? [];
  const failingSignatures = new Set<string>();

  // Failures of quarantined (flaky) tests are never filed
  const quarantined = new Set((run.results ?? []).filter((r) => (r.metadata as any)?.quarantined).map((r) => r.id));
  for (const group of groups) {
    failingSignatures.add(group.signature);
    if (!policy.categories.includes(group.category)) continue;
    const real = (group.tests ?? []).filter((t: any) => !quarantined.has(t.resultId));
    if (!real.length) continue;
    const g = { ...group, tests: real };
    const tests = real.map((t: any) => ({ testCaseId: t.testCaseId, title: t.title }));
    const existing = open.find((d) => d.signature === g.signature);
    try {
      if (existing) {
        // Still failing: comment at most once a day
        const comment = !existing.lastCommentedAt || Date.now() - new Date(existing.lastCommentedAt).getTime() > DAY;
        if (comment) {
          await tracker.comment(existing.key, `Still failing in run ${run.id} (${tests.length} test${tests.length === 1 ? '' : 's'}): ${appUrl()}/runs/${run.id}`);
          report.commented.push(existing.key);
        }
        await defects.seenAgain(existing.id, run.id, tests, comment);
        continue;
      }
      const { title, body } = defectText(run, g);
      const issue = await tracker.create({ title, body, labels: [...policy.labels, signatureLabel(run.agentId, g.signature)] });
      await defects.create({ projectId: run.projectId!, integrationId: integration.id, agentId: run.agentId, signature: g.signature, key: issue.key, url: issue.url, title, tests, firstRunId: run.id, lastRunId: run.id });
      report.filed.push({ key: issue.key, url: issue.url, title });
      const shot = g.tests?.[0]?.resultId ? await screenshotOf(run, g.tests[0].resultId) : null;
      if (shot) await tracker.attach(issue.key, shot).catch((e) => report.errors.push(`attach ${issue.key}: ${e.message}`));
    } catch (e: any) {
      report.errors.push(e.message);
    }
  }

  // Fixed: none of the defect's tests failed in this run, and at least one of them ran and passed
  const passed = new Set((run.results ?? []).filter((r) => r.status === 'passed').map((r) => r.testCaseId));
  const failedTests = new Set((run.results ?? []).filter((r) => ['failed', 'error', 'timeout'].includes(r.status)).map((r) => r.testCaseId));
  for (const d of open) {
    if (failingSignatures.has(d.signature)) continue;
    const ids = d.tests.map((t) => t.testCaseId);
    if (!ids.some((id) => passed.has(id)) || ids.some((id) => failedTests.has(id) && !passed.has(id))) continue;
    try {
      await tracker.comment(d.key, `Passing again in run ${run.id}: ${appUrl()}/runs/${run.id}`);
      const moved = await tracker.resolve(d.key, policy.resolveTransition).catch(() => false);
      await defects.resolve(d.id, run.id);
      report.resolved.push(`${d.key}${moved ? '' : ' (commented)'}`);
    } catch (e: any) {
      report.errors.push(e.message);
    }
  }
}

async function syncRequirements(run: TestRun, integration: Integration, tracker: IssueTracker, report: SyncReport): Promise<void> {
  if (integration.config?.requirements?.report_results === false) return;
  const ids = [...new Set((run.results ?? []).map((r) => r.testCaseId))];
  const links = (await new TestLinkRepository().forTests(ids)).filter((l) => l.integrationId === integration.id);
  for (const l of links) {
    const results = (run.results ?? []).filter((r) => r.testCaseId === l.testCaseId).sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
    const latest = results[0];
    if (!latest) continue;
    const passed = latest.status === 'passed' ? true : ['failed', 'error', 'timeout'].includes(latest.status) ? false : null;
    const title = (latest.metadata as any)?.title ?? l.testCaseId;
    try {
      await tracker.link(l.key, {
        id: `atab-test-${l.testCaseId}`,
        url: `${appUrl()}/runs/${run.id}`,
        title: `${passed === true ? '✅' : passed === false ? '❌' : '⏸'} Test “${title}”: ${latest.status} (${new Date(latest.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
        passed,
      });
      report.linked++;
    } catch (e: any) {
      report.errors.push(`${l.key}: ${e.message}`);
    }
  }
}

// ── Commits and pull requests ────────────────────────────────────────────────

/** Final attempt of each test (persona, data row): the ones that failed, quarantined ones apart. */
function finalFailures(run: TestRun): { failed: any[]; quarantined: number } {
  const latest = new Map<string, any>();
  for (const r of run.results ?? []) {
    const m = (r.metadata ?? {}) as any;
    const key = `${r.testCaseId}@${m.persona ?? ''}#${m.dataRow ?? ''}`;
    const prev = latest.get(key);
    if (!prev || new Date(r.startedAt) >= new Date(prev.startedAt)) latest.set(key, r);
  }
  const failing = [...latest.values()].filter((r) => ['failed', 'error', 'timeout'].includes(r.status));
  return { failed: failing.filter((r) => !(r.metadata as any)?.quarantined), quarantined: failing.filter((r) => (r.metadata as any)?.quarantined).length };
}

const short = (sha?: string) => String(sha ?? '').slice(0, 7);
const cell = (v: any) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Commit status for a run (pure). */
export function commitStatusOf(run: Pick<TestRun, 'status' | 'totalTests' | 'passedTests' | 'failedTests' | 'metadata'>): { state: CommitState; description: string } {
  if (run.status === 'pending' || run.status === 'running') return { state: 'pending', description: `Running ${run.totalTests} test${run.totalTests === 1 ? '' : 's'}…` };
  if (run.status === 'cancelled') return { state: 'error', description: 'Run cancelled' };
  if (run.metadata?.preflight && !run.metadata.preflight.ok) return { state: 'error', description: 'The application was not reachable (pre-flight failed): no tests ran' };
  if (run.status === 'completed' && !run.failedTests) return { state: 'success', description: `${run.passedTests} of ${run.totalTests} passed` };
  if (run.failedTests) return { state: 'failure', description: `${run.failedTests} of ${run.totalTests} failed` };
  return { state: 'error', description: String(run.metadata?.error ?? 'The run did not finish').slice(0, 140) };
}

/** Pull request comment for a finished run (pure, Markdown). */
export function pullRequestComment(run: TestRun): string {
  const { state } = commitStatusOf(run);
  const icon = state === 'success' ? '✅' : state === 'failure' ? '❌' : '⚠️';
  const head = state === 'success' ? 'AI tests passed' : state === 'failure' ? 'AI tests failed' : 'AI tests did not run completely';
  const git = run.metadata?.git ?? {};
  const { failed, quarantined } = finalFailures(run);
  const duration = run.duration ? ` · ${Math.round(run.duration / 1000)} s` : '';
  const lines = [
    `### ${icon} ${head}: ${run.agentName ?? run.agentId}`,
    `**${run.passedTests} passed · ${run.failedTests} failed** of ${run.totalTests}${quarantined ? ` · ${quarantined} quarantined (flaky) failure${quarantined === 1 ? '' : 's'} not counted` : ''}${duration} · [run ${run.id}](${appUrl()}/runs/${run.id})`,
    `Tested ${run.metadata?.baseUrl ? `\`${run.metadata.baseUrl}\`` : 'the agent\'s application'} at ${short(git.sha)}${git.environment ? ` (${git.environment})` : ''}.`,
  ];
  if (run.metadata?.preflight && !run.metadata.preflight.ok) {
    lines.push('', `The pre-flight check failed, so no tests ran: ${run.metadata.preflight.checks.filter((c: any) => !c.ok).map((c: any) => `${c.name}: ${c.detail}`).join('; ')}`);
  }
  if (failed.length) {
    lines.push('', '| Failed test | Error |', '|---|---|');
    for (const r of failed.slice(0, 10)) {
      const m = (r.metadata ?? {}) as any;
      lines.push(`| ${cell(m.title ?? r.testCaseId)}${m.persona ? ` (as ${cell(m.persona)})` : ''} | ${cell(String(r.error ?? m.error ?? '').replace(/^Step \d+ \([^)]*\):\s*/, ''))} |`);
    }
    if (failed.length > 10) lines.push(`| … and ${failed.length - 10} more | |`);
  }
  const groups: any[] = run.metadata?.triage?.groups ?? [];
  if (groups.length) {
    const label: Record<string, string> = { app_bug: 'application bug', test_bug: 'broken test', environment: 'environment problem', unknown: 'unclassified' };
    lines.push('', `**Triage:** ${groups.map((g) => `${g.tests?.length ?? 0} × ${label[g.category] ?? g.category}${g.seenBefore ? '' : ' (new)'}`).join(', ')}`);
  }
  const filed = (run.metadata?.integrations ?? []).flatMap((i: any) => i.filed ?? []);
  if (filed.length) lines.push('', `Bugs filed: ${filed.map((f: any) => `[${f.key}](${f.url})`).join(', ')}`);
  lines.push('', '<sub>Updated on every run by AI Test Agent Builder.</sub>');
  return lines.join('\n');
}

/** The project's code host integration a run reports to: the one it was started from, or the one of its repository. */
async function codeHostIntegration(run: TestRun): Promise<Integration | null> {
  const git = run.metadata?.git;
  if (!git?.sha || !run.projectId) return null;
  const all = (await new IntegrationRepository().list(run.projectId, true)).filter((i) => i.enabled && codeHostFor(i));
  return all.find((i) => i.id === git.integrationId)
    ?? all.find((i) => String(i.config.repository ?? i.config.project ?? '').toLowerCase() === String(git.repository ?? '').toLowerCase())
    ?? null;
}

const statusContext = (run: TestRun) => `AI tests / ${run.agentName ?? run.agentId}`;

/** Pending commit status when a run of a commit starts (never throws). */
export async function reportRunStarted(runId: string): Promise<void> {
  const run = await new RunRepository().findRunById(runId).catch(() => null);
  if (!run) return;
  const integration = await codeHostIntegration(run);
  if (!integration || integration.config.commit_status === false) return;
  const { state, description } = commitStatusOf({ ...run, status: 'running' });
  await codeHostFor(integration)!.setStatus(run.metadata!.git.sha, state, { context: statusContext(run), description, url: `${appUrl()}/runs/${run.id}` });
}

async function syncCodeHost(run: TestRun, integration: Integration, report: SyncReport): Promise<void> {
  const git = run.metadata?.git;
  const host = codeHostFor(integration);
  if (!host || !git?.sha || (await codeHostIntegration(run))?.id !== integration.id) return;
  const { state, description } = commitStatusOf(run);
  if (integration.config.commit_status !== false) {
    try {
      await host.setStatus(git.sha, state, { context: statusContext(run), description, url: `${appUrl()}/runs/${run.id}` });
      report.status = state;
    } catch (e: any) {
      report.errors.push(`commit status: ${e.message}`);
    }
  }
  if (git.pr && integration.config.pr_comment !== false && run.status !== 'cancelled') {
    try {
      report.comment = (await host.upsertPullRequestComment(Number(git.pr), `<!-- atab:run:${run.agentId} -->`, pullRequestComment(run))).url;
    } catch (e: any) {
      report.errors.push(`pull request comment: ${e.message}`);
    }
  }
}

/** Run the project's integrations for a finished run (never throws). */
export async function syncRun(runId: string): Promise<SyncReport[]> {
  const runs = new RunRepository();
  const run = await runs.findRunById(runId).catch(() => null);
  if (!run?.projectId) return [];
  const integrations = (await new IntegrationRepository().list(run.projectId, true)).filter((i) => i.enabled);
  const reports: SyncReport[] = [];
  for (const integration of integrations) {
    const report: SyncReport = { integration: integration.name, type: integration.type, filed: [], commented: [], resolved: [], linked: 0, errors: [] };
    try {
      if (run.status !== 'cancelled') {
        const tracker = trackerFor(integration);
        await syncDefects(run, integration, tracker, report);
        await syncRequirements(run, integration, tracker, report);
        // The pull request comment lists the bugs just filed
        if (report.filed.length) run.metadata = { ...run.metadata, integrations: [...(run.metadata?.integrations ?? []), report] };
      }
      await syncCodeHost(run, integration, report);
    } catch (e: any) {
      report.errors.push(e.message);
    }
    if (report.errors.length) logger.warn('Integration sync had errors', { runId, integration: integration.name, errors: report.errors });
    if (report.filed.length || report.commented.length || report.resolved.length || report.linked || report.status || report.errors.length) reports.push(report);
  }
  if (reports.length) await runs.updateRun(runId, { metadata: { integrations: reports } as any }).catch(() => undefined);
  return reports;
}
