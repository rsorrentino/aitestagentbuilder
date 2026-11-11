/**
 * Audit Log — who did what, when. Project admins see their project;
 * administrators can switch to the whole installation.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate } from '../lib/api';
import { useSession } from '../lib/session';

const PAGE = 50;

export default function AuditPage() {
  const session = useSession();
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; entries: any[] }>({ total: 0, entries: [] });
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const query = useCallback((format?: 'csv') => {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    if (format) params.set('format', format);
    else {
      params.set('limit', String(PAGE));
      params.set('offset', String(offset));
    }
    return `${scope === 'all' ? '/admin/audit' : '/audit'}?${params}`;
  }, [action, from, to, offset, scope]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData((await api.get(query())).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    try {
      const res = await api.get(query('csv'), { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!session.loading && !session.can('admin')) {
    return <Layout title="Audit Log"><div className="alert alert-error">The audit log requires the project “admin” role.</div></Layout>;
  }

  const actions = <button className="btn btn-secondary btn-sm" onClick={exportCsv}>⬇ Export CSV</button>;

  return (
    <Layout title="Audit Log" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
        {session.isAdmin && (
          <div>
            <label className="form-label" htmlFor="audit-scope">Scope</label>
            <select id="audit-scope" className="form-control" value={scope} onChange={(e) => { setScope(e.target.value as any); setOffset(0); }}>
              <option value="project">This project</option>
              <option value="all">Whole installation</option>
            </select>
          </div>
        )}
        <div>
          <label className="form-label" htmlFor="audit-action">Action starts with</label>
          <input id="audit-action" className="form-control" value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} placeholder="e.g. agent. or auth.login" />
        </div>
        <div>
          <label className="form-label" htmlFor="audit-from">From</label>
          <input id="audit-from" type="date" className="form-control" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} />
        </div>
        <div>
          <label className="form-label" htmlFor="audit-to">To</label>
          <input id="audit-to" type="date" className="form-control" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} />
        </div>
        <span className="text-sm text-muted">{data.total} entries</span>
      </div>

      <div className="card">
        <div className="table-wrapper">
          <table className="data-table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
            <tbody>
              {data.entries.length === 0 && <tr><td colSpan={5} className="text-muted">No entries.</td></tr>}
              {data.entries.map((e) => (
                <Fragment key={e.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <td className="text-sm">{formatDate(e.at)}</td>
                    <td className="text-sm">{e.userEmail ?? '—'}</td>
                    <td><span className={/failed|locked|delete|revoke/.test(e.action) ? 'badge badge-warning' : 'badge badge-neutral'}>{e.action}</span></td>
                    <td className="text-sm code">{e.entityType ? `${e.entityType}:` : ''}{e.entityId ?? ''}</td>
                    <td className="text-sm text-muted">{e.ip ?? ''}</td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={5} style={{ background: 'var(--gray-50)' }}>
                        <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify({ project: e.projectId, status: e.status, userAgent: e.userAgent, details: e.details }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body flex gap-3" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
          <button className="btn btn-secondary btn-sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
        </div>
      </div>
    </Layout>
  );
}
