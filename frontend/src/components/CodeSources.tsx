/**
 * Mailboxes (IMAP) and phone numbers (Twilio) that receive verification codes,
 * so emailed / SMS codes are answered without a person.
 */

import { useState } from 'react';
import { api, errorMessage, formatDate, REDACTED } from '../lib/api';

interface Source {
  name: string;
  previous_name?: string;
  type: 'email' | 'sms';
  host?: string; port?: number; secure?: boolean; username?: string; password?: string; mailbox?: string; from_contains?: string; subject_contains?: string;
  account_sid?: string; auth_token?: string; phone_number?: string;
  code_pattern?: string;
}

interface Props {
  agentId: string;
  sources: Source[];
  canAdmin: boolean;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

const EMPTY_EMAIL: Source = { name: '', type: 'email', host: '', port: 993, secure: true, username: '', password: '', mailbox: 'INBOX' };

export default function CodeSources({ agentId, sources, canAdmin, canEdit, onSaved }: Props) {
  const [editing, setEditing] = useState<Source | null>(null);
  const [checks, setChecks] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Source[]) => {
    setBusy('save');
    setError(null);
    try {
      const res = await api.put(`/agents/${agentId}`, { config: { code_sources: next } });
      onSaved(res.data);
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const before = sources.find((x) => x.name === (editing.previous_name ?? editing.name));
    const src: Source = {
      ...editing,
      name: editing.name.trim(),
      // Blank = keep the stored secret
      password: editing.password || (before?.password ? REDACTED : undefined),
      auth_token: editing.auth_token || (before?.auth_token ? REDACTED : undefined),
    };
    const i = sources.findIndex((x) => x.name === (editing.previous_name ?? editing.name));
    save(i >= 0 ? sources.map((x, j) => (j === i ? src : x)) : [...sources, src]);
  };

  const check = async (name: string) => {
    setBusy(`check-${name}`);
    try {
      const r = await api.post(`/agents/${agentId}/code-sources/${encodeURIComponent(name)}/check`);
      setChecks((c) => ({ ...c, [name]: r.data }));
    } catch (err) {
      setChecks((c) => ({ ...c, [name]: { ok: false, error: errorMessage(err) } }));
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<Source>) => setEditing((cur) => (cur ? { ...cur, ...patch } : cur));

  return (
    <div className="mt-4" aria-label="Code sources" role="region">
      <h4 className="mb-1">📨 Mailboxes &amp; phone numbers for codes</h4>
      <p className="text-sm text-muted mb-2">
        For applications that email or text a verification code (Salesforce’s “Verify your identity”, new-device checks, “confirm your email”).
        Use a mailbox or number dedicated to testing; only messages that arrive after the sign-in started are read, each once.
      </p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {sources.length > 0 && (
        <ul className="text-sm" style={{ margin: '0 0 8px 18px' }}>
          {sources.map((s) => {
            const c = checks[s.name];
            return (
              <li key={s.name} className="mb-1">
                <strong>{s.name}</strong> <span className="text-muted">{s.type === 'email' ? `IMAP ${s.username}@${s.host}` : `SMS ${s.phone_number} (Twilio)`}</span>{' '}
                {canEdit && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => check(s.name)}>{busy === `check-${s.name}` ? 'Checking…' : 'Check'}</button>}
                {canAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ ...s, previous_name: s.name, password: '', auth_token: '' })}>Edit</button>}
                {canAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.confirm(`Delete ${s.name}?`) && save(sources.filter((x) => x.name !== s.name))}>Delete</button>}
                {c && (
                  <div className={c.ok ? 'text-success' : 'text-danger'} data-testid={`source-check-${s.name}`}>
                    {c.ok ? `✓ Connected · ${c.recent} message(s) in the last 24 h${c.newest ? ` · newest ${formatDate(c.newest.at)}: “${c.newest.subject || c.newest.from}”` : ''}` : `✗ ${c.error}`}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canAdmin && !editing && (
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing({ ...EMPTY_EMAIL })}>＋ Mailbox</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing({ name: '', type: 'sms', account_sid: '', auth_token: '', phone_number: '' })}>＋ Phone number</button>
        </div>
      )}
      {editing && (
        <form onSubmit={submit} aria-label="Code source" style={{ background: 'var(--gray-50)', padding: 12, borderRadius: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <div>
              <label className="form-label" htmlFor="cs-name">Name</label>
              <input id="cs-name" className="form-control" value={editing.name} onChange={(e) => set({ name: e.target.value })} placeholder={editing.type === 'email' ? 'qa_inbox' : 'qa_phone'} required />
            </div>
            {editing.type === 'email' ? (
              <>
                <div><label className="form-label" htmlFor="cs-host">IMAP server</label><input id="cs-host" className="form-control" value={editing.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="imap.gmail.com / outlook.office365.com" required /></div>
                <div><label className="form-label" htmlFor="cs-port">Port</label><input id="cs-port" className="form-control" type="number" value={editing.port ?? 993} onChange={(e) => set({ port: Number(e.target.value) })} /></div>
                <div><label className="form-label" htmlFor="cs-user">User name</label><input id="cs-user" className="form-control" value={editing.username ?? ''} onChange={(e) => set({ username: e.target.value })} autoComplete="off" required /></div>
                <div><label className="form-label" htmlFor="cs-pw">Password / app password</label><input id="cs-pw" className="form-control" type="password" value={editing.password ?? ''} onChange={(e) => set({ password: e.target.value })} placeholder={editing.previous_name ? 'unchanged' : ''} autoComplete="new-password" /></div>
                <div><label className="form-label" htmlFor="cs-box">Folder</label><input id="cs-box" className="form-control" value={editing.mailbox ?? 'INBOX'} onChange={(e) => set({ mailbox: e.target.value })} /></div>
                <div><label className="form-label" htmlFor="cs-from">Only from (optional)</label><input id="cs-from" className="form-control" value={editing.from_contains ?? ''} onChange={(e) => set({ from_contains: e.target.value || undefined })} placeholder="salesforce.com" /></div>
                <label className="flex gap-2" style={{ alignItems: 'center' }}><input type="checkbox" checked={editing.secure !== false} onChange={(e) => set({ secure: e.target.checked })} /> TLS</label>
              </>
            ) : (
              <>
                <div><label className="form-label" htmlFor="cs-sid">Twilio account SID</label><input id="cs-sid" className="form-control code" value={editing.account_sid ?? ''} onChange={(e) => set({ account_sid: e.target.value.trim() })} placeholder="AC…" required /></div>
                <div><label className="form-label" htmlFor="cs-token">Auth token</label><input id="cs-token" className="form-control" type="password" value={editing.auth_token ?? ''} onChange={(e) => set({ auth_token: e.target.value })} placeholder={editing.previous_name ? 'unchanged' : ''} autoComplete="new-password" /></div>
                <div><label className="form-label" htmlFor="cs-phone">Phone number</label><input id="cs-phone" className="form-control" value={editing.phone_number ?? ''} onChange={(e) => set({ phone_number: e.target.value.trim() })} placeholder="+15550001111" required /></div>
              </>
            )}
            <div><label className="form-label" htmlFor="cs-pattern">Code pattern (optional)</label><input id="cs-pattern" className="form-control code" value={editing.code_pattern ?? ''} onChange={(e) => set({ code_pattern: e.target.value || undefined })} placeholder="Code: (\d{6})" /></div>
          </div>
          <p className="form-hint mt-2">
            {editing.type === 'email'
              ? 'Gmail and Outlook need IMAP enabled and an app password. The code is the number next to “code / verification / OTP”, or the pattern’s first group.'
              : 'The number must be a Twilio number that receives the test user’s texts.'}
          </p>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null}>Save</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
