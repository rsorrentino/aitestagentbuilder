/**
 * Create / edit a test case, including its executable steps.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage, PRIORITIES, STEP_ACTIONS, TEST_TYPES } from '../lib/api';

interface StepRow { action: string; target: string; value: string }

export interface TestCaseEditorProps {
  initial?: any;
  onSaved: (tc: any) => void;
  onCancel: () => void;
}

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

function toRows(steps: any[] | undefined): StepRow[] {
  if (!steps || steps.length === 0) return [{ action: 'navigate', target: '/', value: '' }];
  return steps.map((s) => ({
    action: s.action ?? '',
    target: s.target ?? '',
    value: s.data?.value !== undefined && Object.keys(s.data).length === 1 ? String(s.data.value) : s.data ? JSON.stringify(s.data) : '',
  }));
}

export default function TestCaseEditor({ initial, onSaved, onCancel }: TestCaseEditorProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [module, setModule] = useState(initial?.module ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 'Medium');
  const [type, setType] = useState(initial?.type ?? 'Functional');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [expected, setExpected] = useState((initial?.expectedResults ?? []).join('\n'));
  const [steps, setSteps] = useState<StepRow[]>(toRows(initial?.steps));
  const initialPersonas = initial?.data?.personas;
  const [personas, setPersonas] = useState<string>(Array.isArray(initialPersonas) ? initialPersonas.join(', ') : initialPersonas ?? '');
  const [dataset, setDataset] = useState<string>(initial?.data?.dataset ?? '');
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    api.get('/testdata').then((res) => setDatasets(res.data)).catch(() => undefined);
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateStep = (i: number, key: keyof StepRow, v: string) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, [key]: v } : s)));
  const move = (i: number, d: number) => setSteps((prev) => {
    const next = [...prev];
    const j = i + d;
    if (j < 0 || j >= next.length) return prev;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      title: title.trim(),
      module: module.trim(),
      priority,
      type,
      description: description.trim() || undefined,
      tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean),
      expectedResults: expected.split('\n').map((t: string) => t.trim()).filter(Boolean),
      steps: steps
        .filter((s) => s.action.trim())
        .map((s) => ({
          action: s.action.trim(),
          ...(s.target.trim() ? { target: s.target.trim() } : {}),
          ...(valueToData(s.value) ? { data: valueToData(s.value) } : {}),
        })),
      data: (() => {
        const list = personas.split(',').map((p: string) => p.trim()).filter(Boolean);
        const rest = { ...(initial?.data ?? {}) };
        delete rest.personas;
        delete rest.dataset;
        const next = {
          ...rest,
          ...(list.length ? { personas: list.includes('all') ? 'all' : list } : {}),
          ...(dataset.trim() ? { dataset: dataset.trim() } : {}),
        };
        return Object.keys(next).length ? next : null;
      })(),
    };
    try {
      const res = initial?.id
        ? await api.put(`/testcases/${initial.id}`, payload)
        : await api.post('/testcases', payload);
      onSaved(res.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card mb-6" style={{ borderColor: 'var(--brand-200)' }}>
      <div className="card-header"><h3>{initial?.id ? 'Edit Test Case' : 'New Test Case'}</h3></div>
      <div className="card-body">
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label" htmlFor="tc-title">Title *</label>
            <input id="tc-title" className="form-control" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Login with valid credentials" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-module">Module *</label>
            <input id="tc-module" className="form-control" value={module} onChange={(e) => setModule(e.target.value)} placeholder="Authentication" />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-priority">Priority</label>
            <select id="tc-priority" className="form-control" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-type">Type</label>
            <select id="tc-type" className="form-control" value={type} onChange={(e) => setType(e.target.value)}>
              {TEST_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-personas">Run as personas</label>
            <input id="tc-personas" className="form-control" value={personas} onChange={(e) => setPersonas(e.target.value)} placeholder="admin, rep, viewer — or all" />
            <div className="form-hint">Salesforce personas or login profiles: the test runs once per user, signed in.</div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-dataset">Data set</label>
            <input id="tc-dataset" className="form-control" list="tc-datasets" value={dataset} onChange={(e) => setDataset(e.target.value)} placeholder="none" />
            <datalist id="tc-datasets">{[...new Set(datasets.map((d) => d.name))].map((n) => <option key={n} value={n} />)}</datalist>
            <div className="form-hint">The test runs once per row; steps use <code>{'{{data.column}}'}</code>. <Link href="/testdata">Test data →</Link></div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="tc-tags">Tags (comma separated)</label>
            <input id="tc-tags" className="form-control" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="smoke, login" />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="tc-desc">Description</label>
          <textarea id="tc-desc" className="form-control" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-label">Steps</label>
          <datalist id="step-actions">{STEP_ACTIONS.map((a) => <option key={a} value={a} />)}</datalist>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 160px 1fr 1fr auto', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <span className="text-sm text-muted">{i + 1}.</span>
              <input className="form-control" list="step-actions" aria-label={`Step ${i + 1} action`} value={s.action} onChange={(e) => updateStep(i, 'action', e.target.value)} placeholder="action" />
              <input className="form-control" aria-label={`Step ${i + 1} target`} value={s.target} onChange={(e) => updateStep(i, 'target', e.target.value)} placeholder="target: /path, #id, text=Label" />
              <input className="form-control" aria-label={`Step ${i + 1} value`} value={s.value} onChange={(e) => updateStep(i, 'value', e.target.value)} placeholder="value (text to type / expect)" />
              <div className="flex gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, -1)} title="Move up">↑</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(i, 1)} title="Move down">↓</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSteps((p) => p.filter((_, idx) => idx !== i))} title="Remove">✕</button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setSteps((p) => [...p, { action: 'click', target: '', value: '' }])}>＋ Add step</button>
          <p className="form-hint mt-2">
            Actions: navigate, click, fill, select, check, press, hover, wait, assert_visible, assert_not_visible, assert_text, assert_url, assert_title, screenshot.
            Quality: assert_accessible (axe-core WCAG scan; value <code>{'{"level": "wcag21aa", "ignore": ["color-contrast"]}'}</code>),
            assert_screenshot (visual regression against a baseline; target an element or leave empty for the page; value <code>{'{"name": "home", "mask": [".clock"]}'}</code>).
            API: http_request (target: path or URL; value <code>{'{"method": "POST", "json": {...}, "extract": {"id": "$.id"}}'}</code>, later <code>{'{{vars.id}}'}</code>),
            assert_status (<code>201</code> or <code>2xx</code>), assert_json (<code>{'{"path": "$.items[0].name", "equals": "Lamp"}'}</code>), assert_header, assert_response_time,
            mock_route / block_route (target: URL pattern, e.g. <code>**/api/payments/**</code>; value <code>{'{"status": 500}'}</code>) to stub calls in UI tests.
            AI: assert_ai (value: the expectation in plain language, e.g. “the answer explains how to reset a password”; optional target element), or write
            the action as “Verify with AI that …”.
            AI actions: write the step as “AI: add the cheapest product to the cart” (or action <code>ai</code> with the instruction as value): the AI
            carries it out on the live page and later runs replay what worked; use <code>{'{{secrets.NAME}}'}</code> for passwords, the AI never sees them.
            Speed: assert_performance (optional target page to load fresh; value <code>{'{"lcp": 2500, "cls": 0.1, "tbt": 200, "max_regression": 0.25}'}</code>),
            or “Verify the page loads in under 2 seconds”.
            Test data: <code>{'{{data.column}}'}</code> (row of the data set), <code>{'{{fake.email}}'}</code> or <code>{'{{fake.email:buyer}}'}</code> (fictitious
            values: the same kind and label give the same value within a test, so a later step can check it), <code>{'{{secrets.NAME}}'}</code>.
            Targets can be CSS selectors (#id, .class), <code>text=Visible text</code>, or a plain label like “Sign in button”.
            Salesforce: salesforce_login (target = persona), assert_object_access (target = Account, value <code>{'{"read": true, "delete": false}'}</code>),
            assert_field_access (Account.AnnualRevenue), assert_record_access (record Id), assert_profile, assert_access_denied.
            Per-persona expectations: <code>{'{"by_persona": {"admin": {"delete": true}, "rep": {"delete": false}}}'}</code>;
            limit a step with <code>{'{"only_personas": ["rep"]}'}</code>.
          </p>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="tc-expected">Expected results (one per line)</label>
          <textarea id="tc-expected" className="form-control" rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>

        <div className="flex gap-3">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !title.trim() || !module.trim()}>
            {saving ? 'Saving…' : '✓ Save'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
