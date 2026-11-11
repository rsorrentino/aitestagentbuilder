/**
 * Manage an agent's encrypted secrets. Values are write-only: the API
 * returns a placeholder, and steps reference them as {{secrets.NAME}}.
 */

import { useState } from 'react';
import { api, errorMessage, REDACTED } from '../lib/api';

interface Props {
  agentId: string;
  secrets: Record<string, string>;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

export default function AgentSecretsCard({ agentId, secrets, canEdit, onSaved }: Props) {
  const names = Object.keys(secrets ?? {});
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (next: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put(`/agents/${agentId}`, { config: { secrets: next } });
      onSaved(res.data);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Existing values are sent back as the placeholder, which keeps them unchanged.
  const keepAll = () => Object.fromEntries(names.map((n) => [n, REDACTED]));

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!key || !value) return;
    if (await save({ ...keepAll(), [key]: value })) {
      setName('');
      setValue('');
    }
  };

  const remove = (n: string) => {
    if (!confirm(`Delete secret ${n}? Steps using {{secrets.${n}}} will fail.`)) return;
    const next = keepAll();
    delete next[n];
    save(next);
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>🔐 Secrets</h3>
        <span className="text-sm text-muted">encrypted · use as <code>{'{{secrets.NAME}}'}</code> in step values</span>
      </div>
      <div className="card-body">
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        {names.length === 0 ? (
          <p className="text-muted text-sm">No secrets. Store passwords and tokens here instead of in test steps — they are encrypted at rest and masked in logs.</p>
        ) : (
          <div className="chip-group mb-4">
            {names.map((n) => (
              <span key={n} className="chip selected" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span className="code">{n}</span>
                {canEdit && <button type="button" aria-label={`Delete secret ${n}`} onClick={() => remove(n)} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>}
              </span>
            ))}
          </div>
        )}
        {canEdit ? (
          <form onSubmit={add} className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <input className="form-control" style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="NAME (e.g. ADMIN_PASSWORD)" aria-label="Secret name" />
            <input className="form-control" style={{ flex: '2 1 200px' }} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Secret value" />
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !name.trim() || !value}>{names.includes(name.trim().toUpperCase()) ? 'Replace' : 'Add'} secret</button>
          </form>
        ) : (
          <p className="form-hint">Only project admins can change secrets.</p>
        )}
      </div>
    </div>
  );
}
