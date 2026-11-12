/**
 * Notifications — project channels (webhook, Slack, Teams, email) that fire
 * when runs complete, fail or are cancelled.
 */

import { useCallback, useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { api, errorMessage, formatDate, REDACTED } from '../../lib/api';
import { useSession } from '../../lib/session';

const TYPES = [
  { value: 'slack', label: 'Slack (incoming webhook)', field: 'webhookUrl', placeholder: 'https://hooks.slack.com/services/…' },
  { value: 'teams', label: 'Microsoft Teams (workflow webhook)', field: 'webhookUrl', placeholder: 'https://….webhook.office.com/…' },
  { value: 'webhook', label: 'Webhook (signed JSON)', field: 'url', placeholder: 'https://ci.example.com/hooks/tests' },
  { value: 'email', label: 'Email', field: 'recipients', placeholder: 'qa-team@example.com, lead@example.com' },
];
const EVENTS = [
  { value: 'run.failed', label: 'Run failed' },
  { value: 'run.completed', label: 'Run passed' },
  { value: 'run.cancelled', label: 'Run cancelled' },
  { value: 'auth.session_expiring', label: 'Saved sign-in expiring (needs a person)' },
  { value: 'digest.daily', label: 'Daily digest (one message every morning)' },
];

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export default function NotificationsPage() {
  const session = useSession();
  const canEdit = session.can('admin');
  const [channels, setChannels] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [type, setType] = useState('slack');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>(['run.failed']);
  const [digestTime, setDigestTime] = useState('07:00');
  const [digestTz, setDigestTz] = useState('UTC');
  useEffect(() => { setDigestTz(browserTz()); }, []);

  const load = useCallback(async () => {
    try {
      setChannels((await api.get('/notifications')).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const typeMeta = TYPES.find((t) => t.value === type)!;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const config: Record<string, any> = type === 'email'
      ? { recipients: target.split(',').map((s) => s.trim()).filter(Boolean) }
      : { [typeMeta.field]: target.trim(), ...(type === 'webhook' && secret ? { secret } : {}) };
    if (events.includes('digest.daily')) Object.assign(config, { digest_time: digestTime, digest_timezone: digestTz });
    try {
      await api.post('/notifications', { name, type, config, events });
      setName(''); setTarget(''); setSecret('');
      setNotice('Channel created. Use “Send test” to check it.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (ok) setNotice(ok);
      await load();
      return res;
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const describeTarget = (c: any) => {
    if (c.type === 'email') return (c.config.recipients ?? []).join(', ');
    if (c.type === 'webhook') return `${c.config.url}${c.config.secret ? ' · signed' : ''}`;
    return c.config.webhookUrl === REDACTED ? 'webhook URL stored (hidden)' : c.config.webhookUrl;
  };

  return (
    <Layout title="Notifications">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {canEdit && (
        <form className="card mb-6" onSubmit={create}>
          <div className="card-header"><h3>＋ New channel</h3></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="ch-name">Name *</label>
                <input id="ch-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="QA channel" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="ch-type">Type</label>
                <select id="ch-type" className="form-control" value={type} onChange={(e) => { setType(e.target.value); setTarget(''); }}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label" htmlFor="ch-target">{type === 'email' ? 'Recipients (comma separated)' : 'URL'} *</label>
                <input id="ch-target" className="form-control" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={typeMeta.placeholder} required />
              </div>
              {type === 'webhook' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="ch-secret">Signing secret</label>
                  <input id="ch-secret" type="password" className="form-control" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="optional" autoComplete="off" />
                  <p className="form-hint">Requests carry <code>X-ATAB-Signature: sha256=HMAC(secret, body)</code>.</p>
                </div>
              )}
            </div>
            <div className="form-group">
              <div className="form-label">Send on</div>
              <div className="chip-group">
                {EVENTS.map((ev) => (
                  <div key={ev.value} role="checkbox" aria-checked={events.includes(ev.value)} tabIndex={0}
                    className={`chip${events.includes(ev.value) ? ' selected' : ''}`}
                    onClick={() => setEvents((p) => (p.includes(ev.value) ? p.filter((x) => x !== ev.value) : [...p, ev.value]))}
                    onKeyDown={(e) => e.key === ' ' && setEvents((p) => (p.includes(ev.value) ? p.filter((x) => x !== ev.value) : [...p, ev.value]))}>
                    {ev.label}
                  </div>
                ))}
              </div>
            </div>
            {events.includes('digest.daily') && (
              <div className="flex gap-2 mb-3" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
                <div>
                  <label className="form-label" htmlFor="ch-digest-time">Digest time</label>
                  <input id="ch-digest-time" type="time" className="form-control" value={digestTime} onChange={(e) => setDigestTime(e.target.value)} />
                </div>
                <div>
                  <label className="form-label" htmlFor="ch-digest-tz">Time zone</label>
                  <input id="ch-digest-tz" className="form-control" value={digestTz} onChange={(e) => setDigestTz(e.target.value)} placeholder="Europe/Rome" />
                </div>
                <p className="form-hint">Every morning: each agent&apos;s last 24 h, new and still-failing tests, flaky re-runs, sign-ins that need a person.</p>
              </div>
            )}
            <button className="btn btn-primary btn-sm" type="submit" disabled={events.length === 0}>Create channel</button>
          </div>
        </form>
      )}

      <div className="card">
        <div className="card-header"><h3>Channels</h3></div>
        {channels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔔</div>
            <h3>No channels yet</h3>
            <p>Get told in Slack, Teams, email or your own systems when a run fails.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Channel</th><th>Target</th><th>Events</th><th>Last delivery</th><th></th></tr></thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="fw-600">{c.name}</div>
                      <div className="text-sm text-muted">{c.type}{!c.enabled ? ' · disabled' : ''}</div>
                    </td>
                    <td className="text-sm" style={{ maxWidth: 280, wordBreak: 'break-all' }}>{describeTarget(c)}</td>
                    <td className="text-sm">{c.events.join(', ')}{c.events.includes('digest.daily') && <div className="text-muted">digest at {c.config?.digest_time ?? '07:00'} {c.config?.digest_timezone ?? 'UTC'}</div>}</td>
                    <td className="text-sm">
                      {c.lastDelivery ? (
                        <>
                          <span className={c.lastDelivery.status === 'sent' ? 'badge badge-success' : 'badge badge-danger'}>{c.lastDelivery.status}</span>
                          <div className="text-muted">{formatDate(c.lastDelivery.at)}</div>
                          {c.lastDelivery.error && <div className="text-danger">{c.lastDelivery.error}</div>}
                        </>
                      ) : <span className="text-muted">never</span>}
                    </td>
                    <td>
                      {canEdit && (
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => act(async () => {
                            const res = await api.post(`/notifications/${c.id}/test`).catch((e) => e.response);
                            if (!res?.data?.ok) throw new Error(res?.data?.error ?? 'Delivery failed');
                          }, `Test sent to “${c.name}”`)}>Send test</button>
                          {c.events.includes('digest.daily') && (
                            <button className="btn btn-secondary btn-sm" onClick={() => act(async () => {
                              const res = await api.post(`/notifications/${c.id}/digest`).catch((e) => e.response);
                              if (!res?.data?.ok) throw new Error(res?.data?.error ?? 'Delivery failed');
                            }, `Digest sent to “${c.name}”`)}>Send digest now</button>
                          )}
                          <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.put(`/notifications/${c.id}`, { enabled: !c.enabled }))}>{c.enabled ? 'Disable' : 'Enable'}</button>
                          <button className="btn btn-danger btn-sm" onClick={() => confirm(`Delete channel “${c.name}”?`) && act(() => api.delete(`/notifications/${c.id}`))}>Delete</button>
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
