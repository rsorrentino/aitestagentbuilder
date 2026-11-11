/**
 * Salesforce org connection and personas: named test users (administrator,
 * sales rep, read-only…) with their own login method. Credentials are
 * write-only: the API returns a placeholder and keeps the stored value.
 */

import { Fragment, useState } from 'react';
import axios from 'axios';
import { api, BACKEND_URL, errorMessage, REDACTED } from '../lib/api';

export const AUTH_METHODS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'password', label: 'Username + password (UI)', hint: 'Plain UI login. Works when MFA is not triggered, e.g. from a trusted IP range.' },
  { value: 'password_totp', label: 'Username + password + authenticator code', hint: 'UI login with MFA: codes are generated from the authenticator (TOTP) secret.' },
  { value: 'jwt', label: 'OAuth JWT bearer → UI (recommended for admins)', hint: 'Connected app with a certificate; the user must be pre-authorized. Opens the UI through frontdoor — no password or MFA prompt.' },
  { value: 'oauth_password', label: 'OAuth username-password → UI (legacy)', hint: 'Needs consumer key + secret and the user’s security token. Blocked by default in newer orgs.' },
  { value: 'login_as', label: '“Log in as” from an admin persona', hint: 'An administrator persona logs in and uses Log in as on this user. Needs “Manage Users” and admin login-as enabled.' },
];

interface Persona {
  name: string;
  previous_name?: string;
  description?: string;
  auth_method: string;
  username: string;
  password?: string;
  totp_secret?: string;
  security_token?: string;
  login_as_via?: string;
  landing_path?: string;
  expected_profile?: string;
  expected_permission_sets?: string[];
}

interface Props {
  agentId: string;
  baseUrl: string;
  salesforce: any;
  canAdmin: boolean;
  canVerify: boolean;
  onSaved: (agent: any) => void;
}

const EMPTY: Persona = { name: '', auth_method: 'password_totp', username: '' };

