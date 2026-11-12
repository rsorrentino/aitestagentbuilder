/**
 * App map: explore an agent's application as a test user, see its screens and elements, add
 * them to the library and create tests for screens no test visits yet.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../components/Layout';
import { refreshLibrary } from '../components/StepsEditor';
import { api, errorMessage, formatDate } from '../lib/api';
import { useSession } from '../lib/session';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function DiscoveryPage() {
  const session = useSession();
  const canEdit = session.can('editor');
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [form, setForm] = useState({ loginAs: '', maxPages: '25', maxDepth: '3', startPaths: '', exclude: '' });
  const [history, setHistory] = useState<any[]>([]);
  const [current, setCurrent] = useState<any | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pickedEls, setPickedEls] = useState<Set<string>>(new Set());
  const [pickedTests, setPickedTests] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const agent = agents.find((a) => a.id === agentId);
  const identities: string[] = [
    ...(agent?.config?.auth?.profiles ?? []).map((p: any) => p.name),
    ...(agent?.config?.salesforce?.personas ?? []).map((p: any) => p.name),
  ];

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.get('/discoveries')).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    api.get('/agents').then((r) => {
      setAgents(r.data);
      if (r.data[0]) setAgentId((cur) => cur || r.data[0].id);
    }).catch(() => undefined);
    loadHistory();
  }, [loadHistory]);

  const show = useCallback(async (id: string) => {
    const d = (await api.get(`/discoveries/${id}`)).data;
    setCurrent(d);
    if (d.status !== 'running') {
      setPickedEls(new Set(d.pages.filter((p: any) => !p.covered).flatMap((p: any) => p.elements.map((e: any) => e.name))));
      setPickedTests(new Set(d.proposals.map((_p: any, i: number) => i)));
    }
    return d;
  }, []);

  // Follow a running discovery
  useEffect(() => {
    if (!current || current.status !== 'running') return undefined;
    const t = setInterval(async () => {
      const d = await show(current.id).catch(() => null);
      if (d && d.status !== 'running') loadHistory();
    }, 1500);
    return () => clearInterval(t);
  }, [current, show, loadHistory]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const d = (await api.post(`/agents/${agentId}/discover`, {
        maxPages: Number(form.maxPages), maxDepth: Number(form.maxDepth), ...(form.loginAs ? { loginAs: form.loginAs } : {}),
        startPaths: list(form.startPaths), exclude: list(form.exclude),
      })).data;
      setCurrent(d);
      loadHistory();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const saveElements = async () => {
    setError(null);
    try {
      const r = (await api.post(`/discoveries/${current.id}/elements`, { names: [...pickedEls] })).data;
      await refreshLibrary();
      setNotice(`Added ${r.created.length} element(s) to the library${r.skipped.length ? `; ${r.skipped.length} already there` : ''}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const createTests = async () => {
    setError(null);
    try {
      const r = (await api.post(`/discoveries/${current.id}/tests`, { indexes: [...pickedTests] })).data;
      await refreshLibrary();
      setNotice(`Created ${r.tests.length} test(s) (tag “discovered”)${r.elements.length ? ` and ${r.elements.length} element(s) they use` : ''}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  return (
    <Layout title="App map">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice} <Link href="/testcases">Test cases →</Link> · <Link href="/library">Library →</Link></div>}

      {canEdit && (
        <form className="card mb-6" onSubmit={start} data-testid="discover-form">
          <div className="card-header"><h3>🗺️ Explore an application</h3></div>
          <div className="card-body">
            <p className="text-sm text-muted mb-3">
              Signs in as a test user, follows the application&apos;s links and maps each screen once per kind of page (/orders/123 and /orders/456 are one screen).
              It never follows sign-out or destructive links (delete, remove, cancel, unsubscribe), other sites, files or Salesforce Setup, and does not submit forms.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-agent">Agent</label>
                <select id="dsc-agent" className="form-control" value={agentId} onChange={(e) => { setAgentId(e.target.value); setForm((f) => ({ ...f, loginAs: '' })); }}>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-login">Sign in as</label>
                <select id="dsc-login" className="form-control" value={form.loginAs} onChange={(e) => setForm({ ...form, loginAs: e.target.value })}>
                  <option value="">{identities.length ? 'The agent’s default user' : 'Nobody (public pages)'}</option>
                  {identities.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-pages">Screens at most</label>
                <input id="dsc-pages" type="number" min={1} max={200} className="form-control" value={form.maxPages} onChange={(e) => setForm({ ...form, maxPages: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-depth">Clicks deep</label>
                <input id="dsc-depth" type="number" min={0} max={6} className="form-control" value={form.maxDepth} onChange={(e) => setForm({ ...form, maxDepth: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-start">Start at</label>
                <input id="dsc-start" className="form-control" value={form.startPaths} onChange={(e) => setForm({ ...form, startPaths: e.target.value })} placeholder="/ (or /lightning/page/home, /app)" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="dsc-exclude">Skip</label>
                <input id="dsc-exclude" className="form-control" value={form.exclude} onChange={(e) => setForm({ ...form, exclude: e.target.value })} placeholder="/admin/*, /reports/*" />
              </div>
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!agentId || current?.status === 'running'}>Explore</button>
          </div>
        </form>
      )}

      {current && (
        <div className="card mb-6" data-testid="discovery">
          <div className="card-header">
            <h3>{agents.find((a) => a.id === current.agentId)?.name ?? 'Discovery'} · {formatDate(current.startedAt)}</h3>
            <span className={`badge ${current.status === 'completed' ? 'badge-success' : current.status === 'running' ? 'badge-info' : 'badge-danger'}`}>{current.status}</span>
          </div>
          <div className="card-body">
            {current.status === 'running' && (
              <div className="flex gap-3" style={{ alignItems: 'center' }}>
                <span>Exploring… {current.progress?.pages ?? 0} screen(s) mapped{current.progress?.current ? `, now ${current.progress.current}` : ''}</span>
                {canEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.post(`/discoveries/${current.id}/cancel`)}>Stop</button>}
              </div>
            )}
            {current.error && <div className="alert alert-error">⚠️ {current.error}</div>}
            {current.status !== 'running' && current.pages.length > 0 && (
              <>
                <p className="text-sm mb-3" data-testid="discovery-summary">
                  {current.pages.length} screen(s){current.signedInAs ? ` as ${current.signedInAs}` : ''}; {current.pages.filter((p: any) => p.covered).length} already visited by tests.
                  {Object.keys(current.skipped ?? {}).length > 0 && <> Not followed: {Object.entries(current.skipped).map(([k, v]) => `${v} ${k}`).join(', ')}.</>}
                </p>
                <div className="table-wrapper mb-4">
                  <table className="data-table" data-testid="screens">
                    <thead><tr><th>Screen</th><th>Page</th><th>Elements</th><th>Tests</th></tr></thead>
                    <tbody>
                      {current.pages.map((p: any) => (
                        <Fragment key={p.pattern}>
                          <tr>
                            <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === p.pattern ? null : p.pattern)}>{open === p.pattern ? '▾' : '▸'} {p.heading || p.title || p.name}</button></td>
                            <td className="text-sm"><a href={p.url} target="_blank" rel="noreferrer"><code>{p.pattern}</code></a></td>
                            <td className="text-sm">{p.elements.length}</td>
                            <td>{p.covered ? <span className="badge badge-success">tested</span> : <span className="badge badge-warning">no test yet</span>}</td>
                          </tr>
                          {open === p.pattern && (
                            <tr><td colSpan={4}>
                              {p.elements.length === 0 ? <span className="text-sm text-muted">No named elements found.</span> : p.elements.map((e: any) => (
                                <label key={e.name} className="flex gap-2 text-sm" style={{ alignItems: 'center' }}>
                                  <input type="checkbox" checked={pickedEls.has(e.name)} onChange={() => setPickedEls((s) => toggle(s, e.name))} />
                                  <code>{`{{el.${e.name}}}`}</code> <span className="text-muted">{e.locator}</span>
                                </label>
                              ))}
                            </td></tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
                {canEdit && <button type="button" className="btn btn-secondary btn-sm mb-4" onClick={saveElements} disabled={!pickedEls.size}>Add {pickedEls.size} element(s) to the library</button>}

                <h4 className="mb-2">Proposed tests ({current.proposals.length})</h4>
                {current.proposals.length === 0 ? <p className="text-sm text-muted">Every screen found is already visited by a test.</p> : (
                  <div data-testid="proposals">
                    {current.proposals.map((t: any, i: number) => (
                      <label key={i} className="flex gap-2 text-sm mb-2" style={{ alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={pickedTests.has(i)} onChange={() => setPickedTests((s) => toggle(s, i))} />
                        <span>
                          <span className="fw-600">{t.title}</span> {t.source === 'ai' && <span className="badge badge-info">AI</span>}
                          <span className="text-muted"> — {t.steps.map((s: any) => `${s.action}${s.target ? ` ${s.target}` : ''}`).join(' → ')}</span>
                        </span>
                      </label>
                    ))}
                    {canEdit && <button type="button" className="btn btn-primary btn-sm" onClick={createTests} disabled={!pickedTests.size}>Create {pickedTests.size} test(s)</button>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header"><h3>Earlier explorations</h3></div>
        {history.length === 0 ? <div className="card-body text-sm text-muted">None yet.</div> : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>When</th><th>Agent</th><th>Status</th><th>Screens</th><th>Proposed tests</th><th></th></tr></thead>
              <tbody>
                {history.map((d) => (
                  <tr key={d.id}>
                    <td className="text-sm">{formatDate(d.startedAt)}</td>
                    <td className="text-sm">{agents.find((a) => a.id === d.agentId)?.name ?? d.agentId}</td>
                    <td><span className={`badge ${d.status === 'completed' ? 'badge-success' : d.status === 'running' ? 'badge-info' : 'badge-danger'}`}>{d.status}</span></td>
                    <td className="text-sm">{d.pageCount}</td>
                    <td className="text-sm">{d.proposalCount}</td>
                    <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => show(d.id)}>Open</button></td>
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
