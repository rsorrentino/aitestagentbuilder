/**
 * Databases an agent's tests can query (db_query, assert_db) and, when allowed, change (db_execute).
 */

import { useState } from 'react';
import { api, errorMessage, REDACTED } from '../lib/api';

const TYPES = [
  { value: 'postgres', label: 'PostgreSQL', port: 5432 },
  { value: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { value: 'sqlserver', label: 'SQL Server / Azure SQL', port: 1433 },
  { value: 'oracle', label: 'Oracle', port: 1521 },
];

interface Row { name: string; previous_name?: string; type: string; host: string; port: string; database: string; user: string; password: string; url: string; ssl: boolean; read_only: boolean; stored: boolean }

const toRow = (d: any): Row => ({
  name: d.name, previous_name: d.name, type: d.type, host: d.host ?? '', port: d.port ? String(d.port) : '', database: d.database ?? '', user: d.user ?? '',
  password: '', url: '', ssl: !!d.ssl, read_only: d.read_only !== false, stored: d.password === REDACTED || d.url === REDACTED,
});

export default function DatabasesCard({ agentId, config, canEdit, onSaved }: { agentId: string; config: any; canEdit: boolean; onSaved: (agent: any) => void }) {
  const [rows, setRows] = useState<Row[]>((config.databases ?? []).map(toRow));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const databases = rows.map((r) => ({
      name: r.name.trim(), ...(r.previous_name && r.previous_name !== r.name.trim() ? { previous_name: r.previous_name } : {}), type: r.type,
      ...(r.url ? { url: r.url } : {}), ...(r.host ? { host: r.host.trim() } : {}), ...(r.port ? { port: Number(r.port) } : {}),
      ...(r.database ? { database: r.database.trim() } : {}), ...(r.user ? { user: r.user.trim() } : {}),
      // Empty password: the stored one is kept
      ...(r.password ? { password: r.password } : r.stored ? { password: REDACTED } : {}),
      ...(r.stored && !r.url && !r.host ? { url: REDACTED } : {}),
      ...(r.ssl ? { ssl: true } : {}), read_only: r.read_only,
    }));
    try {
      const res = await api.put(`/agents/${agentId}`, { config: { databases } });
      onSaved(res.data);
      setRows((res.data.config.databases ?? []).map(toRow));
      setMessage({ ok: true, text: `Saved ${databases.length} database(s).` });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card mb-6" onSubmit={save} aria-label="Databases">
      <div className="card-header"><h3>🗄️ Databases</h3><span className="text-sm text-muted">db_query · assert_db · db_execute</span></div>
      <div className="card-body">
        {rows.length === 0 && <p className="text-sm text-muted">Add a database to check what the application wrote, or to prepare and clean up test data.</p>}
        {rows.map((r, i) => (
          <div key={i} className="mb-4" style={{ borderBottom: '1px solid var(--gray-200)', paddingBottom: 12 }} data-testid="db-row">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              <input className="form-control" aria-label="Database name" value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="name (target of steps)" disabled={!canEdit} required />
              <select className="form-control" aria-label="Type" value={r.type} onChange={(e) => set(i, { type: e.target.value })} disabled={!canEdit}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <input className="form-control" aria-label="Host" value={r.host} onChange={(e) => set(i, { host: e.target.value })} placeholder="host" disabled={!canEdit} />
              <input className="form-control" aria-label="Port" value={r.port} onChange={(e) => set(i, { port: e.target.value })} placeholder={String(TYPES.find((t) => t.value === r.type)?.port)} disabled={!canEdit} />
              <input className="form-control" aria-label="Database" value={r.database} onChange={(e) => set(i, { database: e.target.value })} placeholder={r.type === 'oracle' ? 'service name' : 'database'} disabled={!canEdit} />
              <input className="form-control" aria-label="User" value={r.user} onChange={(e) => set(i, { user: e.target.value })} placeholder="user" autoComplete="off" disabled={!canEdit} />
              <input className="form-control" type="password" aria-label="Password" value={r.password} onChange={(e) => set(i, { password: e.target.value })} placeholder={r.stored ? 'stored (leave empty to keep)' : 'password'} autoComplete="new-password" disabled={!canEdit} />
              <input className="form-control" type="password" aria-label="Connection URL" value={r.url} onChange={(e) => set(i, { url: e.target.value })}
                placeholder={r.stored && !r.host ? 'URL stored (leave empty to keep)' : 'or a connection URL instead'} autoComplete="new-password" disabled={!canEdit} style={{ gridColumn: 'span 2' }} />
            </div>
            <div className="flex gap-3 mt-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="flex gap-2 text-sm" style={{ alignItems: 'center' }}><input type="checkbox" checked={r.read_only} onChange={(e) => set(i, { read_only: e.target.checked })} disabled={!canEdit} /> Read-only (queries only)</label>
              <label className="flex gap-2 text-sm" style={{ alignItems: 'center' }}><input type="checkbox" checked={r.ssl} onChange={(e) => set(i, { ssl: e.target.checked })} disabled={!canEdit} /> TLS</label>
              {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((rs) => rs.filter((_x, n) => n !== i))}>Remove</button>}
            </div>
          </div>
        ))}
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`}>{message.text}</div>}
        {canEdit && (
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { name: rs.length ? `db${rs.length + 1}` : 'app', type: 'postgres', host: '', port: '', database: '', user: '', password: '', url: '', ssl: false, read_only: true, stored: false }])}>＋ Database</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}
        <p className="form-hint mt-2">
          Steps: <code>db_query</code> / <code>assert_db</code> / <code>db_execute</code>, target = database name, value <code>{'{"sql": "SELECT status FROM orders WHERE id = ?", "params": ["{{vars.orderId}}"], "equals": {"status": "paid"}}'}</code>.
          Use a database account with only the rights the tests need. Passwords are stored encrypted and never shown.
        </p>
      </div>
    </form>
  );
}
