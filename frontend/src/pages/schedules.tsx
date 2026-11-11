/**
 * Schedules — run agents automatically on a cron schedule.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate, shortId } from '../lib/api';
import { useSession } from '../lib/session';

const PRESETS = [
  { label: 'Every weekday at 06:00', cron: '0 6 * * 1-5' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Mondays at 08:30', cron: '30 8 * * 1' },
];

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export default function SchedulesPage() {
  const session = useSession();
  const canEdit = session.can('editor');
  const [schedules, setSchedules] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [cron, setCron] = useState(PRESETS[0].cron);
  const [timezone, setTimezone] = useState('UTC');

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.get('/schedules'), api.get('/agents')]);
      setSchedules(s.data);
      setAgents(a.data);
      setAgentId((cur) => cur || a.data[0]?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { load(); setTimezone(browserTz()); }, [load]);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    act(() => api.post('/schedules', { agentId, name: name || undefined, cron, timezone }), 'Schedule created').then(() => setName(''));
  };

  return (
    <Layout title="Schedules">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {canEdit && (
        agents.length === 0 ? (
          <div className="alert alert-info">Create an agent first, then schedule it here.</div>
        ) : (
          <form className="card mb-6" onSubmit={create}>
            <div className="card-header"><h3>＋ New schedule</h3></div>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, alignItems: 'end' }}>
              <div>
                <label className="form-label" htmlFor="sch-agent">Agent</label>
                <select id="sch-agent" className="form-control" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="sch-name">Name</label>
                <input id="sch-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly regression" />
              </div>
              <div>
                <label className="form-label" htmlFor="sch-preset">When</label>
                <select id="sch-preset" className="form-control" value={PRESETS.some((p) => p.cron === cron) ? cron : 'custom'}
                  onChange={(e) => e.target.value !== 'custom' && setCron(e.target.value)}>
                  {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
                  <option value="custom">Custom cron…</option>
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="sch-cron">Cron (min hour day month weekday)</label>
                <input id="sch-cron" className="form-control code" value={cron} onChange={(e) => setCron(e.target.value)} required />
              </div>
              <div>
                <label className="form-label" htmlFor="sch-tz">Timezone</label>
                <input id="sch-tz" className="form-control" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Rome" required />
              </div>
              <button className="btn btn-primary btn-sm" type="submit">Create schedule</button>
            </div>
          </form>
        )
      )}

      <div className="card">
        {schedules.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⏰</div>
            <h3>No schedules</h3>
            <p>Run regression suites every night or before business hours, automatically.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Schedule</th><th>Agent</th><th>When</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="fw-600">{s.name}</div>
                      <span className={s.enabled ? 'badge badge-success' : 'badge badge-neutral'}>{s.enabled ? 'enabled' : 'paused'}</span>
                    </td>
                    <td><Link href={`/agents/${s.agentId}`}>{s.agentName}</Link></td>
                    <td className="text-sm"><span className="code">{s.cron}</span><div className="text-muted">{s.timezone}</div></td>
                    <td className="text-sm">{s.enabled ? formatDate(s.nextRunAt) : '—'}</td>
                    <td className="text-sm">
                      {s.lastRunId ? <Link href={`/runs/${s.lastRunId}`} className="code">{shortId(s.lastRunId)}</Link> : '—'}
                      {s.lastRunAt && <div className="text-muted">{formatDate(s.lastRunAt)}</div>}
                      {s.lastError && <div className="text-danger">{s.lastError}</div>}
                    </td>
                    <td>
                      {canEdit && (
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.post(`/schedules/${s.id}/run`), `“${s.name}” started`)}>Run now</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.put(`/schedules/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? 'Pause' : 'Resume'}</button>
                          <button className="btn btn-danger btn-sm" onClick={() => confirm(`Delete schedule “${s.name}”?`) && act(() => api.delete(`/schedules/${s.id}`))}>Delete</button>
                        </div>
                      )}
                    </td>
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
