/**
 * Step rows (action · target · value), shared by the test case editor and the library's
 * block editor. Library blocks (use_block) show their parameters as fields; targets suggest
 * library elements ({{el.Name}}) and a step's target can be saved as a new element.
 */

import { useEffect, useState } from 'react';
import { api, errorMessage, STEP_ACTIONS } from '../lib/api';

export interface StepRow { action: string; target: string; value: string; params?: Record<string, string> }

/** Step value column: plain text becomes data.value; a JSON object is used as the step data as-is. */
export function valueToData(value: string): Record<string, any> | undefined {
  if (value === '') return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON: plain text
    }
  }
  return { value };
}

export function toRows(steps: any[] | undefined, empty: StepRow = { action: 'navigate', target: '/', value: '' }): StepRow[] {
  if (!steps || steps.length === 0) return [empty];
  return steps.map((s) => (s.action === 'use_block'
    ? { action: 'use_block', target: s.target ?? '', value: '', params: Object.fromEntries(Object.entries(s.data?.params ?? {}).map(([k, v]) => [k, String(v)])) }
    : {
      action: s.action ?? '',
      target: s.target ?? '',
      value: s.data?.value !== undefined && Object.keys(s.data).length === 1 ? String(s.data.value) : s.data ? JSON.stringify(s.data) : '',
    }));
}

export function rowsToSteps(rows: StepRow[]): any[] {
  return rows
    .filter((s) => s.action.trim())
    .map((s) => {
      if (s.action.trim() === 'use_block') {
        const params = Object.fromEntries(Object.entries(s.params ?? {}).filter(([, v]) => v !== ''));
        return { action: 'use_block', target: s.target.trim(), ...(Object.keys(params).length ? { data: { params } } : {}) };
      }
      return {
        action: s.action.trim(),
        ...(s.target.trim() ? { target: s.target.trim() } : {}),
        ...(valueToData(s.value) ? { data: valueToData(s.value) } : {}),
      };
    });
}

interface Library { blocks: Array<{ name: string; params: Array<{ name: string; default?: string; description?: string }> }>; elements: Array<{ name: string; locator: string }> }

let cached: Promise<Library> | null = null;
/** Blocks and elements of the project (cached per page; call refreshLibrary() after changes). */
export function loadLibrary(): Promise<Library> {
  if (!cached) {
    cached = Promise.all([api.get('/blocks'), api.get('/elements')])
      .then(([b, e]) => ({ blocks: b.data, elements: e.data }))
      .catch(() => ({ blocks: [], elements: [] }));
  }
  return cached;
}
export const refreshLibrary = () => { cached = null; return loadLibrary(); };

interface Props {
  steps: StepRow[];
  setSteps: (fn: (prev: StepRow[]) => StepRow[]) => void;
  /** The block being edited: it is not offered as a step of itself */
  exclude?: string;
  idPrefix?: string;
}

