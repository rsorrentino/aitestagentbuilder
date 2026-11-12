/**
 * Reporting Service
 * Renders run reports as JSON, HTML or JUnit XML.
 */

import { describePerformance } from '../../quality/performance.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TestResult, TestRun } from '../../../core/domain/run.js';
import { RunRepository } from '../../../core/repositories/run.repository.js';
import getDatabaseClient from '../../../infra/db/client.js';
import logger from '../../../infra/logger/index.js';

export type ReportFormat = 'json' | 'html' | 'junit';

export interface ReportOptions {
  formats: ReportFormat[];
  includeScreenshots?: boolean;
  includeLogs?: boolean;
  outputPath?: string;
  /** Base URL used for screenshot links in HTML reports */
  artifactsBaseUrl?: string;
}

export const REPORT_CONTENT_TYPES: Record<ReportFormat, { type: string; ext: string }> = {
  json: { type: 'application/json', ext: 'json' },
  html: { type: 'text/html; charset=utf-8', ext: 'html' },
  junit: { type: 'application/xml', ext: 'xml' },
};

const escapeHtml = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeXml = escapeHtml;
const titleOf = (r: TestResult) => (r.metadata?.title as string) || r.testCaseId;

/** Keep only the latest attempt per test case (retries create several rows). */
export function latestAttempts(results: TestResult[]): TestResult[] {
  // One entry per test and persona (persona matrix runs execute a test once per persona).
  const byTest = new Map<string, TestResult>();
  for (const r of results) {
    const key = `${r.testCaseId}@${(r.metadata as any)?.persona ?? ''}#${(r.metadata as any)?.dataRow ?? ''}`;
    const prev = byTest.get(key);
    if (!prev || new Date(r.startedAt) >= new Date(prev.startedAt)) byTest.set(key, r);
  }
  return [...byTest.values()];
}

export class ReportingAgentService {
  private runRepo = new RunRepository();
  private db = getDatabaseClient();

