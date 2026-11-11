/**
 * Run detail — summary, per-test results with step logs and screenshots, reports.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';
import {
  api, artifactUrl, errorMessage, formatDuration, reportUrl, shortId, statusBadge,
} from '../../lib/api';
import { useRunEvents } from '../../lib/useRunEvents';
import { useSession } from '../../lib/session';
import ResultQuality from '../../components/ResultQuality';
import RunTriage from '../../components/RunTriage';

/** Latest attempt per test case and persona (retries create several results) */
function latest(results: any[]): any[] {
  const map = new Map<string, any>();
  for (const r of results ?? []) {
    const key = `${r.testCaseId}@${r.metadata?.persona ?? ''}#${r.metadata?.dataRow ?? ''}`;
    const prev = map.get(key);
    if (!prev || new Date(r.startedAt) >= new Date(prev.startedAt)) map.set(key, r);
  }
  return Array.from(map.values());
}

export default function RunDetail() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const session = useSession();
  const [aiAvailable, setAiAvailable] = useState(false);
  useEffect(() => {
    api.get('/llm/providers').then((r) => setAiAvailable(!!r.data.anyConfigured)).catch(() => setAiAvailable(false));
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get(`/runs/${id}`);
      setRun(res.data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useRunEvents(id, (event) => {
    if (event === 'test_result' || event === 'run_completed' || event === 'run_started') load();
  });

  // Fallback polling while the run is active
  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'pending')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [run, load]);

  const cancelRun = async () => {
    setCancelling(true);
    try {
      await api.post(`/runs/${id}/cancel`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <Layout title="Run"><div className="page-loading"><div className="spinner" /></div></Layout>;
  if (!run) return <Layout title="Run not found"><div className="alert alert-error">{error ?? 'Run not found.'}</div></Layout>;

  const results = latest(run.results);
  const quarantinedFailures = Number(run.metadata?.quarantinedFailures ?? 0);
  const finished = run.passedTests + run.failedTests + run.skippedTests + quarantinedFailures;
  const progress = run.totalTests > 0 ? Math.min(100, (finished / run.totalTests) * 100) : 0;
  const passRate = finished > 0 ? Math.round((run.passedTests / finished) * 100) : null;
  const active = run.status === 'running' || run.status === 'pending';

  const actions = (
    <>
      <Link href="/runs" className="btn btn-secondary btn-sm">← Runs</Link>
      <Link href={`/live?runId=${run.id}`} className="btn btn-secondary btn-sm">▶ Live View</Link>
      <a href={reportUrl(run.id, 'html')} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">📊 HTML report</a>
      <a href={reportUrl(run.id, 'junit', true)} className="btn btn-ghost btn-sm">JUnit</a>
      <a href={reportUrl(run.id, 'json', true)} className="btn btn-ghost btn-sm">JSON</a>
      {active && <button className="btn btn-danger btn-sm" onClick={cancelRun} disabled={cancelling}>⏹ Cancel</button>}
    </>
  );

  return (
    <Layout title={`Run ${shortId(run.id)}`} actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {run.metadata?.error && <div className="alert alert-error">⚠️ {run.metadata.error}</div>}

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Status</div>
          <div style={{ marginTop: 8 }}><span className={statusBadge(run.status)} style={{ fontSize: 15, padding: '5px 12px' }}>{run.status}</span></div>
        </div>
        <div className="stat-card"><div className="stat-label">Total</div><div className="stat-value">{run.totalTests}</div></div>
        <div className="stat-card success"><div className="stat-label">Passed</div><div className="stat-value" style={{ color: 'var(--success)' }}>{run.passedTests}</div></div>
        <div className="stat-card danger">
          <div className="stat-label">Failed</div>
          <div className="stat-value" style={{ color: 'var(--danger)' }}>{run.failedTests}</div>
          {quarantinedFailures > 0 && <div className="text-sm text-muted">+ {quarantinedFailures} quarantined (not counted)</div>}
        </div>
        <div className="stat-card"><div className="stat-label">Duration</div><div className="stat-value" style={{ fontSize: 22 }}>{formatDuration(run.duration)}</div></div>
        {passRate !== null && <div className="stat-card accent"><div className="stat-label">Pass Rate</div><div className="stat-value">{passRate}%</div></div>}
      </div>

      {run.totalTests > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="flex-between mb-4 text-sm text-muted"><span>Progress</span><span>{finished}/{run.totalTests}</span></div>
          <div className="progress-bar-wrap">
            <div className={`progress-bar-fill${run.failedTests > 0 ? ' danger' : progress === 100 ? ' success' : ''}`} style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header"><h3>Run Info</h3></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 24px', fontSize: 14 }}>
          <div><span className="text-muted">Agent: </span><Link href={`/agents/${run.agentId}`}>{run.agentName ?? run.agentId}</Link></div>
          <div><span className="text-muted">Started: </span>{new Date(run.startedAt).toLocaleString()}</div>
          <div><span className="text-muted">Finished: </span>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}</div>
          <div><span className="text-muted">Selection: </span>{run.metadata?.strategy ?? '—'}</div>
          <div><span className="text-muted">Run ID: </span><span className="code">{run.id}</span></div>
        </div>
      </div>

      <RunTriage
        run={run}
        canEdit={session.can('editor')}
        aiAvailable={aiAvailable}
        onChanged={load}
        onOpenResult={(resultId) => {
          setExpanded(resultId);
          setTimeout(() => document.getElementById(`result-${resultId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
        }}
      />

      <div className="card">
        <div className="card-header"><h3>Test Results</h3><span className="text-sm text-muted">click a row for step details</span></div>
        {results.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🧪</div>
            <h3>No results yet</h3>
            <p>{active ? 'Tests are starting…' : 'No test results were recorded for this run.'}</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Test</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <Fragment key={r.id}>
                    <tr id={`result-${r.id}`} onClick={() => setExpanded(expanded === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="fw-600">{r.metadata?.title ?? r.testCaseId}</div>
                        <div className="text-sm text-muted">{r.metadata?.module}{r.metadata?.attempt > 1 ? ` · attempt ${r.metadata.attempt}` : ''}</div>
                      </td>
                      <td>
                        <span className={statusBadge(r.status)}>{r.status}</span>
                        {r.metadata?.quarantined && <div><span className="badge badge-warning" title="Quarantined (flaky): its failure does not fail the run">🧪 quarantined</span></div>}
                      </td>
                      <td className="text-sm">{formatDuration(r.duration)}</td>
                      <td style={{ maxWidth: 420, color: 'var(--danger)', fontSize: 12 }}>{r.error}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--gray-50)' }}>
                          {(r.metadata?.steps ?? []).length > 0 ? (
                            <table className="data-table" style={{ fontSize: 13 }}>
                              <thead><tr><th>#</th><th>Action</th><th>Target</th><th>Status</th><th>Details</th><th>Time</th></tr></thead>
                              <tbody>
                                {r.metadata.steps.map((s: any) => (
                                  <tr key={s.stepId}>
                                    <td>{s.stepId}</td>
                                    <td>{s.action}</td>
                                    <td className="code">{s.healedSelector ? `${s.target} → ${s.healedSelector}` : s.target}</td>
                                    <td><span className={statusBadge(s.status)}>{s.status}</span></td>
                                    <td>{s.message}</td>
                                    <td>{formatDuration(s.durationMs)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{(r.logs ?? []).join('\n') || 'No step details.'}</pre>
                          )}
                          {(r.evidence?.screenshots ?? []).map((s: string) => (
                            <a key={s} href={artifactUrl(s)} target="_blank" rel="noreferrer">
                              <img src={artifactUrl(s)} alt="Screenshot" style={{ maxWidth: 360, marginTop: 10, border: '1px solid var(--gray-200)', borderRadius: 6 }} />
                            </a>
                          ))}
                          <ResultQuality runId={run.id} result={r} canEdit={session.can('editor')} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
