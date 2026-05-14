/**
 * Agents List Page — view and manage all test agents.
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

function statusBadge(status: string) {
  if (status === 'active')   return 'badge badge-success';
  if (status === 'inactive') return 'badge badge-neutral';
  if (status === 'archived') return 'badge badge-warning';
  return 'badge badge-neutral';
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => { fetchAgents(); }, []);

  const fetchAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/agents?limit=100`);
      setAgents(Array.isArray(res.data) ? res.data : []);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteAgent = async (id: string) => {
    if (!confirm('Are you sure you want to delete this agent?')) return;
    setDeletingId(id);
    try {
      await axios.delete(`${API_URL}/agents/${id}`);
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const platformIcon = (config: any) => {
    if (config?.platform === 'salesforce') return '☁️';
    if (config?.application_type === 'api')    return '🔗';
    if (config?.application_type === 'mobile') return '📱';
    return '🌐';
  };

  const actions = (
    <Link href="/agents/new" className="btn btn-primary btn-sm">＋ New Agent</Link>
  );

  return (
    <Layout title="Agents" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {loading ? (
        <div className="page-loading"><div className="spinner" /><span>Loading agents…</span></div>
      ) : agents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🤖</div>
            <h3>No agents yet</h3>
            <p>
              An agent defines <em>what</em> to test and <em>how</em> — which application,
              which modules, and which AI provider to use. Create your first agent to get started.
            </p>
            <div className="flex gap-3">
              <Link href="/agents/new" className="btn btn-primary">＋ Create Agent</Link>
              <Link href="/wizard/salesforce" className="btn btn-secondary">⚡ Salesforce Wizard</Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Type</th>
                  <th>AI Provider</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>{platformIcon(agent.config)}</span>
                        <div>
                          <Link href={`/agents/${agent.id}`} style={{ fontWeight: 600, color: 'var(--gray-900)' }}>
                            {agent.name}
                          </Link>
                          <div className="text-sm text-muted code">{agent.id.slice(0, 10)}…</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{agent.config?.application_type ?? '—'}</span>
                      {agent.config?.platform === 'salesforce' && (
                        <span className="badge badge-info" style={{ marginLeft: 4 }}>salesforce</span>
                      )}
                    </td>
                    <td className="text-sm">{agent.config?.ai?.provider ?? '—'}</td>
                    <td><span className={statusBadge(agent.status)}>{agent.status}</span></td>
                    <td className="text-sm text-muted">{new Date(agent.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="flex gap-2">
                        <Link href={`/agents/${agent.id}`} className="btn btn-secondary btn-sm">View</Link>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => deleteAgent(agent.id)}
                          disabled={deletingId === agent.id}
                        >
                          {deletingId === agent.id ? '…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
