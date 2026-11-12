/**
 * Unattended runs (scheduled, CI, API): pre-flight checks, re-running failures,
 * maximum duration, starting interrupted runs again.
 */

import { useState } from 'react';
import { api, errorMessage } from '../lib/api';

interface Props {
  agentId: string;
  config: any;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

export default function UnattendedCard({ agentId, config, canEdit, onSaved }: Props) {
  const u = config.unattended ?? {};
  const [form, setForm] = useState({
    preflight: u.preflight !== false,
    retries: String(u.preflight_retries ?? 3),
    wait: String(Math.round((u.preflight_wait_seconds ?? 300) / 60)),
    rerun: u.rerun_failed === true ? 'always' : u.rerun_failed === false ? 'never' : 'auto',
    maxMinutes: String(u.max_run_minutes ?? 240),
    resume: u.resume_interrupted !== false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.put(`/agents/${agentId}`, {
        config: {
          unattended: {
            preflight: form.preflight,
            preflight_retries: Number(form.retries),
            preflight_wait_seconds: Number(form.wait) * 60,
            rerun_failed: form.rerun === 'always' ? true : form.rerun === 'never' ? false : 'auto',
            max_run_minutes: Number(form.maxMinutes),
            resume_interrupted: form.resume,
          },
        },
      });
      onSaved(res.data);
      setMessage({ ok: true, text: 'Unattended run settings saved' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card mb-6" onSubmit={save} aria-label="Unattended runs">
      <div className="card-header">
        <h3>🌙 Unattended runs</h3>
        <span className="text-sm text-muted">schedules · CI · API · nightly</span>
      </div>
      <div className="card-body">
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</div>}
        <label className="flex gap-2 mb-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={form.preflight} onChange={(e) => set({ preflight: e.target.checked })} disabled={!canEdit} />
          Check the application answers before running; if not, wait and retry, then fail the run once with the reason (instead of failing every test)
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <div>
            <label className="form-label" htmlFor="ua-retries">Pre-flight retries</label>
            <input id="ua-retries" className="form-control" type="number" min={0} max={20} value={form.retries} onChange={(e) => set({ retries: e.target.value })} disabled={!canEdit || !form.preflight} />
          </div>
          <div>
            <label className="form-label" htmlFor="ua-wait">Minutes between retries</label>
            <input id="ua-wait" className="form-control" type="number" min={1} max={60} value={form.wait} onChange={(e) => set({ wait: e.target.value })} disabled={!canEdit || !form.preflight} />
          </div>
          <div>
            <label className="form-label" htmlFor="ua-rerun">Re-run failed tests at the end</label>
            <select id="ua-rerun" className="form-control" value={form.rerun} onChange={(e) => set({ rerun: e.target.value })} disabled={!canEdit}>
              <option value="auto">When nobody watches (schedules, CI, API)</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="ua-max">Stop a run after (minutes)</label>
            <input id="ua-max" className="form-control" type="number" min={1} value={form.maxMinutes} onChange={(e) => set({ maxMinutes: e.target.value })} disabled={!canEdit} />
          </div>
        </div>
        <label className="flex gap-2 mt-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={form.resume} onChange={(e) => set({ resume: e.target.checked })} disabled={!canEdit} />
          Start a scheduled / CI run again when a server restart interrupted it
        </label>
        <p className="form-hint mt-2">
          Failed tests re-run in a fresh browser; a test that passes then is counted as passed and flagged as likely flaky (it feeds the quarantine).
          Get one message every morning with a <strong>Daily digest</strong> channel (Settings → Notifications).
        </p>
        {canEdit && <button className="btn btn-secondary btn-sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
    </form>
  );
}
