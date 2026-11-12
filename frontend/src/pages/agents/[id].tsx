/**
 * Agent Detail — configuration, the tests a run will execute, AI test
 * generation, and run history.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';
import {
  api, errorMessage, formatDuration, priorityBadge, reportUrl, shortId, statusBadge,
} from '../../lib/api';
import { useRunsChanged } from '../../lib/useRunEvents';
import { useSession } from '../../lib/session';
import AgentSecretsCard from '../../components/AgentSecretsCard';
import SalesforcePersonasCard from '../../components/SalesforcePersonasCard';
import AgentQualityCard from '../../components/AgentQualityCard';
import ApiTestsCard from '../../components/ApiTestsCard';
import PageSpeedCard from '../../components/PageSpeedCard';
import SignInCard from '../../components/SignInCard';

export default function AgentDetailPage() {
  const router = useRouter();
  const id = router.query.id as string | undefined;
  const session = useSession();
  const canEdit = session.can('editor');

  const [agent, setAgent] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [showGen, setShowGen] = useState(false);
  const [genDescription, setGenDescription] = useState('');
  const [genCount, setGenCount] = useState(5);
  const [genLoading, setGenLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!id) return;
    try {
      const [agentRes, planRes, runsRes] = await Promise.all([
        api.get(`/agents/${id}`),
        api.get(`/agents/${id}/plan`),
        api.get(`/runs?agentId=${id}&limit=20`),
      ]);
      setAgent(agentRes.data);
      setPlan(planRes.data);
      setRuns(runsRes.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useRunsChanged(() => {
    if (id) api.get(`/runs?agentId=${id}&limit=20`).then((r) => setRuns(r.data)).catch(() => undefined);
  });

  const startRun = async () => {
    setRunLoading(true);
    setError(null);
    try {
      const res = await api.post('/runs', { agentId: id });
      router.push(`/live?runId=${res.data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setRunLoading(false);
    }
  };

  const generateTests = async () => {
    setGenLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post(`/agents/${id}/generate-tests`, { description: genDescription, count: genCount });
      setNotice(`🤖 ${res.data.count} test case(s) generated with ${res.data.provider}${res.data.pageCaptured ? ' from the live page' : ''} and saved.`);
      setShowGen(false);
      await fetchAll();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGenLoading(false);
    }
  };

  const toggleStatus = async () => {
    try {
      const res = await api.put(`/agents/${id}`, { status: agent.status === 'active' ? 'inactive' : 'active' });
      setAgent(res.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const actions = (
    <>
      <Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>
      {agent && canEdit && (
        <>
          <Link href="/schedules" className="btn btn-secondary btn-sm">⏰ Schedule</Link>
          {canEdit && <Link href={`/recorder?agentId=${agent.id}`} className="btn btn-secondary btn-sm">⏺ Record a test</Link>}
          <button className="btn btn-secondary btn-sm" onClick={() => setShowGen(!showGen)}>🤖 Generate Tests</button>
          <button className="btn btn-primary btn-sm" onClick={startRun} disabled={runLoading || agent.status !== 'active' || !plan?.count}>
            {runLoading ? 'Starting…' : '▶ Start Run'}
          </button>
        </>
      )}
    </>
  );

  if (loading) return <Layout title="Agent"><div className="page-loading"><div className="spinner" /></div></Layout>;
  if (!agent) return <Layout title="Agent not found" actions={<Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>}><div className="alert alert-error">{error ?? 'Agent not found.'}</div></Layout>;

  const cfg = agent.config ?? {};
  const sel = cfg.test_selection ?? {};
  const selection = [
    sel.module?.length ? `modules: ${sel.module.join(', ')}` : null,
    sel.priority?.length ? `priority: ${sel.priority.join(', ')}` : null,
    sel.tags?.length ? `tags: ${sel.tags.join(', ')}` : null,
  ].filter(Boolean).join(' · ') || 'all test cases';

  return (
    <Layout title={agent.name} actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {showGen && (
        <div className="card mb-6" style={{ borderColor: 'var(--brand-200)' }}>
          <div className="card-header"><h3>🤖 Generate tests with AI</h3></div>
          <div className="card-body">
            <p className="form-hint mb-4">The AI opens {cfg.base_url}, reads its interactive elements and writes executable tests. They are saved to Test Cases.</p>
            <div className="form-group">
              <label className="form-label" htmlFor="gen-desc">What should be tested?</label>
              <textarea id="gen-desc" className="form-control" rows={3} value={genDescription} onChange={(e) => setGenDescription(e.target.value)}
                placeholder="e.g. Login with valid and invalid credentials, and the password reset link" />
            </div>
            <div className="form-group" style={{ maxWidth: 160 }}>
              <label className="form-label" htmlFor="gen-count">How many tests</label>
              <input id="gen-count" type="number" min={1} max={20} className="form-control" value={genCount} onChange={(e) => setGenCount(+e.target.value)} />
            </div>
            <div className="flex gap-3">
              <button className="btn btn-primary btn-sm" onClick={generateTests} disabled={genLoading}>
                {genLoading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Generating (this can take a minute)…</> : 'Generate & save'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowGen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3>Configuration</h3>
            <button className={`btn btn-sm ${agent.status === 'active' ? 'btn-ghost' : 'btn-secondary'}`} onClick={toggleStatus} title="Toggle active" disabled={!canEdit}>
              <span className={statusBadge(agent.status)}>{agent.status}</span>
            </button>
          </div>
          <div className="card-body">
            {([
              ['Base URL', <a key="u" href={cfg.base_url} target="_blank" rel="noreferrer">{cfg.base_url}</a>],
              ['Environment', cfg.environment ?? '—'],
              ['Test selection', selection],
              ['AI provider', cfg.ai?.provider || 'automatic'],
              ['Self-healing', cfg.ai?.self_healing ? 'enabled' : 'disabled'],
              ['Retries', cfg.retries ?? 0],
              ['Created', new Date(agent.createdAt).toLocaleString()],
            ] as [string, any][]).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--gray-100)', fontSize: 14 }}>
                <span style={{ color: 'var(--gray-500)', fontWeight: 500 }}>{label}</span>
                <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Tests in the next run ({plan?.count ?? 0})</h3>
            <Link href="/testcases" className="btn btn-ghost btn-sm">Manage →</Link>
          </div>
          {!plan?.count ? (
            <div className="empty-state" style={{ padding: '28px 20px' }}>
              <div className="empty-icon">🧪</div>
              <h3>No matching test cases</h3>
              <p>Generate tests with AI, extract them from a document, or create one manually.</p>
              <div className="flex gap-3">
                <button className="btn btn-primary btn-sm" onClick={() => setShowGen(true)}>🤖 Generate</button>
                <Link href="/documents" className="btn btn-secondary btn-sm">📄 Documents</Link>
              </div>
            </div>
          ) : (
            <div className="card-body" style={{ padding: 0, maxHeight: 340, overflowY: 'auto' }}>
              {plan.testCases.map((tc: any) => (
                <div key={tc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid var(--gray-100)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fw-600" style={{ fontSize: 14 }}>{tc.title}</div>
                    <div className="text-sm text-muted">{tc.module} · {tc.steps} steps</div>
                  </div>
                  <span className={priorityBadge(tc.priority)}>{tc.priority}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AgentSecretsCard agentId={agent.id} secrets={cfg.secrets ?? {}} canEdit={session.can('admin')} onSaved={setAgent} />

      <ApiTestsCard key={`api-${agent.id}`} agentId={agent.id} config={cfg} canEdit={canEdit} onSaved={setAgent} />
      <PageSpeedCard key={`speed-${agent.id}`} agentId={agent.id} config={cfg} canEdit={canEdit} onSaved={setAgent} />

      <AgentQualityCard key={`quality-${agent.id}`} agentId={agent.id} config={cfg} canEdit={canEdit} onSaved={setAgent} />

      <SignInCard key={`signin-${agent.id}`} agentId={agent.id} config={cfg} canAdmin={session.can('admin')} canEdit={canEdit} onSaved={setAgent} />

      <SalesforcePersonasCard
        key={agent.id}
        agentId={agent.id}
        baseUrl={cfg.base_url}
        salesforce={cfg.salesforce}
        canAdmin={session.can('admin')}
        canVerify={canEdit}
        onSaved={setAgent}
      />

      <div className="card">
        <div className="card-header"><h3>Recent Runs</h3></div>
        {runs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🚀</div>
            <h3>No runs yet</h3>
            <p>Click “▶ Start Run” to execute the tests above in a real browser.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Run</th><th>Status</th><th>Passed</th><th>Failed</th><th>Duration</th><th>Started</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/runs/${r.id}`} className="code">{shortId(r.id)}</Link></td>
                    <td><span className={statusBadge(r.status)}>{r.status}</span></td>
                    <td className="text-success fw-600">{r.passedTests}</td>
                    <td className="text-danger fw-600">{r.failedTests}</td>
                    <td className="text-sm">{formatDuration(r.duration)}</td>
                    <td className="text-sm text-muted">{new Date(r.startedAt).toLocaleString()}</td>
                    <td>
                      {r.status === 'running' || r.status === 'pending'
                        ? <Link href={`/live?runId=${r.id}`} className="btn btn-ghost btn-sm">▶ Live</Link>
                        : <a href={reportUrl(r.id, 'html')} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">📊 Report</a>}
                    </td>
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
