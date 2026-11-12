/**
 * Sign-in & MFA: login profiles of any application (test users with their
 * credentials and authenticator key), a check that signs in now, and the
 * saved sessions (also Salesforce personas') that runs reuse.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDate, REDACTED } from '../lib/api';

interface Profile {
  name: string;
  previous_name?: string;
  description?: string;
  login_url?: string;
  username?: string;
  password?: string;
  totp_secret?: string;
  landing_path?: string;
  success?: { url_contains?: string; selector?: string };
  session?: { reuse?: boolean; max_age_hours?: number };
}

interface Props {
  agentId: string;
  config: any;
  canAdmin: boolean;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

const EMPTY: Profile = { name: '', login_url: 'login', username: '', password: '', totp_secret: '' };

const until = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600_000);
  return h >= 48 ? `${Math.round(h / 24)} days left` : h >= 1 ? `${h} h left` : `${Math.max(1, Math.round(ms / 60_000))} min left`;
};

export default function SignInCard({ agentId, config, canAdmin, canEdit, onSaved }: Props) {
  const auth = config.auth ?? {};
  const profiles: Profile[] = auth.profiles ?? [];
  const [editing, setEditing] = useState<Profile | null>(null);
  const [defaultProfile, setDefaultProfile] = useState<string>(auth.default_profile ?? '');
  const [sessions, setSessions] = useState<any[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      setSessions((await api.get(`/agents/${agentId}/auth/sessions`)).data);
    } catch {
      setSessions([]);
    }
  }, [agentId]);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = (next: Profile[], def = defaultProfile) => act('save', async () => {
    const res = await api.put(`/agents/${agentId}`, { config: { auth: { ...auth, default_profile: def || undefined, profiles: next } } });
    onSaved(res.data);
    await loadSessions();
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const p: Profile = {
      ...editing,
      name: editing.name.trim(),
      username: editing.username?.trim(),
      login_url: editing.login_url?.trim() || undefined,
      landing_path: editing.landing_path?.trim() || undefined,
      // Blank = keep the stored secret
      password: editing.password || (editing.previous_name !== undefined && profiles.find((x) => x.name === editing.previous_name)?.password ? REDACTED : undefined),
      totp_secret: editing.totp_secret?.trim() || (editing.previous_name !== undefined && profiles.find((x) => x.name === editing.previous_name)?.totp_secret ? REDACTED : undefined),
    };
    const index = profiles.findIndex((x) => x.name === (editing.previous_name ?? editing.name));
    const next = index >= 0 ? profiles.map((x, i) => (i === index ? p : x)) : [...profiles, p];
    await save(next);
    setNotice(`Login profile “${p.name}” saved`);
    setEditing(null);
  };

  const remove = (name: string) => {
    if (!window.confirm(`Delete login profile ${name}? Tests that sign in as ${name} will fail.`)) return;
    save(profiles.filter((p) => p.name !== name), defaultProfile === name ? '' : defaultProfile);
  };

  const verify = (name: string, fresh: boolean) => act(`verify-${name}`, async () => {
    const res = await api.post(`/agents/${agentId}/auth/profiles/${encodeURIComponent(name)}/verify`, { fresh });
    setResults((r) => ({ ...r, [name]: res.data }));
    await loadSessions();
  });

  const forget = (kind: string, identity: string) => act(`forget-${kind}-${identity}`, async () => {
    await api.delete(`/agents/${agentId}/auth/sessions`, { params: { kind, identity } });
    await loadSessions();
    setNotice(`Saved session of ${identity} forgotten: the next run signs in again`);
  });

  const sessionOf = (kind: string, name: string) => sessions.find((s) => s.kind === kind && s.identity === name);
  const sfPersonas: any[] = config.salesforce?.personas ?? [];

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>🔐 Sign-in &amp; MFA</h3>
        <span className="text-sm text-muted">test users of any application · authenticator codes · saved sessions</span>
      </div>
      <div className="card-body">
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        {notice && <div className="alert alert-success" role="status">{notice}</div>}
        <p className="text-sm text-muted mb-3">
          Tests start signed in: the sign-in form is filled for you (two-step forms too), the authenticator code is typed when asked, and the
          session is kept, encrypted, for the next tests and runs. “Remember this device” is ticked, so most applications stop asking for MFA.
        </p>

        {profiles.length > 0 ? (
          <div className="table-wrapper mb-3">
            <table className="data-table" aria-label="Login profiles">
              <thead><tr><th>Profile</th><th>User</th><th>MFA</th><th>Saved session</th><th></th></tr></thead>
              <tbody>
                {profiles.map((p) => {
                  const s = sessionOf('app', p.name);
                  const r = results[p.name];
                  return (
                    <tr key={p.name}>
                      <td>
                        <div className="fw-600">{p.name}{defaultProfile === p.name && <span className="badge badge-info" style={{ marginLeft: 6 }}>default</span>}</div>
                        <div className="text-sm text-muted code">{p.login_url || 'login'}</div>
                      </td>
                      <td className="text-sm">{p.username}</td>
                      <td className="text-sm">{p.totp_secret ? '🔑 authenticator key' : <span className="text-muted">none</span>}</td>
                      <td className="text-sm" data-testid={`session-${p.name}`}>
                        {s ? <>{s.expired ? <span className="text-danger">expired</span> : until(s.expiresAt)}<div className="text-muted">since {formatDate(s.capturedAt)}</div></> : <span className="text-muted">none yet</span>}
                        {r && (
                          <div className={r.ok ? 'text-success' : 'text-danger'} style={{ maxWidth: 360 }}>
                            {r.ok ? `✓ ${r.message}` : `✗ ${r.error}`}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          {canEdit && <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => verify(p.name, !s)}>{busy === `verify-${p.name}` ? 'Signing in…' : 'Test sign-in'}</button>}
                          {canEdit && s && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => forget('app', p.name)}>Forget session</button>}
                          {canAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...p, previous_name: p.name, password: '', totp_secret: '' })}>Edit</button>}
                          {canAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(p.name)}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted">No login profiles yet.</p>}

        {canAdmin && profiles.length > 0 && (
          <div className="flex gap-2 mb-3" style={{ alignItems: 'center' }}>
            <label className="form-label" htmlFor="auth-default" style={{ margin: 0 }}>Tests start signed in as</label>
            <select id="auth-default" className="form-control" style={{ maxWidth: 240 }} value={defaultProfile} onChange={(e) => { setDefaultProfile(e.target.value); save(profiles, e.target.value); }}>
              <option value="">nobody (tests sign in themselves)</option>
              {profiles.map((p) => <option key={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}

        {canAdmin && !editing && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing({ ...EMPTY })}>＋ Add login profile</button>}

        {editing && (
          <form onSubmit={submit} aria-label="Login profile" className="mt-3" style={{ background: 'var(--gray-50)', padding: 12, borderRadius: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <div>
                <label className="form-label" htmlFor="lp-name">Name</label>
                <input id="lp-name" className="form-control" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="buyer, admin, read_only" required />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-url">Sign-in page</label>
                <input id="lp-url" className="form-control" value={editing.login_url ?? ''} onChange={(e) => setEditing({ ...editing, login_url: e.target.value })} placeholder="/login or https://login.example.com" />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-user">User name / email</label>
                <input id="lp-user" className="form-control" value={editing.username ?? ''} onChange={(e) => setEditing({ ...editing, username: e.target.value })} autoComplete="off" required />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-pw">Password</label>
                <input id="lp-pw" className="form-control" type="password" value={editing.password ?? ''} onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                  placeholder={editing.previous_name ? 'unchanged' : ''} autoComplete="new-password" />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-totp">Authenticator key (optional)</label>
                <input id="lp-totp" className="form-control code" type="password" value={editing.totp_secret ?? ''} onChange={(e) => setEditing({ ...editing, totp_secret: e.target.value })}
                  placeholder={editing.previous_name ? 'unchanged' : 'Base32 key or otpauth:// link'} autoComplete="off" />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-landing">Page after sign-in (optional)</label>
                <input id="lp-landing" className="form-control" value={editing.landing_path ?? ''} onChange={(e) => setEditing({ ...editing, landing_path: e.target.value })} placeholder="/dashboard" />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-success">Signed in when the URL contains (optional)</label>
                <input id="lp-success" className="form-control" value={editing.success?.url_contains ?? ''} onChange={(e) => setEditing({ ...editing, success: { ...editing.success, url_contains: e.target.value || undefined } })} placeholder="/home" />
              </div>
              <div>
                <label className="form-label" htmlFor="lp-age">Keep the session for (hours)</label>
                <input id="lp-age" className="form-control" type="number" min={1} value={editing.session?.max_age_hours ?? 12} onChange={(e) => setEditing({ ...editing, session: { ...editing.session, max_age_hours: Number(e.target.value) } })} />
              </div>
            </div>
            <p className="form-hint mt-2">
              Authenticator key: when you add an authenticator app for this user, choose “Can’t scan the QR code?” and copy the key, or copy the otpauth:// link.
              Secrets are encrypted and never shown again.
            </p>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null}>Save profile</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        )}

        {sfPersonas.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-2">Salesforce personas</h4>
            <ul className="text-sm" style={{ margin: '0 0 0 18px' }}>
              {sfPersonas.map((p) => {
                const s = sessionOf('salesforce', p.name);
                return (
                  <li key={p.name} className="mb-1">
                    <strong>{p.name}</strong>: {s ? <>{s.expired ? 'session expired' : `session saved, ${until(s.expiresAt)}`}{canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => forget('salesforce', p.name)}>Forget</button>}</> : <span className="text-muted">no saved session</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
