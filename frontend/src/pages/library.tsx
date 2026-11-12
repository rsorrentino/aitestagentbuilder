/**
 * Library: reusable step blocks and named elements of the project. Change a block or an
 * element once, every test using it follows.
 */

import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import StepsEditor, { refreshLibrary, rowsToSteps, StepRow, toRows } from '../components/StepsEditor';
import { api, errorMessage, formatDate } from '../lib/api';
import { useSession } from '../lib/session';

const LOCATOR_TIPS = [
  ['React / any app with test ids', '[data-testid="order-total"]'],
  ['Accessible role and name (works inside Salesforce Lightning components)', 'role=button[name="Save"]'],
  ['Visible text', 'text=Order total'],
  ['Form field by label', 'role=textbox[name="Account Name"]'],
  ['CSS', '#total, .cart .total'],
];

function BlockEditor({ block, onDone }: { block?: any; onDone: (msg?: string) => void }) {
  const [name, setName] = useState(block?.name ?? '');
  const [description, setDescription] = useState(block?.description ?? '');
  const [params, setParams] = useState<Array<{ name: string; default: string; description: string }>>(
    (block?.params ?? []).map((p: any) => ({ name: p.name, default: p.default ?? '', description: p.description ?? '' })),
  );
  const [steps, setSteps] = useState<StepRow[]>(toRows(block?.steps));
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      name: name.trim(), description: description.trim(),
      params: params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), ...(p.default !== '' ? { default: p.default } : {}), ...(p.description ? { description: p.description } : {}) })),
      steps: rowsToSteps(steps),
    };
    try {
      if (block) await api.put(`/blocks/${block.id}`, body);
      else await api.post('/blocks', body);
      await refreshLibrary();
      onDone(block ? `Block “${body.name}” saved: every test using it follows.` : `Block “${body.name}” created.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="card mb-6" onSubmit={save} data-testid="block-form">
      <div className="card-header"><h3>{block ? `Edit block “${block.name}”` : '＋ New block'}</h3></div>
      <div className="card-body">
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="blk-name">Name *</label>
            <input id="blk-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sign in, Create opportunity…" required />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label" htmlFor="blk-desc">Description</label>
            <input id="blk-desc" className="form-control" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <div className="form-label">Parameters (use them in steps as <code>{'{{param.name}}'}</code>)</div>
          {params.map((p, i) => (
            <div key={i} className="flex gap-2 mb-2" data-testid="param-row">
              <input className="form-control" style={{ width: 160 }} aria-label={`Parameter ${i + 1} name`} placeholder="name" value={p.name} onChange={(e) => setParams((ps) => ps.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} />
              <input className="form-control" style={{ width: 160 }} aria-label={`Parameter ${i + 1} default`} placeholder="default (optional)" value={p.default} onChange={(e) => setParams((ps) => ps.map((x, n) => (n === i ? { ...x, default: e.target.value } : x)))} />
              <input className="form-control" aria-label={`Parameter ${i + 1} description`} placeholder="what it is" value={p.description} onChange={(e) => setParams((ps) => ps.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams((ps) => ps.filter((_x, n) => n !== i))} aria-label="Remove parameter">✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setParams((ps) => [...ps, { name: '', default: '', description: '' }])}>＋ Parameter</button>
        </div>
        <div className="form-group">
          <div className="form-label">Steps</div>
          <StepsEditor steps={steps} setSteps={setSteps} exclude={block?.name} idPrefix="blk" />
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary btn-sm">{block ? 'Save' : 'Create block'}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDone()}>Cancel</button>
        </div>
      </div>
    </form>
  );
}

function ElementForm({ element, onDone }: { element?: any; onDone: (msg?: string) => void }) {
  const [form, setForm] = useState({ name: element?.name ?? '', locator: element?.locator ?? '', alternatives: (element?.alternatives ?? []).join('\n'), description: element?.description ?? '', pageUrl: element?.pageUrl ?? '' });
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { ...form, name: form.name.trim(), alternatives: form.alternatives.split('\n').map((a: string) => a.trim()).filter(Boolean) };
    try {
      if (element) await api.put(`/elements/${element.id}`, body);
      else await api.post('/elements', body);
      await refreshLibrary();
      onDone(element ? `Element ${body.name} saved: every test using it follows.` : `Element ${body.name} created: use it as {{el.${body.name}}}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="card mb-6" onSubmit={save} data-testid="element-form">
      <div className="card-header"><h3>{element ? `Edit ${element.name}` : '＋ New element'}</h3></div>
      <div className="card-body">
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="el-name">Name *</label>
            <input id="el-name" className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Checkout.PayButton" required />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label" htmlFor="el-locator">Locator *</label>
            <input id="el-locator" className="form-control" value={form.locator} onChange={(e) => setForm({ ...form, locator: e.target.value })} placeholder='[data-testid="pay"] or role=button[name="Pay"]' required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="el-alt">Alternatives (one per line)</label>
            <textarea id="el-alt" className="form-control" rows={2} value={form.alternatives} onChange={(e) => setForm({ ...form, alternatives: e.target.value })} placeholder="tried when the locator no longer matches" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="el-page">Page</label>
            <input id="el-page" className="form-control" value={form.pageUrl} onChange={(e) => setForm({ ...form, pageUrl: e.target.value })} placeholder="/checkout" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="el-desc">Description</label>
            <input id="el-desc" className="form-control" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>
        <details className="mb-3 text-sm">
          <summary>Which locator?</summary>
          <table className="data-table mt-2">
            <tbody>{LOCATOR_TIPS.map(([what, ex]) => <tr key={what}><td>{what}</td><td><code>{ex}</code></td></tr>)}</tbody>
          </table>
          <p className="form-hint">Prefer test ids and roles over CSS classes: React class names often change with every build. Salesforce Lightning renders fields inside
            web components; role and text locators reach inside them.</p>
        </details>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary btn-sm">{element ? 'Save' : 'Create element'}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDone()}>Cancel</button>
        </div>
      </div>
    </form>
  );
}

