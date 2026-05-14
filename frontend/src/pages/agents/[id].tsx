/**
 * Agent Detail Page — view details, generate tests, trigger a run.
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

function statusBadge(status: string) {
  const map: Record<string, string> = {
    completed: 'badge badge-success',
    passed:    'badge badge-success',
    running:   'badge badge-warning',
    pending:   'badge badge-info',
    failed:    'badge badge-danger',
    cancelled: 'badge badge-neutral',
    active:    'badge badge-success',
    inactive:  'badge badge-neutral',
  };
  return map[status] ?? 'badge badge-neutral';
}

export default function AgentDetailPage() {
  const router = useRouter();
  const { id } = router.query as { id: string };

  const [agent, setAgent]         = useState<any>(null);
  const [runs, setRuns]           = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [genResult, setGenResult] = useState<any[] | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchAll();
  }, [id]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [agentRes, runsRes] = await Promise.all([
        axios.get(`${API_URL}/agents/${id}`),
        axios.get(`${API_URL}/runs?agentId=${id}&limit=20`).catch(() => ({ data: [] })),
      ]);
      setAgent(agentRes.data);
      setRuns(Array.isArray(runsRes.data) ? runsRes.data : []);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  const startRun = async () => {
    setRunLoading(true);
    setError(null);
    try {
      const res = await axios.post(`${API_URL}/runs`, { agentId: id });
      router.push(`/live?runId=${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
      setRunLoading(false);
    }
  };

  const generateTests = async () => {
    setGenLoading(true);
    setError(null);
    setGenResult(null);
    try {
      const res = await axios.post(`${API_URL}/agents/${id}/generate-tests`, { count: 5 });
      setGenResult(res.data.tests ?? []);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setGenLoading(false);
    }
  };

  const actions = (
    <>
      <Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>
      {agent && (
        <>
          <button className="btn btn-secondary btn-sm" onClick={generateTests} disabled={genLoading}>
            {genLoading ? '…' : '🤖 Generate Tests'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={startRun} disabled={runLoading}>
            {runLoading ? '…' : '▶ Start Run'}
          </button>
        </>
      )}
    </>
  );

  if (loading) return <Layout title="Agent" actions={actions}><div className="page-loading"><div className="spinner" /></div></Layout>;
  if (!agent)  return <Layout title="Agent not found" actions={<Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>}><div className="alert alert-error">Agent not found.</div></Layout>;

  const cfg = agent.config ?? {};

  return (
    <Layout title={agent.name} actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        {/* Config */}
        <div className="card">
          <div className="card-header"><h3>Configuration</h3><span className={statusBadge(agent.status)}>{agent.status}</span></div>
          <div className="card-body">
            {[
              ['ID',            <span className="code">{agent.id}</span>],
              ['Type',          cfg.application_type ?? '—'],
              ['Base URL',      <a href={cfg.base_url} target="_blank" rel="noreferrer" className="text-sm">{cfg.base_url || '—'}</a>],
              ['Environment',   cfg.environment ?? '—'],
              ['AI Provider',   cfg.ai?.provider ?? '—'],
              ['Model',         cfg.ai?.model ?? '—'],
              ['Self-Healing',  cfg.ai?.self_healing ? '✅ Enabled' : '✗ Disabled'],
              ['Max Parallel',  cfg.max_parallel_tests ?? '—'],
              ['Timeout',       cfg.timeout ? `${cfg.timeout / 1000}s` : '—'],
              ['Retries',       cfg.retries ?? '—'],
              ['Created',       new Date(agent.createdAt).toLocaleString()],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--gray-100)', fontSize: 14 }}>
                <span style={{ color: 'var(--gray-500)', fontWeight: 500 }}>{label}</span>
                <span style={{ color: 'var(--gray-800)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}>{value as any}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Test selection */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {cfg.test_selection && (
            <div className="card">
              <div className="card-header"><h3>Test Selection</h3></div>
              <div className="card-body">
                {cfg.test_selection.module?.length > 0 && (
                  <div className="form-group">
                    <div className="form-label">Modules</div>
                    <div className="chip-group">
                      {cfg.test_selection.module.map((m: string) => <span key={m} className="chip selected">{m}</span>)}
                    </div>
                  </div>
                )}
                {cfg.test_selection.priority?.length > 0 && (
                  <div className="form-group">
                    <div className="form-label">Priority</div>
                    <div className="chip-group">
                      {cfg.test_selection.priority.map((p: string) => <span key={p} className="chip selected">{p}</span>)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {cfg.reporting && (
            <div className="card">
              <div className="card-header"><h3>Reporting</h3></div>
              <div className="card-body">
                <div className="chip-group">
                  {(cfg.reporting.formats ?? []).map((f: string) => <span key={f} className="badge badge-neutral" style={{ fontSize: 13, padding: '4px 10px' }}>{f}</span>)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* AI-generated tests */}
      {genResult && (
        <div className="card mb-6">
          <div className="card-header">
            <h3>🤖 AI-Generated Tests ({genResult.length})</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => setGenResult(null)}>✕ Dismiss</button>
          </div>
          <div className="card-body">
            {genResult.length === 0 ? (
              <p className="text-muted">No tests were generated. Try providing a more specific description.</p>
            ) : (
              genResult.map((t: any, i: number) => (
                <div key={i} style={{ marginBottom: 16, padding: 14, background: 'var(--gray-50)', borderRadius: 8, border: '1px solid var(--gray-200)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.name || `Test ${i + 1}`}</div>
                  {t.description && <div className="text-sm text-muted mb-4">{t.description}</div>}
                  {t.steps?.length > 0 && (
                    <ol style={{ margin: 0, padding: '0 0 0 20px', fontSize: 13 }}>
                      {t.steps.map((s: any, j: number) => (
                        <li key={j} style={{ marginBottom: 4, color: 'var(--gray-700)' }}>{s.action ?? JSON.stringify(s)}</li>
                      ))}
                    </ol>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div className="card">
        <div className="card-header">
          <h3>Recent Runs</h3>
          <button className="btn btn-primary btn-sm" onClick={startRun} disabled={runLoading}>
            {runLoading ? '…' : '▶ New Run'}
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🚀</div>
            <h3>No runs yet</h3>
            <p>Click "▶ Start Run" to trigger your first automated test execution.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Run ID</th><th>Status</th><th>Passed</th><th>Failed</th><th>Started</th><th></th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/runs/${r.id}`} className="code">{r.id.slice(0, 10)}…</Link></td>
                    <td><span className={statusBadge(r.status)}>{r.status}</span></td>
                    <td className="text-success fw-600">{r.passedTests ?? 0}</td>
                    <td className="text-danger fw-600">{r.failedTests ?? 0}</td>
                    <td className="text-sm text-muted">{new Date(r.startedAt).toLocaleString()}</td>
                    <td><Link href={`/live?runId=${r.id}`} className="btn btn-ghost btn-sm">▶ Live</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
