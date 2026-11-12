/**
 * API testing for an agent: the API base URL and test generation from an
 * OpenAPI / Swagger description (smoke tests, or AI-written edge cases).
 */

import { useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '../lib/api';

interface Props {
  agentId: string;
  config: any;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

export default function ApiTestsCard({ agentId, config, canEdit, onSaved }: Props) {
  const [baseUrl, setBaseUrl] = useState<string>(config.api_base_url ?? '');
  const [specUrl, setSpecUrl] = useState('');
  const [specText, setSpecText] = useState('');
  const [useAi, setUseAi] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [result, setResult] = useState<any>(null);

  const saveBaseUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setMessage(null);
    try {
      const res = await api.put(`/agents/${agentId}`, { config: { api_base_url: baseUrl.trim() || undefined } });
      onSaved(res.data);
      setMessage({ ok: true, text: 'API base URL saved' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('generate');
    setMessage(null);
    setResult(null);
    try {
      const res = await api.post(`/agents/${agentId}/generate-api-tests`, {
        ...(specText.trim() ? { spec: specText } : { specUrl: specUrl.trim() }),
        ai: useAi,
      });
      setResult(res.data);
      setMessage({ ok: true, text: `Created ${res.data.created} test case(s) from ${res.data.operations} operation(s)` });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>🔌 API tests</h3>
        <span className="text-sm text-muted">http_request · assert_status · assert_json · mock_route</span>
      </div>
      <div className="card-body">
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</div>}

        <form onSubmit={saveBaseUrl} className="form-group">
          <label className="form-label" htmlFor="api-base">API base URL</label>
          <div className="flex gap-2">
            <input id="api-base" className="form-control" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={`${config.base_url} (default)`} disabled={!canEdit} />
            {canEdit && <button className="btn btn-secondary btn-sm" type="submit" disabled={busy !== null}>Save</button>}
          </div>
          <div className="form-hint">
            Paths in <code>http_request</code> steps are relative to it. Requests share the test&apos;s browser cookies, so an API call after a
            UI login is authenticated as that user.
          </div>
        </form>

        {canEdit && (
          <form onSubmit={generate} aria-label="Generate API tests">
            <h4 className="mb-2">Generate tests from OpenAPI / Swagger</h4>
            <div className="form-group">
              <label className="form-label" htmlFor="spec-url">Description URL</label>
              <input id="spec-url" className="form-control" value={specUrl} onChange={(e) => setSpecUrl(e.target.value)}
                placeholder="/openapi.json or https://api.example.com/v3/api-docs" disabled={!!specText.trim()} />
            </div>
            <details className="mb-2">
              <summary className="text-sm" style={{ cursor: 'pointer' }}>…or paste it (JSON or YAML)</summary>
              <textarea className="form-control mt-2" rows={6} value={specText} onChange={(e) => setSpecText(e.target.value)}
                aria-label="OpenAPI description" spellCheck={false} placeholder="openapi: 3.0.3&#10;paths: …" />
            </details>
            <label className="flex gap-2 mb-2" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
              <span className="text-sm">Let the AI also write negative and edge cases (validation errors, not found, unauthorised)</span>
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null || (!specUrl.trim() && !specText.trim())}>
              {busy === 'generate' ? 'Generating…' : 'Generate API tests'}
            </button>
            <p className="form-hint mt-2">
              Without AI: one smoke test per operation (request with the examples of the description → expected status → required fields).
              Operations whose parameters have no example are listed as skipped.
            </p>
          </form>
        )}

        {result && (
          <div className="mt-3 text-sm" data-testid="api-generation-result">
            {result.tests.length > 0 && (
              <ul style={{ margin: '0 0 8px 18px' }}>
                {result.tests.map((t: any) => <li key={t.id ?? t.title}>{t.title}</li>)}
              </ul>
            )}
            {result.skipped?.length > 0 && (
              <div className="text-muted">Skipped: {result.skipped.map((s: any) => `${s.operation} (${s.reason})`).join('; ')}</div>
            )}
            {result.hint && <div className="text-muted mt-1">{result.hint}</div>}
            {result.saved && <Link href="/testcases" className="btn btn-ghost btn-sm mt-2">Open test cases →</Link>}
          </div>
        )}
      </div>
    </div>
  );
}
