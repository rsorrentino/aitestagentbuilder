/**
 * Mock APIs: stand-ins for services that do not exist yet, cannot be reached from the test
 * environment, or must answer in a particular way (errors, slow answers).
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { API_URL, api, errorMessage, formatDate } from '../lib/api';
import { useSession } from '../lib/session';

interface RouteRow { method: string; path: string; status: string; body: string; delay: string }
const blankRoute: RouteRow = { method: 'GET', path: '/', status: '200', body: '{"ok": true}', delay: '' };
const toRows = (routes: any[]): RouteRow[] => routes.map((r) => ({ method: r.method, path: r.path, status: String(r.status ?? 200), body: r.body === undefined ? '' : JSON.stringify(r.body), delay: r.delay_ms ? String(r.delay_ms) : '' }));
const origin = API_URL.replace(/\/api\/v\d+\/?$/, '');

function RoutesEditor({ rows, setRows }: { rows: RouteRow[]; setRows: (f: (r: RouteRow[]) => RouteRow[]) => void }) {
  const set = (i: number, patch: Partial<RouteRow>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 mb-2" style={{ flexWrap: 'wrap' }} data-testid="route-row">
          <select className="form-control" style={{ width: 100 }} value={r.method} onChange={(e) => set(i, { method: e.target.value })} aria-label="Method">
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'].map((m) => <option key={m}>{m}</option>)}
          </select>
          <input className="form-control" style={{ width: 200 }} value={r.path} onChange={(e) => set(i, { path: e.target.value })} aria-label="Path" placeholder="/orders/{id}" />
          <input className="form-control" style={{ width: 80 }} value={r.status} onChange={(e) => set(i, { status: e.target.value })} aria-label="Status" />
          <input className="form-control" style={{ flex: '1 1 240px' }} value={r.body} onChange={(e) => set(i, { body: e.target.value })} aria-label="Body (JSON)" placeholder='{"id": 1}' />
          <input className="form-control" style={{ width: 100 }} value={r.delay} onChange={(e) => set(i, { delay: e.target.value })} aria-label="Delay (ms)" placeholder="delay ms" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((rs) => rs.filter((_x, n) => n !== i))} aria-label="Remove route">✕</button>
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { ...blankRoute }])}>＋ Route</button>
    </div>
  );
}

const rowsToRoutes = (rows: RouteRow[]) => rows.filter((r) => r.path.trim()).map((r) => {
  let body: any;
  if (r.body.trim()) {
    try { body = JSON.parse(r.body); } catch { body = r.body; }
  }
  return { method: r.method, path: r.path.trim(), status: Number(r.status) || 200, ...(body !== undefined ? { body } : {}), ...(r.delay ? { delay_ms: Number(r.delay) } : {}) };
});

export default function MocksPage() {
  const session = useSession();
  const canEdit = session.can('editor');
  const [services, setServices] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [editRoutes, setEditRoutes] = useState<RouteRow[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setServices((await api.get('/mock-services')).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const s = (await api.post('/mock-services', { name, ...(spec.trim() ? { spec } : {}), ...(specUrl.trim() ? { specUrl } : {}), routes: rowsToRoutes(routes) })).data;
      setName(''); setSpec(''); setSpecUrl(''); setRoutes([]);
      setNotice(`Mock “${s.name}” answers at ${origin}${s.path}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const openService = async (s: any) => {
    if (open === s.id) return setOpen(null);
    setOpen(s.id);
    setEditRoutes(toRows(s.routes));
    setRequests((await api.get(`/mock-services/${s.id}/requests`)).data);
  };

  return (
    <Layout title="Mock APIs">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success" data-testid="mock-notice">{notice}</div>}
      {canEdit && (
        <form className="card mb-6" onSubmit={create} data-testid="mock-form">
          <div className="card-header"><h3>＋ New mock API</h3></div>
          <div className="card-body">
            <p className="text-sm text-muted mb-3">
              A stand-in for a service: point the application under test at its address. It answers with fixed routes, else with the examples (or generated
              values) of its OpenAPI description. Tests can make the next call fail (<code>mock_service_respond</code>) and check what the application sent
              (<code>assert_mock_service_called</code>).
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="mock-name">Name *</label>
              <input id="mock-name" className="form-control" style={{ maxWidth: 320 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments" required />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="mock-spec">OpenAPI description (JSON or YAML)</label>
                <textarea id="mock-spec" className="form-control" rows={5} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="openapi: 3.0.3 …" style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="mock-spec-url">or its URL</label>
                <input id="mock-spec-url" className="form-control" value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" />
              </div>
            </div>
            <div className="form-group">
              <div className="form-label">Fixed routes (checked first)</div>
              <RoutesEditor rows={routes} setRows={setRoutes} />
            </div>
            <button type="submit" className="btn btn-primary btn-sm">Create mock</button>
          </div>
        </form>
      )}

      <div className="card">
        <div className="card-header"><h3>Mock APIs</h3></div>
        {services.length === 0 ? <div className="card-body text-sm text-muted">None yet.</div> : (
          <div className="table-wrapper">
            <table className="data-table" data-testid="mocks">
              <thead><tr><th>Mock</th><th>Address</th><th>Answers</th><th></th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <Fragment key={s.id}>
                    <tr>
                      <td className="fw-600">{s.name}</td>
                      <td className="text-sm"><code data-testid="mock-address">{`${origin}${s.path}`}</code></td>
                      <td className="text-sm">{s.operations.length} from the spec, {s.routes.length} fixed route(s)</td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => openService(s)}>{open === s.id ? 'Close' : 'Open'}</button>
                          {canEdit && <button className="btn btn-danger btn-sm" onClick={() => confirm(`Delete mock “${s.name}”?`) && api.delete(`/mock-services/${s.id}`).then(load)}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                    {open === s.id && (
                      <tr><td colSpan={4} style={{ background: 'var(--gray-50)' }}>
                        {s.operations.length > 0 && <p className="text-sm"><span className="fw-600">From the spec:</span> {s.operations.join(' · ')}</p>}
                        <div className="form-label mt-2">Fixed routes</div>
                        <RoutesEditor rows={editRoutes} setRows={setEditRoutes} />
                        {canEdit && (
                          <button className="btn btn-primary btn-sm mt-2" onClick={async () => {
                            try {
                              await api.put(`/mock-services/${s.id}`, { routes: rowsToRoutes(editRoutes) });
                              setNotice(`Routes of “${s.name}” saved.`);
                              await load();
                            } catch (err) {
                              setError(errorMessage(err));
                            }
                          }}>Save routes</button>
                        )}
                        <div className="form-label mt-4">Latest requests <button className="btn btn-ghost btn-sm" onClick={async () => setRequests((await api.get(`/mock-services/${s.id}/requests`)).data)}>↻</button></div>
                        {requests.length === 0 ? <p className="text-sm text-muted">No requests yet (kept in memory, the last 200).</p> : (
                          <table className="data-table text-sm" data-testid="mock-requests">
                            <tbody>
                              {requests.slice(0, 30).map((c, i) => (
                                <tr key={i}><td>{formatDate(c.at)}</td><td><code>{c.method} {c.path}</code></td><td>{c.status}</td><td className="text-muted">{c.source}</td><td className="text-muted">{c.body ? JSON.stringify(c.body).slice(0, 120) : ''}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td></tr>
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