  async loadRun(runId: string, projectId?: string): Promise<TestRun> {
    const run = await this.runRepo.findRunById(runId, projectId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  render(run: TestRun, format: ReportFormat, options: Partial<ReportOptions> = {}): string {
    const opts = { includeLogs: true, includeScreenshots: true, ...options };
    switch (format) {
      case 'json': return this.generateJSONReport(run, opts);
      case 'html': return this.generateHTMLReport(run, opts);
      case 'junit': return this.generateJUnitReport(run);
      default: throw new Error(`Unsupported report format: ${format}`);
    }
  }

  /** Writes report files to disk and records them in the reports table. */
  async generateReports(runId: string, options: ReportOptions): Promise<string[]> {
    const run = await this.loadRun(runId);
    const outputPath = options.outputPath || process.env.REPORT_STORAGE_PATH || './reports';
    mkdirSync(outputPath, { recursive: true });

    const generated: string[] = [];
    for (const format of options.formats) {
      if (!REPORT_CONTENT_TYPES[format]) continue;
      try {
        const content = this.render(run, format, options);
        const filepath = join(outputPath, `report-${runId}.${REPORT_CONTENT_TYPES[format].ext}`);
        writeFileSync(filepath, content, 'utf-8');
        await this.db.query(
          `INSERT INTO reports (id, run_id, format, file_path, content, generated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`REPORT-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`, runId, format, filepath, format === 'html' ? null : content, new Date()],
        );
        generated.push(filepath);
      } catch (error: any) {
        logger.error('Report generation failed', { runId, format, error: error.message });
      }
    }
    return generated;
  }

  private generateJSONReport(run: TestRun, options: Partial<ReportOptions>): string {
    return JSON.stringify({
      runId: run.id,
      agentId: run.agentId,
      agentName: run.agentName,
      status: run.status,
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
      duration: run.duration,
      summary: { total: run.totalTests, passed: run.passedTests, failed: run.failedTests, skipped: run.skippedTests },
      metadata: run.metadata,
      results: latestAttempts(run.results).map(result => ({
        id: result.id,
        testCaseId: result.testCaseId,
        title: titleOf(result),
        status: result.status,
        duration: result.duration,
        error: result.error,
        steps: result.metadata?.steps,
        ...(options.includeLogs ? { logs: result.logs } : {}),
        ...(options.includeScreenshots ? { evidence: result.evidence } : {}),
      })),
    }, null, 2);
  }

  private generateHTMLReport(run: TestRun, options: Partial<ReportOptions>): string {
    const passRate = run.totalTests > 0 ? ((run.passedTests / run.totalTests) * 100).toFixed(1) : '0';
    const color = (s: string) => ({ passed: '#16a34a', completed: '#16a34a', failed: '#dc2626', error: '#dc2626', skipped: '#6b7280', cancelled: '#6b7280' } as Record<string, string>)[s] ?? '#d97706';
    const results = latestAttempts(run.results);
    const shotBase = options.artifactsBaseUrl ?? '';

    const rows = results.map((r) => {
      const steps = (r.metadata?.steps as any[] | undefined) ?? [];
      const shots = options.includeScreenshots ? (r.evidence?.screenshots ?? []) : [];
      return `
      <div class="result" style="border-left-color:${color(r.status)}">
        <div class="result-head">
          <div><strong>${escapeHtml(titleOf(r))}</strong><div class="muted">${escapeHtml(r.testCaseId)}</div></div>
          <span class="badge" style="background:${color(r.status)}">${escapeHtml(r.status.toUpperCase())}</span>
        </div>
        <div class="muted">Duration: ${r.duration ? (r.duration / 1000).toFixed(2) + 's' : 'n/a'}</div>
        ${r.error ? `<div class="error">${escapeHtml(r.error)}</div>` : ''}
        ${steps.length ? `<table><tr><th>#</th><th>Action</th><th>Target</th><th>Status</th><th>Details</th></tr>
          ${steps.map((s) => `<tr><td>${escapeHtml(s.stepId)}</td><td>${escapeHtml(s.action)}</td><td><code>${escapeHtml(s.target ?? '')}</code></td>
          <td style="color:${color(s.status)}">${escapeHtml(s.status)}</td><td>${escapeHtml(s.message)}</td></tr>`).join('')}</table>`
          : options.includeLogs && r.logs?.length ? `<pre>${escapeHtml(r.logs.join('\n'))}</pre>` : ''}
        ${shots.map((s) => `<a href="${escapeHtml(shotBase + s)}" target="_blank"><img src="${escapeHtml(shotBase + s)}" alt="screenshot"></a>`).join('')}
        ${this.qualityHtml(r, shotBase)}
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report ${escapeHtml(run.id)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;padding:20px;color:#111}
  .container{max-width:1100px;margin:0 auto;background:#fff;padding:28px;border-radius:8px}
  .muted{color:#6b7280;font-size:13px}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
  .card{background:#f8f9fa;border-radius:8px;padding:14px}.card .v{font-size:28px;font-weight:700}
  .badge{color:#fff;border-radius:4px;padding:3px 8px;font-size:12px;font-weight:700}
  .result{border:1px solid #e5e7eb;border-left:4px solid;border-radius:6px;padding:14px;margin-bottom:12px}
  .result-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .error{background:#fef2f2;color:#b91c1c;padding:8px;border-radius:4px;margin-top:8px;font-size:13px;white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}th,td{text-align:left;padding:5px;border-bottom:1px solid #f0f0f0;vertical-align:top}
  img{max-width:320px;border:1px solid #ddd;border-radius:4px;margin:8px 8px 0 0}pre{background:#f8f9fa;padding:8px;font-size:12px;overflow:auto}
</style></head>
<body><div class="container">
  <h1>Test Execution Report</h1>
  <div class="muted">Run ${escapeHtml(run.id)} · Agent ${escapeHtml(run.agentName ?? run.agentId)} · Started ${escapeHtml(new Date(run.startedAt).toLocaleString())}
   · Duration ${run.duration ? (run.duration / 1000).toFixed(1) + 's' : 'n/a'} · <span class="badge" style="background:${color(run.status)}">${escapeHtml(run.status)}</span></div>
  ${run.metadata?.error ? `<div class="error">${escapeHtml(run.metadata.error)}</div>` : ''}
  <div class="summary">
    <div class="card"><div class="muted">Total</div><div class="v">${run.totalTests}</div></div>
    <div class="card"><div class="muted">Passed</div><div class="v" style="color:#16a34a">${run.passedTests}</div></div>
    <div class="card"><div class="muted">Failed</div><div class="v" style="color:#dc2626">${run.failedTests}</div></div>
    <div class="card"><div class="muted">Skipped</div><div class="v" style="color:#6b7280">${run.skippedTests}</div></div>
    <div class="card"><div class="muted">Pass rate</div><div class="v">${passRate}%</div></div>
  </div>
  <h2>Results</h2>${rows || '<p class="muted">No results recorded.</p>'}
</div></body></html>`;
  }

  /** Evidence links, accessibility violations, visual differences and repaired selectors of one result. */
  private qualityHtml(r: any, base: string): string {
    const parts: string[] = [];
    const links = [
      r.evidence?.trace ? `<a href="${escapeHtml(base + r.evidence.trace)}">Playwright trace</a>` : '',
      r.evidence?.video ? `<a href="${escapeHtml(base + r.evidence.video)}">Video</a>` : '',
    ].filter(Boolean);
    if (links.length) parts.push(`<div class="muted">Evidence: ${links.join(' · ')}</div>`);
    for (const a of (r.metadata?.accessibility ?? []) as any[]) {
      const counted = (a.violations ?? []).filter((v: any) => v.counted);
      parts.push(`<div class="muted">Accessibility (${escapeHtml(String(a.level).toUpperCase())}, ${escapeHtml(a.url)}): ${counted.length} violation(s) at ${escapeHtml(a.minImpact)}+</div>`
        + (counted.length ? `<table><tr><th>Rule</th><th>Impact</th><th>Problem</th><th>Elements</th></tr>${counted.map((v: any) =>
          `<tr><td><a href="${escapeHtml(v.helpUrl)}">${escapeHtml(v.id)}</a></td><td>${escapeHtml(v.impact)}</td><td>${escapeHtml(v.help)}</td><td><code>${escapeHtml(v.targets.join(', '))}</code></td></tr>`).join('')}</table>` : ''));
    }
    for (const v of (r.metadata?.visual ?? []) as any[]) {
      const line = `Visual check "${escapeHtml(v.name)}" (${escapeHtml(v.viewport)}${v.persona ? `, ${escapeHtml(v.persona)}` : ''}): ${escapeHtml(v.status)}`
        + (v.status === 'failed' ? `, ${(v.ratio * 100).toFixed(2)}% of pixels changed${v.approved ? ' (approved as new baseline)' : ''}` : '');
      parts.push(`<div class="muted">${line}</div>`
        + (v.status === 'failed' ? ['baseline', 'actual', 'diff'].filter((k) => v[k]).map((k) =>
          `<a href="${escapeHtml(base + v[k])}" target="_blank"><img src="${escapeHtml(base + v[k])}" alt="${k}"></a>`).join('') : ''));
    }
    for (const p of (r.metadata?.performance ?? []) as any[]) {
      parts.push(`<div class="muted">${escapeHtml(describePerformance(p))}${p.throttle ? ` (throttled: ${escapeHtml(p.throttle)})` : ''}</div>`);
    }
    for (const c of (r.metadata?.aiChecks ?? []) as any[]) {
      parts.push(`<div class="muted">AI check "${escapeHtml(c.expectation)}": ${escapeHtml(c.verdict)} (${Math.round(Number(c.confidence) * 100)}%) — ${escapeHtml(c.reason)}</div>`);
    }
    for (const h of (r.metadata?.healing?.steps ?? []) as any[]) {
      parts.push(`<div class="muted">Step ${escapeHtml(h.stepId)} selector repaired by the AI: <code>${escapeHtml(h.from)}</code> → <code>${escapeHtml(h.to)}</code></div>`);
    }
    return parts.join('');
  }

  private generateJUnitReport(run: TestRun): string {
    const results = latestAttempts(run.results);
    // A failed quarantined test is reported as skipped, so CI does not fail on a known-flaky test
    const isQuarantinedFailure = (r: any) => r.metadata?.quarantined === true && ['failed', 'error', 'timeout'].includes(r.status);
    const failures = results.filter(r => r.status === 'failed' && !isQuarantinedFailure(r)).length;
    const errors = results.filter(r => (r.status === 'error' || r.status === 'timeout') && !isQuarantinedFailure(r)).length;
    const skipped = results.filter(r => r.status === 'skipped' || isQuarantinedFailure(r)).length;
    const time = run.duration ? (run.duration / 1000).toFixed(3) : '0';

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${escapeXml(run.agentName ?? run.agentId)}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">
  <testsuite name="${escapeXml(run.agentName ?? run.agentId)}" id="${escapeXml(run.id)}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${new Date(run.startedAt).toISOString()}">
${results.map(r => {
  const t = r.duration ? (r.duration / 1000).toFixed(3) : '0';
  const body = isQuarantinedFailure(r)
    ? `<skipped message="${escapeXml(`quarantined (flaky): ${r.error ?? r.status}`)}"/><system-out>${escapeXml((r.logs ?? []).join('\n'))}</system-out>`
    : r.status === 'failed'
      ? `<failure message="${escapeXml(r.error ?? 'failed')}">${escapeXml((r.logs ?? []).join('\n'))}</failure>`
      : r.status === 'error' || r.status === 'timeout'
        ? `<error message="${escapeXml(r.error ?? r.status)}">${escapeXml((r.logs ?? []).join('\n'))}</error>`
        : r.status === 'skipped' ? `<skipped message="${escapeXml(r.error ?? 'skipped')}"/>` : '';
  return `    <testcase name="${escapeXml(titleOf(r))}" classname="${escapeXml(String(r.metadata?.module ?? 'tests'))}" time="${t}">${body}</testcase>`;
}).join('\n')}
  </testsuite>
</testsuites>`;
  }
}
