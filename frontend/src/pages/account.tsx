/**
 * Account — change password and manage personal API keys.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate, PROJECT_ROLES_LIST } from '../lib/api';
import { useSession } from '../lib/session';

export default function AccountPage() {
  const router = useRouter();
  const session = useSession();
  const mustChange = router.query.mustChange === '1' || session.user?.mustChangePassword;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [minLength, setMinLength] = useState(12);

  const [keys, setKeys] = useState<any[]>([]);
  const [keyName, setKeyName] = useState('');
  const [keyProject, setKeyProject] = useState('');
  const [keyRole, setKeyRole] = useState('');
  const [keyDays, setKeyDays] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setKeys((await api.get('/auth/api-keys')).data);
    } catch (err) {
      setKeyError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    api.get('/auth/config').then((r) => setMinLength(r.data.passwordMinLength ?? 12)).catch(() => undefined);
    if (!mustChange) loadKeys();
  }, [loadKeys, mustChange]);

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (next !== confirm) {
      setPwMsg({ ok: false, text: 'The new passwords do not match' });
      return;
    }
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      setPwMsg({ ok: true, text: 'Password changed.' });
      if (mustChange) window.location.href = '/';
    } catch (err) {
      setPwMsg({ ok: false, text: errorMessage(err) });
    }
  };

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError(null);
    setNewKey(null);
    try {
      const res = await api.post('/auth/api-keys', {
        name: keyName || 'API key',
        projectId: keyProject || undefined,
        role: keyRole || undefined,
        expiresInDays: keyDays ? Number(keyDays) : undefined,
      });
      setNewKey(res.data.apiKey);
      setKeyName('');
      await loadKeys();
    } catch (err) {
      setKeyError(errorMessage(err));
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this API key? Clients using it will stop working.')) return;
    try {
      await api.delete(`/auth/api-keys/${id}`);
      await loadKeys();
    } catch (err) {
      setKeyError(errorMessage(err));
    }
  };

  return (
    <Layout title="Account">
      <div style={{ maxWidth: 760 }}>
        {mustChange && (
          <div className="alert alert-warning">You must choose a new password before using the application.</div>
        )}

        {session.authEnabled && (
          <form className="card mb-6" onSubmit={changePassword}>
            <div className="card-header"><h3>🔑 Change password</h3></div>
            <div className="card-body">
              {pwMsg && <div className={`alert ${pwMsg.ok ? 'alert-success' : 'alert-error'}`}>{pwMsg.text}</div>}
              <div className="form-group">
                <label className="form-label" htmlFor="pw-current">Current password</label>
                <input id="pw-current" type="password" className="form-control" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="pw-new">New password</label>
                <input id="pw-new" type="password" className="form-control" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
                <p className="form-hint">At least {minLength} characters, with 3 of: lowercase, uppercase, digit, symbol.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="pw-confirm">Confirm new password</label>
                <input id="pw-confirm" type="password" className="form-control" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </div>
              <button className="btn btn-primary btn-sm" type="submit">Change password</button>
            </div>
          </form>
        )}

        {!mustChange && (
          <div className="card">
            <div className="card-header"><h3>🗝️ API keys</h3></div>
            <div className="card-body">
              <p className="form-hint mb-4">
                Use API keys for CI pipelines and integrations: <code>Authorization: ApiKey &lt;key&gt;</code>.
                Limit a key to one project and a maximum role to follow least privilege.
              </p>
              {keyError && <div className="alert alert-error">⚠️ {keyError}</div>}
              {newKey && (
                <div className="alert alert-success">
                  Copy this key now. It will not be shown again:
                  <div className="code" style={{ marginTop: 6, wordBreak: 'break-all', userSelect: 'all' }} data-testid="new-api-key">{newKey}</div>
                </div>
              )}
              <form onSubmit={createKey} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'end', marginBottom: 16 }}>
                <div>
                  <label className="form-label" htmlFor="key-name">Name</label>
                  <input id="key-name" className="form-control" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="ci-pipeline" />
                </div>
                <div>
                  <label className="form-label" htmlFor="key-project">Project</label>
                  <select id="key-project" className="form-control" value={keyProject} onChange={(e) => setKeyProject(e.target.value)}>
                    <option value="">All my projects</option>
                    {session.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label" htmlFor="key-role">Max role</label>
                  <select id="key-role" className="form-control" value={keyRole} onChange={(e) => setKeyRole(e.target.value)}>
                    <option value="">Same as mine</option>
                    {PROJECT_ROLES_LIST.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label" htmlFor="key-days">Expires (days)</label>
                  <input id="key-days" type="number" min={1} max={3650} className="form-control" value={keyDays} onChange={(e) => setKeyDays(e.target.value)} placeholder="never" />
                </div>
                <button className="btn btn-primary btn-sm" type="submit">Create key</button>
              </form>

              {keys.length === 0 ? <p className="text-muted text-sm">No API keys yet.</p> : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead><tr><th>Name</th><th>Prefix</th><th>Scope</th><th>Status</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id}>
                          <td>{k.name}</td>
                          <td className="code">{k.prefix ? `${k.prefix}…` : '—'}</td>
                          <td className="text-sm">{k.projectName ?? 'all projects'}{k.role ? ` · ≤ ${k.role}` : ''}</td>
                          <td><span className={k.active ? 'badge badge-success' : 'badge badge-neutral'}>{k.active ? 'active' : 'revoked'}</span></td>
                          <td className="text-sm text-muted">{formatDate(k.lastUsedAt)}</td>
                          <td className="text-sm text-muted">{k.expiresAt ? formatDate(k.expiresAt) : 'never'}</td>
                          <td>{k.active && <button className="btn btn-danger btn-sm" onClick={() => revoke(k.id)}>Revoke</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
