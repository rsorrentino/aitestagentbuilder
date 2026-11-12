/**
 * Requirement coverage: every story / issue linked to tests, with the tests' latest results.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate, statusBadge } from '../lib/api';

const STATES: Record<string, { label: string; badge: string }> = {
  passing: { label: 'Passing', badge: 'badge badge-success' },
  failing: { label: 'Failing', badge: 'badge badge-danger' },
  partial: { label: 'Partly run', badge: 'badge badge-warning' },
  not_run: { label: 'Not run', badge: 'badge badge-neutral' },
};

export default function RequirementsPage() {
  const [data, setData] = useState<{ summary: Record<string, number>; requirements: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/requirements/coverage').then((r) => setData(r.data)).catch((err) => setError(errorMessage(err)));
  }, []);

  const rows = useMemo(() => (data?.requirements ?? []).filter((r) => (!filter || r.state === filter)
    && (!search || `${r.key} ${r.title ?? ''}`.toLowerCase().includes(search.toLowerCase()))), [data, filter, search]);

  return (
    <Layout title="Requirements">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {data && (
        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <div className="stat-card"><div className="stat-label">Covered stories</div><div className="stat-value">{data.summary.requirements}</div></div>
          <div className="stat-card success"><div className="stat-label">Passing</div><div className="stat-value" style={{ color: 'var(--success)' }}>{data.summary.passing}</div></div>
          <div className="stat-card danger"><div className="stat-label">Failing</div><div className="stat-value" style={{ color: 'var(--danger)' }}>{data.summary.failing}</div></div>
          <div className="stat-card"><div className="stat-label">Partly run / not run</div><div className="stat-value">{data.summary.partial + data.summary.not_run}</div></div>
        </div>
      )}

      <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap' }}>
        <input className="form-control" style={{ flex: '1 1 200px', maxWidth: 320 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍  Key or title" aria-label="Search requirements" />
        <select className="form-control" style={{ width: 170 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="State filter">
          <option value="">All states</option>
          {Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      <div className="card">
        {data && data.requirements.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🧭</div>
            <h3>No stories linked yet</h3>
            <p>
              <Link href="/settings/integrations">Import stories from Jira</Link> to have tests written for them, or link existing tests to issues in the test case editor.
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table" data-testid="coverage">
              <thead><tr><th>Story / issue</th><th>State</th><th>Tests (latest result)</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.integrationId}-${r.key}`}>
                    <td>
                      {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="fw-600">{r.key}</a> : <span className="fw-600">{r.key}</span>}
                      {r.title && <div className="text-sm">{r.title}</div>}
                    </td>
                    <td><span className={STATES[r.state]?.badge}>{STATES[r.state]?.label ?? r.state}</span></td>
                    <td className="text-sm">
                      {r.tests.map((t: any) => (
                        <div key={t.id} className="flex gap-2" style={{ alignItems: 'center', marginBottom: 2 }}>
                          <span className={statusBadge(t.status ?? 'pending')}>{t.status ?? 'not run'}</span>
                          <span>{t.title}</span>
                          {t.runId && <Link href={`/runs/${t.runId}`} className="text-muted">{formatDate(t.at)}</Link>}
                        </div>
                      ))}
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
