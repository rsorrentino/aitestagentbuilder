/**
 * Runs list — every test run across agents.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { api, errorMessage, formatDuration, reportUrl, shortId, statusBadge } from '../../lib/api';
import { useRunsChanged } from '../../lib/useRunEvents';

export default function RunsPage() {
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/runs?limit=100');
      setRuns(res.data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useRunsChanged(load);

  return (
    <Layout title="Test Runs" actions={<button className="btn btn-secondary btn-sm" onClick={load}>↻ Refresh</button>}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {loading ? (
        <div className="page-loading"><div className="spinner" /></div>
      ) : runs.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🚀</div>
            <h3>No test runs yet</h3>
            <p>Open an agent and click “▶ Start Run”.</p>
            <Link href="/agents" className="btn btn-primary btn-sm">Go to Agents</Link>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Run</th><th>Agent</th><th>Status</th><th>Passed</th><th>Failed</th><th>Total</th><th>Duration</th><th>Started</th><th></th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/runs/${r.id}`} className="code">{shortId(r.id)}</Link></td>
                    <td><Link href={`/agents/${r.agentId}`}>{r.agentName ?? shortId(r.agentId)}</Link></td>
                    <td><span className={statusBadge(r.status)}>{r.status}</span></td>
                    <td className="text-success fw-600">{r.passedTests}</td>
                    <td className="text-danger fw-600">{r.failedTests}</td>
                    <td>{r.totalTests}</td>
                    <td className="text-sm">{formatDuration(r.duration)}</td>
                    <td className="text-sm text-muted">{new Date(r.startedAt).toLocaleString()}</td>
                    <td>
                      <div className="flex gap-2">
                        {r.status === 'running' || r.status === 'pending'
                          ? <Link href={`/live?runId=${r.id}`} className="btn btn-ghost btn-sm">▶ Live</Link>
                          : <a href={reportUrl(r.id, 'html')} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">📊 Report</a>}
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