export default function SalesforcePersonasCard({ agentId, baseUrl, salesforce, canAdmin, canVerify, onSaved }: Props) {
  const sf = salesforce ?? {};
  const personas: Persona[] = sf.personas ?? [];
  const app = sf.connected_app ?? {};
  const [org, setOrg] = useState({
    login_url: sf.login_url ?? '',
    instance_url: sf.instance_url ?? '',
    default_persona: sf.default_persona ?? '',
    api_persona: sf.api_persona ?? '',
    frontdoor_mode: sf.frontdoor_mode ?? 'auto',
    client_id: app.client_id ?? '',
    client_secret: '',
    private_key: '',
  });
  const [editing, setEditing] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});

  const save = async (nextPersonas: Persona[], orgOverride = org, extra: Record<string, any> = {}) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        ...sf,
        login_url: orgOverride.login_url || undefined,
        instance_url: orgOverride.instance_url || undefined,
        default_persona: orgOverride.default_persona || undefined,
        api_persona: orgOverride.api_persona || undefined,
        frontdoor_mode: orgOverride.frontdoor_mode,
        connected_app: {
          client_id: orgOverride.client_id || undefined,
          // Blank = keep the stored value
          client_secret: orgOverride.client_secret || (app.client_secret ? REDACTED : undefined),
          private_key: orgOverride.private_key || (app.private_key ? REDACTED : undefined),
        },
        personas: nextPersonas,
        ...extra,
      };
      const res = await api.put(`/agents/${agentId}`, { config: { salesforce: body } });
      onSaved(res.data);
      setOrg((o) => ({ ...o, client_secret: '', private_key: '' }));
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submitPersona = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const p: Persona = {
      ...editing,
      name: editing.name.trim(),
      username: editing.username.trim(),
      expected_permission_sets: (editing.expected_permission_sets ?? []).map((s) => s.trim()).filter(Boolean),
    };
    const index = personas.findIndex((x) => x.name === (editing.previous_name ?? editing.name));
    const next = index >= 0 ? personas.map((x, i) => (i === index ? p : x)) : [...personas, p];
    if (await save(next)) {
      setNotice(`Persona “${p.name}” saved`);
      setEditing(null);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete persona ${name}? Tests that run as ${name} will fail.`)) return;
    const next = personas.filter((p) => p.name !== name);
    const orgNext = {
      ...org,
      default_persona: org.default_persona === name ? '' : org.default_persona,
      api_persona: org.api_persona === name ? '' : org.api_persona,
    };
    setOrg(orgNext);
    if (await save(next, orgNext)) setNotice(`Persona “${name}” deleted`);
  };

  const verify = async (name: string) => {
    setVerifying(name);
    setResults((r) => ({ ...r, [name]: undefined }));
    try {
      const res = await api.post(`/agents/${agentId}/salesforce/personas/${encodeURIComponent(name)}/verify`);
      setResults((r) => ({ ...r, [name]: res.data }));
    } catch (err) {
      setResults((r) => ({ ...r, [name]: { ok: false, error: errorMessage(err) } }));
    } finally {
      setVerifying(null);
    }
  };

  /** Configure the built-in Salesforce simulator with three personas (demo / training). */
  const useSimulator = async () => {
    try {
      const simUrl = `${BACKEND_URL}/demo/salesforce`;
      const { data: connected } = await axios.get(`${simUrl}/_sim/connected-app`);
      const orgNext = { ...org, login_url: simUrl, instance_url: simUrl, default_persona: 'rep', api_persona: 'admin', frontdoor_mode: 'auto', client_id: connected.client_id, client_secret: connected.client_secret, private_key: connected.private_key };
      const demo: Persona[] = [
        { name: 'admin', description: 'System Administrator (high privilege)', auth_method: 'jwt', username: 'admin@acme.sim', expected_profile: 'System Administrator' },
        { name: 'rep', description: 'Sales rep (Standard User + Sales_Ops)', auth_method: 'password_totp', username: 'rep@acme.sim', password: 'Rep-Pass-1!', totp_secret: 'JBSWY3DPEHPK3PXP', expected_profile: 'Standard User', expected_permission_sets: ['Sales_Ops'] },
        { name: 'viewer', description: 'Read-only user (low privilege)', auth_method: 'password', username: 'viewer@acme.sim', password: 'Viewer-Pass-1!', expected_profile: 'Read Only' },
      ];
      setOrg(orgNext);
      if (await save(demo, orgNext)) setNotice('Salesforce simulator configured with personas admin, rep and viewer');
    } catch (err) {
      setError(`Cannot reach the Salesforce simulator: ${errorMessage(err)}`);
    }
  };

  const method = (value: string) => AUTH_METHODS.find((m) => m.value === value);
  const set = (patch: Partial<Persona>) => setEditing((p) => (p ? { ...p, ...patch } : p));
  const secretField = (field: 'password' | 'totp_secret' | 'security_token', label: string, hint?: string) => {
    const stored = editing && personas.find((p) => p.name === (editing.previous_name ?? editing.name))?.[field] === REDACTED;
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={`persona-${field}`}>{label}</label>
        <input
          id={`persona-${field}`}
          className="form-control"
          type="password"
          autoComplete="new-password"
          placeholder={stored ? 'stored — leave blank to keep' : ''}
          value={editing?.[field] === REDACTED ? '' : editing?.[field] ?? ''}
          onChange={(e) => set({ [field]: e.target.value || (stored ? REDACTED : undefined) } as any)}
        />
        {hint && <div className="form-hint">{hint}</div>}
      </div>
    );
  };

  const needsApp = personas.some((p) => p.auth_method === 'jwt' || p.auth_method === 'oauth_password');

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>☁️ Salesforce personas</h3>
        <span className="text-sm text-muted">test as high- and low-privilege users · credentials encrypted</span>
      </div>
      <div className="card-body">
        {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
        {notice && <div className="alert alert-success" role="status">✓ {notice}</div>}

        {personas.length === 0 ? (
          <p className="text-muted text-sm">
            No personas yet. Add one per kind of user you need to test — e.g. an administrator, a sales rep and a read-only user — then
            mark test cases with the personas they must run as. Each run executes the test once per persona.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Persona</th><th>Login method</th><th>Username</th><th>Expected profile</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {personas.map((p) => {
                  const r = results[p.name];
                  return (
                    <Fragment key={p.name}>
                      <tr>
                        <td>
                          <div className="fw-600">{p.name}{sf.default_persona === p.name && <span className="badge badge-info" style={{ marginLeft: 6 }}>default</span>}{sf.api_persona === p.name && <span className="badge" style={{ marginLeft: 6 }}>API</span>}</div>
                          {p.description && <div className="text-sm text-muted">{p.description}</div>}
                        </td>
                        <td className="text-sm">{method(p.auth_method)?.label ?? p.auth_method}{p.auth_method === 'login_as' && p.login_as_via ? ` (via ${p.login_as_via})` : ''}</td>
                        <td className="text-sm code">{p.username}</td>
                        <td className="text-sm">{p.expected_profile || '—'}{p.expected_permission_sets?.length ? <div className="text-muted">+ {p.expected_permission_sets.join(', ')}</div> : null}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canVerify && <button type="button" className="btn btn-secondary btn-sm" onClick={() => verify(p.name)} disabled={verifying !== null} aria-label={`Verify persona ${p.name}`}>{verifying === p.name ? 'Verifying…' : 'Verify'}</button>}{' '}
                          {canAdmin && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing({ ...p, previous_name: p.name }); setNotice(null); }} aria-label={`Edit persona ${p.name}`}>Edit</button>}{' '}
                          {canAdmin && <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(p.name)} aria-label={`Delete persona ${p.name}`}>Delete</button>}
                        </td>
                      </tr>
                      {r && (
                        <tr>
                          <td colSpan={5}>
                            <div className={`alert ${r.ok ? 'alert-success' : 'alert-error'}`} data-testid={`verify-${p.name}`} style={{ margin: 0 }}>
                              {r.ok ? '✓ ' : '✗ '}
                              {r.error ?? r.message}
                              {r.identity && !r.identity.error && (
                                <div className="text-sm mt-1">
                                  Salesforce says: <strong>{r.identity.username}</strong> · profile <strong>{r.identity.profile ?? 'unknown'}</strong>
                                  {' '}· permission sets {r.identity.permissionSets?.length ? r.identity.permissionSets.join(', ') : 'none'}
                                  {r.identity.via === 'admin' ? ' (read through the API persona)' : ''}
                                </div>
                              )}
                              {r.identity?.error && <div className="text-sm mt-1">Identity check failed: {r.identity.error}</div>}
                              {r.mismatches?.length > 0 && <div className="text-sm mt-1">Mismatch: {r.mismatches.join('; ')}</div>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canAdmin && !editing && (
          <div className="flex gap-2 mt-4" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { setEditing({ ...EMPTY }); setNotice(null); }}>＋ Add persona</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={useSimulator} disabled={saving}>Use the Salesforce simulator</button>
          </div>
        )}

        {editing && (
          <form onSubmit={submitPersona} className="mt-4" aria-label="Persona" style={{ borderTop: '1px solid var(--gray-200)', paddingTop: 16 }}>
            <h4 className="mb-2">{editing.previous_name ? `Edit persona ${editing.previous_name}` : 'New persona'}</h4>
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label" htmlFor="persona-name">Persona name *</label>
                <input id="persona-name" className="form-control" required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}" value={editing.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. admin, sales_rep, read_only" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="persona-description">Description</label>
                <input id="persona-description" className="form-control" value={editing.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Sales rep — Standard User" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="persona-method">Login method *</label>
                <select id="persona-method" className="form-control" value={editing.auth_method} onChange={(e) => set({ auth_method: e.target.value })}>
                  {AUTH_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <div className="form-hint">{method(editing.auth_method)?.hint}</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="persona-username">Salesforce username *</label>
                <input id="persona-username" className="form-control" required value={editing.username} onChange={(e) => set({ username: e.target.value })} placeholder="user@acme.com.uat" autoComplete="off" />
              </div>
              {['password', 'password_totp', 'oauth_password'].includes(editing.auth_method) && secretField('password', 'Password')}
              {editing.auth_method === 'password_totp' && secretField('totp_secret', 'Authenticator (TOTP) secret', 'The Base32 key shown when registering an authenticator app for this user (“Can’t scan the QR code?”).')}
              {editing.auth_method === 'oauth_password' && secretField('security_token', 'Security token')}
              {editing.auth_method === 'login_as' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="persona-via">Administrator persona *</label>
                  <select id="persona-via" className="form-control" required value={editing.login_as_via ?? ''} onChange={(e) => set({ login_as_via: e.target.value })}>
                    <option value="">Select…</option>
                    {personas.filter((p) => p.auth_method !== 'login_as' && p.name !== editing.previous_name).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label" htmlFor="persona-profile">Expected profile</label>
                <input id="persona-profile" className="form-control" value={editing.expected_profile ?? ''} onChange={(e) => set({ expected_profile: e.target.value })} placeholder="e.g. Standard User" />
                <div className="form-hint">Checked after every login, so a test never runs as the wrong kind of user.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="persona-permsets">Expected permission sets</label>
                <input id="persona-permsets" className="form-control" value={(editing.expected_permission_sets ?? []).join(', ')} onChange={(e) => set({ expected_permission_sets: e.target.value.split(',') })} placeholder="API names, comma separated" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="persona-landing">Landing page</label>
                <input id="persona-landing" className="form-control" value={editing.landing_path ?? ''} onChange={(e) => set({ landing_path: e.target.value })} placeholder="/lightning/page/home" />
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save persona'}</button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        )}

        {canAdmin && (
          <details className="mt-4">
            <summary className="fw-600" style={{ cursor: 'pointer' }}>Org connection{needsApp && !app.client_id ? ' — connected app required' : ''}</summary>
            <form className="mt-2" onSubmit={async (e) => { e.preventDefault(); if (await save(personas)) setNotice('Org connection saved'); }}>
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-login-url">Login URL</label>
                  <input id="sf-login-url" className="form-control" value={org.login_url} onChange={(e) => setOrg({ ...org, login_url: e.target.value })} placeholder="https://acme--uat.sandbox.my.salesforce.com" />
                  <div className="form-hint">My Domain login URL, or login.salesforce.com / test.salesforce.com.</div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-instance-url">Instance (Lightning) URL</label>
                  <input id="sf-instance-url" className="form-control" value={org.instance_url} onChange={(e) => setOrg({ ...org, instance_url: e.target.value })} placeholder={baseUrl} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-default">Default persona</label>
                  <select id="sf-default" className="form-control" value={org.default_persona} onChange={(e) => setOrg({ ...org, default_persona: e.target.value })}>
                    <option value="">First persona</option>
                    {personas.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-api">API persona (admin checks)</label>
                  <select id="sf-api" className="form-control" value={org.api_persona} onChange={(e) => setOrg({ ...org, api_persona: e.target.value })}>
                    <option value="">First OAuth persona</option>
                    {personas.filter((p) => p.auth_method === 'jwt' || p.auth_method === 'oauth_password').map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <div className="form-hint">Reads profiles and permissions of personas that have no API session of their own (e.g. “Log in as”).</div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-client-id">Connected app consumer key</label>
                  <input id="sf-client-id" className="form-control" value={org.client_id} onChange={(e) => setOrg({ ...org, client_id: e.target.value })} autoComplete="off" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-client-secret">Consumer secret</label>
                  <input id="sf-client-secret" className="form-control" type="password" autoComplete="new-password" value={org.client_secret} onChange={(e) => setOrg({ ...org, client_secret: e.target.value })} placeholder={app.client_secret ? 'stored — leave blank to keep' : 'only for the OAuth password method'} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label" htmlFor="sf-private-key">Private key (PEM) for the JWT bearer flow</label>
                  <textarea id="sf-private-key" className="form-control" rows={3} value={org.private_key} onChange={(e) => setOrg({ ...org, private_key: e.target.value })} placeholder={app.private_key ? 'stored — leave blank to keep' : '-----BEGIN PRIVATE KEY-----'} spellCheck={false} />
                  <div className="form-hint">The certificate goes on the connected app; pre-authorize the persona users through its profile or permission set.</div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sf-frontdoor">Token → UI session</label>
                  <select id="sf-frontdoor" className="form-control" value={org.frontdoor_mode} onChange={(e) => setOrg({ ...org, frontdoor_mode: e.target.value })}>
                    <option value="auto">Single-use frontdoor URL, fall back to session id</option>
                    <option value="single_access">Single-use frontdoor URL only</option>
                    <option value="sid">frontdoor.jsp with session id</option>
                  </select>
                </div>
              </div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>Save org connection</button>
            </form>
          </details>
        )}
        {!canAdmin && <p className="form-hint mt-2">Only project admins can change personas and credentials.</p>}
      </div>
    </div>
  );
}