export default function LibraryPage() {
  const session = useSession();
  const canEdit = session.can('editor');
  const [tab, setTab] = useState<'blocks' | 'elements'>('blocks');
  const [blocks, setBlocks] = useState<any[]>([]);
  const [elements, setElements] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [usage, setUsage] = useState<Record<string, any>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, e] = await Promise.all([api.get('/blocks'), api.get('/elements')]);
      setBlocks(b.data);
      setElements(e.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const done = async (msg?: string) => {
    setEditing(null);
    if (msg) setNotice(msg);
    await load();
  };

  const showUsage = async (kind: 'blocks' | 'elements', id: string) => {
    if (usage[id]) return setUsage((u) => { const { [id]: _x, ...rest } = u; return rest; });
    const r = await api.get(`/${kind}/${id}`);
    setUsage((u) => ({ ...u, [id]: r.data.usage }));
  };

  const remove = async (kind: 'blocks' | 'elements', item: any) => {
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/${kind}/${item.id}`);
    } catch (err: any) {
      if (err?.response?.status !== 409) return setError(errorMessage(err));
      if (!confirm(`${err.response.data.error}. Delete anyway? Those tests will fail until changed.`)) return;
      await api.delete(`/${kind}/${item.id}`, { params: { force: true } });
    }
    await refreshLibrary();
    setNotice(`Deleted ${item.name}.`);
    await load();
  };

  const q = filter.trim().toLowerCase();
  const shownBlocks = blocks.filter((b) => !q || `${b.name} ${b.description ?? ''}`.toLowerCase().includes(q));
  const shownElements = elements.filter((e) => !q || `${e.name} ${e.locator} ${e.pageUrl ?? ''}`.toLowerCase().includes(q));

  const usageList = (u: any) => (
    <div className="text-sm text-muted">
      {u.tests.length + u.blocks.length === 0 ? 'Not used yet.' : <>Used by {[...u.tests.map((t: any) => `test “${t.title}”`), ...u.blocks.map((b: any) => `block “${b.name}”`)].join(', ')}</>}
    </div>
  );

  return (
    <Layout title="Library">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="chip-group" role="tablist">
          <div role="tab" aria-selected={tab === 'blocks'} tabIndex={0} className={`chip${tab === 'blocks' ? ' selected' : ''}`} onClick={() => { setTab('blocks'); setEditing(null); }}>🧩 Blocks ({blocks.length})</div>
          <div role="tab" aria-selected={tab === 'elements'} tabIndex={0} className={`chip${tab === 'elements' ? ' selected' : ''}`} onClick={() => { setTab('elements'); setEditing(null); }}>🎯 Elements ({elements.length})</div>
        </div>
        <input className="form-control" style={{ maxWidth: 280 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="🔍  Search" aria-label="Search library" />
        {canEdit && !editing && <button className="btn btn-primary btn-sm" onClick={() => setEditing({})}>＋ New {tab === 'blocks' ? 'block' : 'element'}</button>}
      </div>

      {editing && tab === 'blocks' && <BlockEditor key={editing.id ?? 'new'} block={editing.id ? editing : undefined} onDone={done} />}
      {editing && tab === 'elements' && <ElementForm key={editing.id ?? 'new'} element={editing.id ? editing : undefined} onDone={done} />}

      {tab === 'blocks' ? (
        <div className="card">
          {shownBlocks.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🧩</div>
              <h3>No blocks yet</h3>
              <p>A block is a group of steps used by many tests, such as “Sign in as {'{{param.user}}'}” or “Create opportunity”. Tests run it with the step
                <code> use_block</code>; when the flow changes, you change the block once.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="data-table" data-testid="blocks">
                <thead><tr><th>Block</th><th>Parameters</th><th>Steps</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {shownBlocks.map((b) => (
                    <tr key={b.id}>
                      <td><div className="fw-600">{b.name}</div>{b.description && <div className="text-sm text-muted">{b.description}</div>}{usage[b.id] && usageList(usage[b.id])}</td>
                      <td className="text-sm">{b.params.map((p: any) => `${p.name}${p.default !== undefined ? ` = ${p.default}` : ''}`).join(', ') || '—'}</td>
                      <td className="text-sm">{b.steps.length}</td>
                      <td className="text-sm text-muted">{formatDate(b.updatedAt)}{b.updatedBy === 'self-healing' && <div>🩹 self-healed</div>}</td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => showUsage('blocks', b.id)}>Used by</button>
                          {canEdit && <button className="btn btn-secondary btn-sm" onClick={() => { setEditing(b); window.scrollTo({ top: 0 }); }}>Edit</button>}
                          {canEdit && <button className="btn btn-danger btn-sm" onClick={() => remove('blocks', b)}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {shownElements.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🎯</div>
              <h3>No elements yet</h3>
              <p>Name the things tests click and check (“Checkout.PayButton”) and use them as <code>{'{{el.Checkout.PayButton}}'}</code>. When the UI changes, fix the
                element once; self-healing also saves its repairs here. ★ in the step editor saves a step&apos;s target as an element.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="data-table" data-testid="elements">
                <thead><tr><th>Element</th><th>Locator</th><th>Page</th><th></th></tr></thead>
                <tbody>
                  {shownElements.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="fw-600"><code>{`{{el.${e.name}}}`}</code></div>
                        {e.description && <div className="text-sm text-muted">{e.description}</div>}
                        {usage[e.id] && usageList(usage[e.id])}
                      </td>
                      <td className="text-sm">
                        <code>{e.locator}</code>
                        {e.source === 'healed' && <span className="badge badge-warning" style={{ marginLeft: 6 }} title={`Repaired ${formatDate(e.healedAt)}`}>🩹 healed</span>}
                        {e.alternatives.length > 0 && <div className="text-muted">or {e.alternatives.map((a: string) => <code key={a} style={{ marginRight: 4 }}>{a}</code>)}</div>}
                      </td>
                      <td className="text-sm">{e.pageUrl ?? '—'}</td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => showUsage('elements', e.id)}>Used by</button>
                          {canEdit && <button className="btn btn-secondary btn-sm" onClick={() => { setEditing(e); window.scrollTo({ top: 0 }); }}>Edit</button>}
                          {canEdit && <button className="btn btn-danger btn-sm" onClick={() => remove('elements', e)}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
