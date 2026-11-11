/**
 * Test Cases — browse, filter, create, edit and delete test cases.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../../components/Layout';
import TestCaseEditor from '../../components/TestCaseEditor';
import { api, errorMessage, PRIORITIES, priorityBadge } from '../../lib/api';

export default function TestCasesPage() {
  const [cases, setCases] = useState<any[]>([]);
  const [modules, setModules] = useState<{ module: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('');
  const [module, setModule] = useState('');
  const [editing, setEditing] = useState<any | null>(null); // {} = new
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchCases = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '1000' });
      if (search.trim()) params.set('q', search.trim());
      if (priority) params.set('priority', priority);
      if (module) params.set('module', module);
      const [res, mods] = await Promise.all([api.get(`/testcases?${params}`), api.get('/testcases/modules')]);
      setCases(res.data);
      setModules(mods.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, priority, module]);

  useEffect(() => {
    const t = setTimeout(fetchCases, 250);
    return () => clearTimeout(t);
  }, [fetchCases]);

  const deleteCase = async (id: string) => {
    if (!confirm('Delete this test case?')) return;
    try {
      await api.delete(`/testcases/${id}`);
      setCases((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onSaved = (tc: any) => {
    setEditing(null);
    setCases((prev) => {
      const exists = prev.some((c) => c.id === tc.id);
      return exists ? prev.map((c) => (c.id === tc.id ? tc : c)) : [tc, ...prev];
    });
    api.get('/testcases/modules').then((r) => setModules(r.data)).catch(() => undefined);
  };

  const actions = (
    <button className="btn btn-primary btn-sm" onClick={() => setEditing(editing ? null : {})}>
      {editing ? '✕ Close editor' : '＋ New Test Case'}
    </button>
  );

  const filtersActive = !!(search || priority || module);

  return (
    <Layout title="Test Cases" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {editing && (
        <TestCaseEditor key={editing.id ?? 'new'} initial={editing.id ? editing : undefined} onSaved={onSaved} onCancel={() => setEditing(null)} />
      )}

      <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap' }}>
        <input className="form-control" style={{ flex: '1 1 200px', maxWidth: 320 }} value={search}
          onChange={(e) => setSearch(e.target.value)} placeholder="🔍  Search title, module, description…" aria-label="Search test cases" />
        <select className="form-control" style={{ width: 170 }} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority filter">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select className="form-control" style={{ width: 200 }} value={module} onChange={(e) => setModule(e.target.value)} aria-label="Module filter">
          <option value="">All modules</option>
          {modules.map((m) => <option key={m.module} value={m.module}>{m.module} ({m.count})</option>)}
        </select>
        <span className="text-sm text-muted" style={{ display: 'flex', alignItems: 'center' }}>{cases.length} shown</span>
      </div>

      {loading ? (
        <div className="page-loading"><div className="spinner" /></div>
      ) : cases.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🧪</div>
            <h3>{filtersActive ? 'No matches' : 'No test cases yet'}</h3>
            <p>{filtersActive ? 'Try adjusting your filters.' : 'Upload a test document, generate tests from an agent, or create one manually.'}</p>
            {!filtersActive && (
              <div className="flex gap-3">
                <Link href="/documents" className="btn btn-primary btn-sm">📄 Upload Document</Link>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing({})}>＋ Create Manually</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Title</th><th>Module</th><th>Priority</th><th>Steps</th><th>Source</th><th></th></tr></thead>
              <tbody>
                {cases.map((tc) => (
                  <Fragment key={tc.id}>
                    <tr>
                      <td style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === tc.id ? null : tc.id)}>
                        <div className="fw-600" style={{ fontSize: 14 }}>{expanded === tc.id ? '▾' : '▸'} {tc.title}</div>
                        {tc.data?.personas && (
                          <div className="text-sm mt-1" aria-label="Runs as personas">
                            {(Array.isArray(tc.data.personas) ? tc.data.personas : [tc.data.personas]).map((p: string) => (
                              <span key={p} className="badge badge-info" style={{ marginRight: 4 }}>👤 {p}</span>
                            ))}
                          </div>
                        )}
                        {tc.description && <div className="text-sm text-muted">{tc.description.slice(0, 100)}{tc.description.length > 100 ? '…' : ''}</div>}
                      </td>
                      <td className="text-sm">{tc.module}</td>
                      <td><span className={priorityBadge(tc.priority)}>{tc.priority}</span></td>
                      <td className="text-sm">{tc.steps?.length ?? 0}</td>
                      <td className="text-sm text-muted">
                        {tc.documentId ? '📄 Extracted' : tc.tags?.includes('ai-generated') ? '🤖 Generated' : '✏️ Manual'}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => { setEditing(tc); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteCase(tc.id)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                    {expanded === tc.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--gray-50)' }}>
                          <ol style={{ margin: '4px 0 8px 20px', fontSize: 13 }}>
                            {(tc.steps ?? []).map((s: any) => (
                              <li key={s.stepId}>
                                <strong>{s.action}</strong>
                                {s.target && <> → <span className="code">{s.target}</span></>}
                                {s.data?.value !== undefined && <> = “{String(s.data.value)}”</>}
                                {s.data && s.data.value === undefined && <> <span className="code">{JSON.stringify(s.data)}</span></>}
                              </li>
                            ))}
                          </ol>
                          {tc.expectedResults?.length > 0 && (
                            <div className="text-sm"><strong>Expected:</strong> {tc.expectedResults.join(' · ')}</div>
                          )}
                          {tc.tags?.length > 0 && <div className="text-sm text-muted mt-1">Tags: {tc.tags.join(', ')}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
