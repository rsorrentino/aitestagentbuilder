/**
 * Test data — data sets that drive data-driven tests (one run per row),
 * generated with Faker from column kinds or by the AI from a description,
 * and the {{fake.kind}} values available in steps.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate } from '../lib/api';
import { useSession } from '../lib/session';

interface Column { name: string; kind: string }

const LOCALES = ['en', 'en_US', 'en_GB', 'it', 'de', 'fr', 'es', 'pt_BR', 'nl', 'pl', 'ja'];
const rowsOf = (data: any): any[] => (Array.isArray(data?.rows) ? data.rows : data && typeof data === 'object' ? [data] : []);

function RowsTable({ rows }: { rows: any[] }) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
  if (!rows.length) return <p className="text-muted text-sm">No rows</p>;
  return (
    <div className="table-wrapper" style={{ maxHeight: 360, overflow: 'auto' }}>
      <table className="data-table" style={{ fontSize: 13 }}>
        <thead><tr><th>#</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="text-muted">{i + 1}</td>
              {columns.map((c) => <td key={c} className="code" style={{ fontSize: 12 }}>{r?.[c] === undefined ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TestDataPage() {
  const session = useSession();
  const canEdit = session.can('editor');
  const canDelete = session.can('admin');
  const [sets, setSets] = useState<any[]>([]);
  const [kinds, setKinds] = useState<Array<{ kind: string; description: string; example: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // generator
  const [mode, setMode] = useState<'faker' | 'ai'>('faker');
  const [columns, setColumns] = useState<Column[]>([{ name: 'name', kind: 'fullName' }, { name: 'email', kind: 'email' }]);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(10);
  const [locale, setLocale] = useState('en');
  const [seed, setSeed] = useState('');
  const [preview, setPreview] = useState<{ rows: any[]; source: string; provider?: string } | null>(null);
  const [name, setName] = useState('');

  // editing
  const [open, setOpen] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const load = useCallback(async () => {
    try {
      setSets((await api.get('/testdata')).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/testdata/fake-kinds', { params: { locale } }).then((r) => setKinds(r.data)).catch(() => undefined);
  }, [locale]);

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const request = (save: boolean) => ({
    count,
    locale,
    ...(seed.trim() ? { seed: seed.trim() } : {}),
    ...(mode === 'ai' ? { prompt } : {}),
    ...(columns.some((c) => c.name.trim()) ? { fields: Object.fromEntries(columns.filter((c) => c.name.trim()).map((c) => [c.name.trim(), c.kind])) } : {}),
    ...(save ? { save: true, name: name.trim() } : {}),
  });

  const generate = () => act('preview', async () => {
    setPreview(null);
    const res = await api.post('/testdata/generate', request(false));
    setPreview(res.data);
  });

  const save = () => act('save', async () => {
    // Save exactly the previewed rows (AI answers vary between calls)
    if (preview) await api.post('/testdata', { name: name.trim(), description: mode === 'ai' ? prompt : undefined, data: preview.rows, tags: ['generated'] });
    else await api.post('/testdata/generate', request(true));
    setName('');
    setPreview(null);
    await load();
    return `Data set “${name.trim()}” saved`;
  });

  const startEdit = (set: any) => {
    setOpen(open === set.id ? null : set.id);
    setEditText(JSON.stringify(set.data, null, 2));
  };

  const saveEdit = (set: any) => act(`edit-${set.id}`, async () => {
    let data: any;
    try {
      data = JSON.parse(editText);
    } catch (e: any) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
    await api.put(`/testdata/${set.id}`, { data });
    await load();
    return `“${set.name}” saved`;
  });

  return (
    <Layout title="Test Data">
      {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      {canEdit && (
        <div className="card mb-6">
          <div className="card-header">
            <h3>🎲 Generate a data set</h3>
            <div className="flex gap-2" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'faker'} className={`btn btn-sm ${mode === 'faker' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('faker')}>From columns</button>
              <button type="button" role="tab" aria-selected={mode === 'ai'} className={`btn btn-sm ${mode === 'ai' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('ai')}>With AI</button>
            </div>
          </div>
          <div className="card-body">
            {mode === 'ai' && (
              <div className="form-group">
                <label className="form-label" htmlFor="td-prompt">Describe the data</label>
                <textarea id="td-prompt" className="form-control" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Customers for the signup form, including edge cases: empty email, 255-character name, accents and apostrophes, under-age birth date" />
                <div className="form-hint">The AI writes fictitious values (emails at example.com) and labels edge cases. Columns below are optional hints.</div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Columns{mode === 'ai' ? ' (optional)' : ''}</label>
              {columns.map((c, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input className="form-control" aria-label={`Column ${i + 1} name`} value={c.name} placeholder="column"
                    onChange={(e) => setColumns((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <select className="form-control" aria-label={`Column ${i + 1} kind`} value={c.kind}
                    onChange={(e) => setColumns((prev) => prev.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                    {(kinds.length ? kinds : [{ kind: c.kind, description: c.kind, example: '' }]).map((k) => <option key={k.kind} value={k.kind}>{k.kind} — {k.description}</option>)}
                  </select>
                  <button type="button" className="btn btn-ghost btn-sm" title="Remove column" onClick={() => setColumns((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setColumns((prev) => [...prev, { name: '', kind: 'word' }])}>＋ Column</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, alignItems: 'end' }}>
              <div>
                <label className="form-label" htmlFor="td-count">Rows</label>
                <input id="td-count" type="number" min={1} max={100} className="form-control" value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
              <div>
                <label className="form-label" htmlFor="td-locale">Locale</label>
                <select id="td-locale" className="form-control" value={locale} onChange={(e) => setLocale(e.target.value)}>
                  {LOCALES.map((l) => <option key={l}>{l}</option>)}
                </select>
              </div>
              {mode === 'faker' && (
                <div>
                  <label className="form-label" htmlFor="td-seed">Seed (optional)</label>
                  <input id="td-seed" className="form-control" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="reproducible values" />
                </div>
              )}
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || (mode === 'ai' && !prompt.trim())} onClick={generate}>
                {busy === 'preview' ? 'Generating…' : 'Preview'}
              </button>
            </div>

            {preview && (
              <div className="mt-3" data-testid="testdata-preview">
                <p className="text-sm text-muted">{preview.rows.length} row(s) · {preview.source === 'ai' ? `AI${preview.provider ? ` (${preview.provider})` : ''}` : 'Faker'}</p>
                <RowsTable rows={preview.rows} />
                <div className="flex gap-2 mt-2" style={{ alignItems: 'center' }}>
                  <input className="form-control" aria-label="Data set name" style={{ maxWidth: 280 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Data set name, e.g. signups" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || !name.trim()} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save data set'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header"><h3>Data sets</h3></div>
        {sets.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎲</div>
            <h3>No data sets</h3>
            <p>Generate one above, then set it as the data set of a test case: the test runs once per row.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Rows</th><th>Environment</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {sets.map((set) => (
                  <Fragment key={set.id}>
                    <tr>
                      <td>
                        <div className="fw-600">{set.name}</div>
                        {set.description && <div className="text-sm text-muted">{set.description}</div>}
                        {(set.tags ?? []).map((t: string) => <span key={t} className="badge badge-neutral" style={{ marginRight: 4 }}>{t}</span>)}
                      </td>
                      <td>{rowsOf(set.data).length}</td>
                      <td>{set.environment ?? <span className="text-muted">any</span>}</td>
                      <td className="text-sm">{formatDate(set.updatedAt)}</td>
                      <td>
                        <div className="flex gap-2">
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(set)} aria-expanded={open === set.id}>{open === set.id ? 'Close' : canEdit ? 'View / edit' : 'View'}</button>
                          {canDelete && (
                            <button type="button" className="btn btn-danger btn-sm"
                              onClick={() => confirm(`Delete data set “${set.name}”? Tests that use it will fail.`) && act(`del-${set.id}`, async () => { await api.delete(`/testdata/${set.id}`); await load(); })}>Delete</button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open === set.id && (
                      <tr>
                        <td colSpan={5}>
                          <RowsTable rows={rowsOf(set.data)} />
                          {canEdit && (
                            <div className="mt-2">
                              <textarea className="form-control code" rows={10} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label={`JSON of ${set.name}`} spellCheck={false} />
                              <div className="form-hint">
                                <code>{'{"rows": [{...}, {...}]}'}</code> — values may use <code>{'{{secrets.NAME}}'}</code> and <code>{'{{fake.kind}}'}</code>;
                                a <code>_label</code> column names the row in reports.
                              </div>
                              <button type="button" className="btn btn-primary btn-sm mt-2" disabled={busy !== null} onClick={() => saveEdit(set)}>Save</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><h3>Using test data in steps</h3></div>
        <div className="card-body text-sm">
          <ul style={{ margin: '0 0 12px 18px' }}>
            <li><code>{'{{data.email}}'}</code> — column of the current row, when the test case has a data set (the test runs once per row).</li>
            <li><code>{'{{fake.email}}'}</code>, <code>{'{{fake.email:buyer}}'}</code> — a fictitious value; the same kind and label give the same value within a test, so a later step can check what an earlier one typed.</li>
            <li>Agent setting <code>{'"test_data": {"locale": "it", "seed": 42}'}</code> — locale of names, addresses and phone numbers; a seed makes the values reproducible run after run. <code>{'{{fake.unique}}'}</code> stays unique anyway.</li>
          </ul>
          <div className="table-wrapper">
            <table className="data-table" style={{ fontSize: 13 }}>
              <thead><tr><th>Kind</th><th>Description</th><th>Example ({locale})</th></tr></thead>
              <tbody>
                {kinds.map((k) => (
                  <tr key={k.kind}><td className="code">{`{{fake.${k.kind}}}`}</td><td>{k.description}</td><td className="code" style={{ fontSize: 12 }}>{k.example}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
