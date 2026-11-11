/**
 * Agent-level quality settings: accessibility scan of every test, trace/video
 * evidence, AI self-healing (and saving repaired selectors), and the visual
 * baselines this agent's screenshot checks compare against.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, artifactUrl, errorMessage, formatDate } from '../lib/api';

interface Props {
  agentId: string;
  config: any;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

const EVIDENCE = [
  { value: 'on_failure', label: 'When a test fails' },
  { value: 'always', label: 'Always' },
  { value: 'off', label: 'Never' },
];

export default function AgentQualityCard({ agentId, config, canEdit, onSaved }: Props) {
  const [form, setForm] = useState(() => ({
    accessibility: config.checks?.accessibility ?? 'off',
    level: config.checks?.accessibility_options?.level ?? 'wcag21aa',
    minImpact: config.checks?.accessibility_options?.minImpact ?? 'serious',
    trace: config.evidence?.trace ?? 'on_failure',
    video: config.evidence?.video ?? 'on_failure',
    selfHealing: !!config.ai?.self_healing,
    autoApply: !!config.ai?.auto_apply_healing,
  }));
  const [baselines, setBaselines] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadBaselines = useCallback(async () => {
    try {
      setBaselines((await api.get(`/visual/baselines?agentId=${encodeURIComponent(agentId)}`)).data);
    } catch {
      setBaselines([]);
    }
  }, [agentId]);
  useEffect(() => { loadBaselines(); }, [loadBaselines]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.put(`/agents/${agentId}`, {
        config: {
          checks: { accessibility: form.accessibility, accessibility_options: { level: form.level, minImpact: form.minImpact } },
          evidence: { trace: form.trace, video: form.video },
          ai: { ...(config.ai ?? {}), self_healing: form.selfHealing, auto_apply_healing: form.selfHealing && form.autoApply },
        },
      });
      onSaved(res.data);
      setMessage({ ok: true, text: 'Quality settings saved' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const removeBaseline = async (b: any) => {
    if (!window.confirm(`Delete the baseline “${b.name}”? The next run will record a new one.`)) return;
    try {
      await api.delete(`/visual/baselines/${b.id}`);
      await loadBaselines();
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>✅ Quality checks</h3>
        <span className="text-sm text-muted">accessibility · evidence · self-healing · visual baselines</span>
      </div>
      <div className="card-body">
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</div>}
        <form onSubmit={save}>
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label" htmlFor="q-a11y">Accessibility scan after every test</label>
                <select id="q-a11y" className="form-control" value={form.accessibility} onChange={(e) => set({ accessibility: e.target.value })}>
                  <option value="off">Off (only assert_accessible steps)</option>
                  <option value="report">Report violations</option>
                  <option value="fail">Fail the test on violations</option>
                </select>
                <div className="form-hint">Scans the page each test ends on with axe-core.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="q-level">Standard and minimum impact</label>
                <div className="flex gap-2">
                  <select id="q-level" className="form-control" value={form.level} onChange={(e) => set({ level: e.target.value })} aria-label="WCAG level">
                    <option value="wcag2a">WCAG 2.0 A</option>
                    <option value="wcag2aa">WCAG 2.0 AA</option>
                    <option value="wcag21aa">WCAG 2.1 AA</option>
                    <option value="wcag22aa">WCAG 2.2 AA</option>
                  </select>
                  <select className="form-control" value={form.minImpact} onChange={(e) => set({ minImpact: e.target.value })} aria-label="Minimum impact">
                    <option value="critical">critical</option>
                    <option value="serious">serious+</option>
                    <option value="moderate">moderate+</option>
                    <option value="minor">all</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="q-trace">Keep Playwright trace</label>
                <select id="q-trace" className="form-control" value={form.trace} onChange={(e) => set({ trace: e.target.value })}>
                  {EVIDENCE.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <div className="form-hint">Every action, DOM snapshot, network call and console line. Secrets are masked.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="q-video">Keep video</label>
                <select id="q-video" className="form-control" value={form.video} onChange={(e) => set({ video: e.target.value })}>
                  {EVIDENCE.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="flex gap-2" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={form.selfHealing} onChange={(e) => set({ selfHealing: e.target.checked })} />
                AI self-healing: repair broken selectors during runs (needs an AI provider)
              </label>
              <label className="flex gap-2 mt-2" style={{ alignItems: 'center', opacity: form.selfHealing ? 1 : 0.5 }}>
                <input type="checkbox" checked={form.autoApply} disabled={!form.selfHealing} onChange={(e) => set({ autoApply: e.target.checked })} />
                Save repaired selectors to the test cases automatically (otherwise: review them on the run page)
              </label>
            </div>
            {canEdit && <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save quality settings'}</button>}
          </fieldset>
        </form>

        <h4 className="mt-4 mb-2">Visual baselines</h4>
        {baselines.length === 0 ? (
          <p className="text-sm text-muted">
            None yet. Add an <code>assert_screenshot</code> step (target: an element, or none for the page): the first run records
            the baseline, later runs compare against it.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {baselines.map((b) => (
              <figure key={b.id} style={{ margin: 0 }} data-testid={`baseline-${b.name}`}>
                <a href={artifactUrl(b.image)} target="_blank" rel="noreferrer">
                  <img src={artifactUrl(b.image)} alt={`Baseline ${b.name}`} style={{ width: '100%', maxHeight: 140, objectFit: 'contain', background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 6 }} />
                </a>
                <figcaption className="text-sm">
                  <div className="fw-600" style={{ wordBreak: 'break-all' }}>{b.name}</div>
                  <div className="text-muted">{b.viewport}{b.persona ? ` · ${b.persona}` : ''} · {formatDate(b.updatedAt)}{b.approvedBy ? ` · ${b.approvedBy}` : ''}</div>
                  {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeBaseline(b)} aria-label={`Delete baseline ${b.name}`}>Delete</button>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