/** Write steps in plain English; the rules (and the AI for the rest) turn them into steps to review. */
function PlainEnglish({ onSteps, idPrefix }: { onSteps: (steps: any[], replace: boolean) => void; idPrefix: string }) {
  const [text, setText] = useState('');
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [path, setPath] = useState('/');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get('/agents').then((r) => setAgents(r.data)).catch(() => undefined); }, []);

  const convert = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult((await api.post('/steps/from-text', { text, ...(agentId ? { agentId, path } : {}) })).data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const VIA: Record<string, [string, string]> = { rules: ['badge badge-success', 'understood'], ai: ['badge badge-info', 'AI'], none: ['badge badge-warning', 'not understood'] };

  return (
    <div className="card mb-3" style={{ background: 'var(--gray-50)' }} data-testid="plain-english">
      <div className="card-body">
        <label className="form-label" htmlFor={`${idPrefix}-english`}>Steps in plain English (one per line, or joined with “then”)</label>
        <textarea id={`${idPrefix}-english`} className="form-control" rows={5} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'Sign in with user alice\nGo to /cart, then check that Total shows 42.00\nType "SPRING" into the Coupon field and click Apply\nVerify the page shows "Saved"'} />
        <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-control" style={{ width: 220 }} value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Look at the page of">
            <option value="">Without looking at the app</option>
            {agents.map((a) => <option key={a.id} value={a.id}>Look at {a.name}</option>)}
          </select>
          {agentId && <input className="form-control" style={{ width: 140 }} value={path} onChange={(e) => setPath(e.target.value)} aria-label="Starting page" placeholder="/" />}
          <button type="button" className="btn btn-primary btn-sm" onClick={convert} disabled={busy || !text.trim()}>{busy ? 'Converting…' : 'Convert to steps'}</button>
        </div>
        <p className="form-hint">Library blocks and elements are used by name. What the rules do not understand goes to the AI, which looks at the chosen app&apos;s page for real labels.
          The result is ordinary steps: they replay exactly, without the AI.</p>
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        {result && (
          <>
            <table className="data-table text-sm" data-testid="english-result">
              <tbody>
                {result.lines.map((l: any, i: number) => (
                  <tr key={i}>
                    <td style={{ width: '40%' }}>{l.text}</td>
                    <td><span className={VIA[l.via][0]}>{VIA[l.via][1]}</span></td>
                    <td>{l.steps.map((st: any, n: number) => <div key={n}><code>{st.action}</code> {st.target} {st.data ? <span className="text-muted">{JSON.stringify(st.data)}</span> : null}</div>)}{l.note && <div className="text-muted">{l.note}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-2 mt-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={!result.steps.length} onClick={() => { onSteps(result.steps, false); setResult(null); setText(''); }}>Add {result.steps.length} step(s)</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!result.steps.length} onClick={() => { onSteps(result.steps, true); setResult(null); setText(''); }}>Replace all steps</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function StepsEditor({ steps, setSteps, exclude, idPrefix = 'step' }: Props) {
  const [library, setLibrary] = useState<Library>({ blocks: [], elements: [] });
  const [notice, setNotice] = useState<string | null>(null);
  const [english, setEnglish] = useState(false);
  useEffect(() => { loadLibrary().then(setLibrary); }, []);

  const update = (i: number, patch: Partial<StepRow>) => setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => setSteps((prev) => {
    const next = [...prev];
    const j = i + d;
    if (j < 0 || j >= next.length) return prev;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  /** Save a step's target as a library element and use {{el.Name}} instead. */
  const saveAsElement = async (i: number) => {
    const locator = steps[i].target.trim();
    const name = window.prompt(`Name for the element "${locator}" (e.g. Checkout.PayButton)`);
    if (!name) return;
    try {
      await api.post('/elements', { name: name.trim(), locator });
      update(i, { target: `{{el.${name.trim()}}}` });
      setLibrary(await refreshLibrary());
      setNotice(`Saved as {{el.${name.trim()}}}: other tests can use it, and fixing it fixes them all.`);
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const blocks = library.blocks.filter((b) => b.name !== exclude);
  return (
    <div>
      <div className="mb-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEnglish((v) => !v)} aria-expanded={english}>✍ Write in plain English</button>
      </div>
      {english && (
        <PlainEnglish idPrefix={idPrefix} onSteps={(converted, replace) => {
          const rows = toRows(converted);
          setSteps((prev) => {
            const kept = replace ? [] : prev.filter((r) => r.action.trim() && !(r.action === 'navigate' && r.target === '/' && prev.length === 1));
            return [...kept, ...rows];
          });
          setEnglish(false);
        }} />
      )}
      <datalist id={`${idPrefix}-actions`}>{[...STEP_ACTIONS, 'use_block'].map((a) => <option key={a} value={a} />)}</datalist>
      <datalist id={`${idPrefix}-blocks`}>{blocks.map((b) => <option key={b.name} value={b.name} />)}</datalist>
      <datalist id={`${idPrefix}-elements`}>{library.elements.map((e) => <option key={e.name} value={`{{el.${e.name}}}`}>{e.locator}</option>)}</datalist>
      {steps.map((s, i) => {
        const block = s.action === 'use_block' ? blocks.find((b) => b.name.toLowerCase() === s.target.trim().toLowerCase()) : undefined;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 160px 1fr 1fr auto', gap: 6, marginBottom: 6, alignItems: 'start' }} data-testid="step-row">
            <span className="text-sm text-muted" style={{ paddingTop: 8 }}>{i + 1}.</span>
            <input className="form-control" list={`${idPrefix}-actions`} aria-label={`Step ${i + 1} action`} value={s.action}
              onChange={(e) => update(i, { action: e.target.value })} placeholder="action" />
            <input className="form-control" list={s.action === 'use_block' ? `${idPrefix}-blocks` : `${idPrefix}-elements`} aria-label={`Step ${i + 1} target`} value={s.target}
              onChange={(e) => update(i, { target: e.target.value })}
              placeholder={s.action === 'use_block' ? 'block name' : 'target: /path, {{el.Name}}, [data-testid=…], role=button[name="Save"]'} />
            {s.action === 'use_block' ? (
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {block ? (block.params.length ? block.params.map((p) => (
                  <input key={p.name} className="form-control" style={{ flex: '1 1 120px' }} aria-label={`Step ${i + 1} ${p.name}`} title={p.description}
                    value={s.params?.[p.name] ?? ''} placeholder={`${p.name}${p.default !== undefined ? ` (${p.default})` : ' *'}`}
                    onChange={(e) => update(i, { params: { ...(s.params ?? {}), [p.name]: e.target.value } })} />
                )) : <span className="text-sm text-muted" style={{ paddingTop: 8 }}>no parameters</span>)
                  : <span className="text-sm text-muted" style={{ paddingTop: 8 }}>{s.target ? 'unknown block' : 'choose a block'}</span>}
              </div>
            ) : (
              <input className="form-control" aria-label={`Step ${i + 1} value`} value={s.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="value (text to type / expect)" />
            )}
            <div className="flex gap-2">
              {s.action !== 'use_block' && s.target.trim() && !/^\s*\{\{\s*el\./.test(s.target) && !/^(\/|https?:)/.test(s.target.trim()) && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => saveAsElement(i)} title="Save the target as a library element" aria-label={`Save step ${i + 1} target as element`}>★</button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} title="Move up">↑</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} title="Move down">↓</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSteps((p) => p.filter((_, idx) => idx !== i))} title="Remove">✕</button>
            </div>
          </div>
        );
      })}
      {notice && <div className="alert alert-info">{notice}</div>}
      <div className="flex gap-2 mt-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSteps((p) => [...p, { action: 'click', target: '', value: '' }])}>＋ Add step</button>
        {blocks.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSteps((p) => [...p, { action: 'use_block', target: '', value: '', params: {} }])}>＋ Use a block</button>}
      </div>
    </div>
  );
}
