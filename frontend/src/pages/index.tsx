/**
 * Dashboard — main landing page for AI Test Agent Builder.
 */

import { useState, useEffect } from 'react';
import { api, errorMessage } from '../lib/api';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import ChatPanel from '../components/ChatPanel';


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

export default function Dashboard() {
  const [runs, setRuns] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const router = useRouter();

  const tryDemo = async () => {
    setSeeding(true);
    try {
      const res = await api.post('/demo/seed');
      router.push(`/agents/${res.data.agentId}`);
    } catch (err) {
      setError(errorMessage(err));
      setSeeding(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setError(null);
    try {
      const [runsRes, agentsRes] = await Promise.all([
        api.get(`/runs?limit=10`).catch(() => ({ data: [] })),
        api.get(`/agents?limit=100`).catch(() => ({ data: [] })),
      ]);
      setRuns(Array.isArray(runsRes.data) ? runsRes.data : []);
      setAgents(Array.isArray(agentsRes.data) ? agentsRes.data : []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const totalPassed  = runs.reduce((s, r) => s + (r.passedTests  || 0), 0);
  const totalFailed  = runs.reduce((s, r) => s + (r.failedTests  || 0), 0);
  const passRate     = (totalPassed + totalFailed) > 0
    ? Math.round((totalPassed / (totalPassed + totalFailed)) * 100)
    : null;

  const activeAgents = agents.filter((a) => a.status === 'active').length;

  const headerActions = (
    <>
      <button
        className={`btn ${showChat ? 'btn-secondary' : 'btn-primary'} btn-sm`}
        onClick={() => setShowChat(!showChat)}
      >
        {showChat ? '✕ Close Chat' : '💬 AI Assistant'}
      </button>
      <button className="btn btn-secondary btn-sm" onClick={tryDemo} disabled={seeding}>{seeding ? '…' : '🎮 Try the demo'}</button>
      <Link href="/agents/new" className="btn btn-primary btn-sm">＋ New Agent</Link>
    </>
  );

  if (loading) {
    return (
      <Layout title="Dashboard">
        <div className="page-loading"><div className="spinner" /><span>Loading…</span></div>
      </Layout>
    );
  }

  return (
    <Layout title="Dashboard" actions={headerActions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {/* AI Chat Panel */}
      {showChat && (
        <div style={{ marginBottom: 24 }}>
          <ChatPanel
            agentContext={{ agents: agents.slice(0, 3), recentRuns: runs.slice(0, 3) }}
          />
        </div>
      )}

      {/* KPI strip */}
      <div className="stat-grid">
        <div className="stat-card accent">
          <div className="stat-label">Total Agents</div>
          <div className="stat-value">{agents.length}</div>
          <div className="stat-sub">{activeAgents} active</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Recent Runs</div>
          <div className="stat-value">{runs.length}</div>
          <div className="stat-sub">last 10</div>
        </div>
        <div className="stat-card success">
          <div className="stat-label">Tests Passed</div>
          <div className="stat-value">{totalPassed}</div>
          <div className="stat-sub">across recent runs</div>
        </div>
        <div className="stat-card danger">
          <div className="stat-label">Tests Failed</div>
          <div className="stat-value">{totalFailed}</div>
          <div className="stat-sub">
            {passRate !== null ? `${passRate}% pass rate` : 'no data yet'}
          </div>
        </div>
      </div>

      {/* Two-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>
        {/* Recent test runs */}
        <div className="card">
          <div className="card-header">
            <h3>Recent Test Runs</h3>
            <Link href="/runs" className="btn btn-ghost btn-sm">All runs →</Link>
          </div>
          <div className="table-wrapper">
            {runs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🚀</div>
                <h3>No test runs yet</h3>
                <p>Create an agent and trigger your first automated test run — or load the built-in demo app with ready-made tests.</p>
                <div className="flex gap-3">
                  <button className="btn btn-primary btn-sm" onClick={tryDemo} disabled={seeding}>{seeding ? 'Loading…' : '🎮 Try the demo'}</button>
                  <Link href="/agents/new" className="btn btn-secondary btn-sm">Create Agent</Link>
                </div>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Passed</th>
                    <th>Failed</th>
                    <th>Started</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link href={`/runs/${run.id}`}>{run.agentName ?? 'Run'}</Link>
                      </td>
                      <td><span className={statusBadge(run.status)}>{run.status}</span></td>
                      <td className="text-success fw-600">{run.passedTests ?? 0}</td>
                      <td className="text-danger fw-600">{run.failedTests ?? 0}</td>
                      <td className="text-sm text-muted">{new Date(run.startedAt).toLocaleString()}</td>
                      <td>
                        <Link href={run.status === 'running' || run.status === 'pending' ? `/live?runId=${run.id}` : `/runs/${run.id}`} className="btn btn-ghost btn-sm">{run.status === 'running' || run.status === 'pending' ? '▶ Live' : 'Details'}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Quick actions */}
          <div className="card">
            <div className="card-header"><h3>Quick Actions</h3></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Link href="/agents" className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}>
                🤖 Manage Agents
              </Link>
              <Link href="/wizard/salesforce" className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}>
                ⚡ Salesforce Quick-Start
              </Link>
              <Link href="/documents" className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}>
                📄 Upload Test Book
              </Link>
              <Link href="/testcases" className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}>
                🧪 Browse Test Cases
              </Link>
              <Link href="/settings/ai-providers" className="btn btn-secondary" style={{ justifyContent: 'flex-start' }}>
                ⚙️ AI Provider Health
              </Link>
            </div>
          </div>

          {/* Agents list */}
          <div className="card">
            <div className="card-header">
              <h3>Agents</h3>
              <Link href="/agents" className="btn btn-ghost btn-sm">View all →</Link>
            </div>
            {agents.length === 0 ? (
              <div className="empty-state" style={{ padding: '30px 20px' }}>
                <div className="empty-icon">🤖</div>
                <h3>No agents yet</h3>
                <p>Create your first agent to start automated testing.</p>
                <Link href="/agents/new" className="btn btn-primary btn-sm">Create Agent</Link>
              </div>
            ) : (
              <div className="card-body" style={{ padding: 0 }}>
                {agents.slice(0, 5).map((agent, i) => (
                  <Link
                    href={`/agents/${agent.id}`}
                    key={agent.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 18px',
                      color: 'inherit',
                      borderBottom: i < Math.min(agents.length, 5) - 1 ? '1px solid var(--gray-100)' : 'none',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.name}
                      </div>
                      <div className="text-sm text-muted">{agent.config?.base_url}</div>
                    </div>
                    <span className={statusBadge(agent.status)}>{agent.status}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

