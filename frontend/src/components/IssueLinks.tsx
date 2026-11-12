/**
 * The Jira stories / issues a test covers. Its results are shown on them after each run.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '../lib/api';

export default function IssueLinks({ testCaseId, canEdit }: { testCaseId: string; canEdit: boolean }) {
  const [links, setLinks] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [integrationId, setIntegrationId] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLinks((await api.get(`/testcases/${testCaseId}/links`)).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [testCaseId]);

  useEffect(() => {
    load();
    api.get('/integrations').then((r) => {
      const trackers = r.data.filter((i: any) => i.enabled);
      setIntegrations(trackers);
      if (trackers[0]) setIntegrationId(trackers[0].id);
    }).catch(() => undefined);
  }, [load]);

  if (!integrations.length && !links.length) {
    return (
      <p className="form-hint" data-testid="issue-links">
        Link this test to a Jira story to see its results there: <Link href="/settings/integrations">connect Jira</Link>.
      </p>
    );
  }

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/testcases/${testCaseId}/links`, { integrationId, key: key.trim() });
      setKey('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: any) => {
    setError(null);
    try {
      await api.delete(`/testcases/${testCaseId}/links/${l.integrationId}/${encodeURIComponent(l.key)}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="form-group" data-testid="issue-links">
      <div className="form-label">Covers (stories / issues)</div>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      <div className="flex gap-2 mb-2" style={{ flexWrap: 'wrap' }}>
        {links.length === 0 && <span className="text-sm text-muted">Not linked yet.</span>}
        {links.map((l) => (
          <span key={`${l.integrationId}-${l.key}`} className="badge badge-info" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.key}</a> : l.key}
            {l.title && <span className="text-muted">{l.title.slice(0, 50)}</span>}
            {canEdit && <button type="button" className="btn-ghost" style={{ padding: 0, border: 0, cursor: "pointer" }} aria-label={`Unlink ${l.key}`} onClick={() => remove(l)}>✕</button>}
          </span>
        ))}
      </div>
      {canEdit && integrations.length > 0 && (
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          {integrations.length > 1 && (
            <select className="form-control" style={{ width: 180 }} value={integrationId} onChange={(e) => setIntegrationId(e.target.value)} aria-label="Integration">
              {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          )}
          <input className="form-control" style={{ width: 160 }} value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="SHOP-123" aria-label="Issue key"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (key.trim()) add(); } }} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={add} disabled={busy || !key.trim()}>{busy ? 'Linking…' : '＋ Link'}</button>
        </div>
      )}
    </div>
  );
}
