/**
 * Test Run Detail Page with Real-time Updates
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import Link from 'next/link';
import io from 'socket.io-client';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
const WS_URL  = process.env.NEXT_PUBLIC_WS_URL  || 'ws://localhost:3000';

function statusBadge(status: string) {
  const m: Record<string, string> = {
    completed: 'badge badge-success',
    passed:    'badge badge-success',
    running:   'badge badge-warning',
    pending:   'badge badge-info',
    failed:    'badge badge-danger',
    cancelled: 'badge badge-neutral',
    error:     'badge badge-danger',
    skipped:   'badge badge-neutral',
    timeout:   'badge badge-warning',
  };
  return m[status] ?? 'badge badge-neutral';
}

export default function RunDetail() {
  const router = useRouter();
  const { id } = router.query;
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetchRunData();

    const socket = io(WS_URL, { path: '/ws' });

    socket.on('run_progress', (data: any) => {
      if (data.runId === id) setRun((prev: any) => ({ ...prev, ...data }));
    });

    socket.on('test_result', (data: any) => {
      if (data.runId === id) fetchRunData();
    });

    socket.on('run_completed', (data: any) => {
      if (data.runId === id) fetchRunData();
    });

    return () => { socket.disconnect(); };
  }, [id]);

  const fetchRunData = async () => {
    try {
      const response = await axios.get(`${API_URL}/runs/${id}`);
      setRun(response.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const cancelRun = async () => {
    try {
      await axios.post(`${API_URL}/runs/${id}/cancel`);
      await fetchRunData();
    } catch {
      // ignore
    }
  };

  if (loading) return <Layout title="Run Detail"><div className="page-loading"><div className="spinner" /></div></Layout>;
  if (!run) return <Layout title="Run not found"><div className="alert alert-error">Run not found.</div></Layout>;

  const progress = run.totalTests > 0
    ? ((run.passedTests + run.failedTests) / run.totalTests) * 100
    : 0;

  const passRate = (run.passedTests + run.failedTests) > 0
    ? Math.round((run.passedTests / (run.passedTests + run.failedTests)) * 100)
    : null;

  const actions = (
    <>
      <Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>
      <Link href={`/live?runId=${run.id}`} className="btn btn-secondary btn-sm">▶ Live View</Link>
      {run.status === 'running' && (
        <button className="btn btn-danger btn-sm" onClick={cancelRun}>⏹ Cancel</button>
      )}
    </>
  );

  return (
    <Layout title={`Run ${run.id.slice(0, 10)}…`} actions={actions}>
      {/* Stats */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Status</div>
          <div style={{ marginTop: 8 }}><span className={statusBadge(run.status)} style={{ fontSize: 15, padding: '5px 12px' }}>{run.status}</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Tests</div>
          <div className="stat-value">{run.totalTests}</div>
        </div>
        <div className="stat-card success">
          <div className="stat-label">Passed</div>
          <div className="stat-value" style={{ color: 'var(--success)' }}>{run.passedTests}</div>
        </div>
        <div className="stat-card danger">
          <div className="stat-label">Failed</div>
          <div className="stat-value" style={{ color: 'var(--danger)' }}>{run.failedTests}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Duration</div>
          <div className="stat-value" style={{ fontSize: 22 }}>
            {run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '—'}
          </div>
        </div>
        {passRate !== null && (
          <div className="stat-card accent">
            <div className="stat-label">Pass Rate</div>
            <div className="stat-value">{passRate}%</div>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {run.totalTests > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="flex-between mb-4 text-sm text-muted">
            <span>Progress</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="progress-bar-wrap">
            <div
              className={`progress-bar-fill${run.failedTests > 0 && progress === 100 ? ' danger' : progress === 100 ? ' success' : ''}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Metadata */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <div className="card">
          <div className="card-header"><h3>Run Info</h3></div>
          <div className="card-body">
            {[
              ['Run ID',   <span className="code">{run.id}</span>],
              ['Agent ID', <Link href={`/agents/${run.agentId}`} className="code">{run.agentId?.slice(0, 14)}…</Link>],
              ['Started',  new Date(run.startedAt).toLocaleString()],
              ['Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'],
              ['Skipped',  run.skippedTests ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--gray-100)', fontSize: 14 }}>
                <span className="text-muted">{label}</span>
                <span>{value as any}</span>
              </div>
            ))}
          </div>
        </div>
        {run.metadata && Object.keys(run.metadata).length > 0 && (
          <div className="card">
            <div className="card-header"><h3>Metadata</h3></div>
            <div className="card-body">
              {Object.entries(run.metadata).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--gray-100)', fontSize: 14 }}>
                  <span className="text-muted">{k}</span>
                  <span>{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Test results */}
      <div className="card">
        <div className="card-header"><h3>Test Results</h3></div>
        {(!run.results || run.results.length === 0) ? (
          <div className="empty-state">
            <div className="empty-icon">🧪</div>
            <h3>No results yet</h3>
            <p>{run.status === 'running' ? 'Tests are currently executing…' : 'No test results recorded for this run.'}</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Test Case</th><th>Status</th><th>Duration</th><th>Error</th></tr>
              </thead>
              <tbody>
                {run.results.map((result: any) => (
                  <tr key={result.id}>
                    <td className="code" style={{ fontSize: 13 }}>{result.testCaseId}</td>
                    <td><span className={statusBadge(result.status)}>{result.status}</span></td>
                    <td className="text-sm">{result.duration ? `${(result.duration / 1000).toFixed(2)}s` : '—'}</td>
                    <td>
                      {result.error && (
                        <div style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--danger)', fontSize: 12 }}>
                          {result.error}
                        </div>
                      )}
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
