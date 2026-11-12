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

export default function StepsEditor({ steps, setSteps, exclude, idPrefix = 'step' }: Props) {
  const [library, setLibrary] = useState<Library>({ blocks: [], elements: [] });
  const [notice, setNotice] = useState<string | null>(null);
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
