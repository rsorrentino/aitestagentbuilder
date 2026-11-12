/**
 * GitHub integration: connection form (repository, token, triggers, statuses, pull
 * request comments, bugs as issues) and its setup panel (webhook to add on GitHub,
 * GitHub Actions workflow).
 */

import { useEffect, useState } from 'react';
import { API_URL, api, errorMessage } from '../lib/api';

const EVENTS = [
  { value: 'pull_request', label: 'Pull request opened / updated', filter: 'Target branches' },
  { value: 'push', label: 'Push', filter: 'Branches' },
  { value: 'deployment_status', label: 'Deployment succeeded', filter: 'Environments' },
];
const CATEGORIES = [
  { value: 'app_bug', label: 'Application bugs' },
  { value: 'environment', label: 'Environment problems' },
  { value: 'test_bug', label: 'Broken tests' },
  { value: 'unknown', label: 'Unclassified' },
];

interface TriggerRow { event: string; agent_id: string; filter: string; use_deployment_url: boolean }

const randomSecret = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function GitHubForm({ editing, agents, onSaved, onCancel, onError }: {
  editing?: any; agents: any[]; onSaved: (message: string) => void; onCancel: () => void; onError: (message: string | null) => void;
}) {
  const c = editing?.config ?? {};
  const [name, setName] = useState(editing?.name ?? 'GitHub');
  const [repository, setRepository] = useState(c.repository ?? '');
  const [token, setToken] = useState('');
  const [apiUrl, setApiUrl] = useState(c.api_url ?? '');
  const [secret, setSecret] = useState(editing ? '' : randomSecret());
  const [commitStatus, setCommitStatus] = useState(c.commit_status !== false);
  const [prComment, setPrComment] = useState(c.pr_comment !== false);
  const [defects, setDefects] = useState(c.defects?.enabled === true);
  const [onlyUnattended, setOnlyUnattended] = useState(c.defects?.only_unattended !== false);
  const [categories, setCategories] = useState<string[]>(c.defects?.categories?.length ? c.defects.categories : ['app_bug']);
  const [triggers, setTriggers] = useState<TriggerRow[]>((c.triggers ?? []).map((t: any) => ({
    event: t.event, agent_id: t.agent_id, filter: (t.event === 'deployment_status' ? t.environments : t.branches)?.join(', ') ?? '', use_deployment_url: !!t.use_deployment_url,
  })));
  const [saving, setSaving] = useState(false);

  const setTrigger = (i: number, patch: Partial<TriggerRow>) => setTriggers((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    onError(null);
    const config = {
      repository: repository.trim(),
      ...(token ? { token } : {}),
      api_url: apiUrl.trim(),
      ...(secret ? { webhook_secret: secret } : {}),
      commit_status: commitStatus,
      pr_comment: prComment,
      triggers: triggers.filter((t) => t.agent_id).map((t) => ({
        event: t.event, agent_id: t.agent_id,
        ...(t.event === 'deployment_status' ? { environments: list(t.filter), use_deployment_url: t.use_deployment_url } : { branches: list(t.filter) }),
      })),
      defects: { enabled: defects, only_unattended: onlyUnattended, categories },
    };
    try {
      if (editing) await api.put(`/integrations/${editing.id}`, { name, config });
      else {
        const created = (await api.post('/integrations', { type: 'github', name, config })).data;
        const check = (await api.post(`/integrations/${created.id}/check`)).data;
        if (!check.ok) throw new Error(`Saved, but the connection check failed: ${check.error}`);
      }
      onSaved(editing ? 'Saved.' : 'GitHub connected. Open “Setup” to add the webhook on GitHub.');
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} data-testid="github-form">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <div className="form-group">
          <label className="form-label" htmlFor="g-name">Name *</label>
          <input id="g-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="g-repo">Repository *</label>
          <input id="g-repo" className="form-control" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="acme/shop" required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="g-token">Token {editing ? '(leave empty to keep)' : '*'}</label>
          <input id="g-token" className="form-control" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" required={!editing} />
          <p className="form-hint">
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Fine-grained token</a> for this repository:
            Commit statuses, Issues and Pull requests read &amp; write. Stored encrypted.
          </p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="g-api">API URL</label>
          <input id="g-api" className="form-control" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.github.com" />
          <p className="form-hint">Only for GitHub Enterprise Server: https://github.example.com/api/v3</p>
        </div>
      </div>

      <div className="form-group">
        <div className="form-label">Run tests when</div>
        {triggers.length === 0 && <p className="form-hint">No triggers: runs started by schedules or CI still report to their commit.</p>}
        {triggers.map((t, i) => {
          const meta = EVENTS.find((e) => e.value === t.event)!;
          return (
            <div key={i} className="flex gap-2 mb-2" style={{ flexWrap: 'wrap', alignItems: 'center' }} data-testid="trigger-row">
              <select className="form-control" style={{ width: 240 }} value={t.event} onChange={(e) => setTrigger(i, { event: e.target.value })} aria-label="Event">
                {EVENTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
              </select>
              <select className="form-control" style={{ width: 200 }} value={t.agent_id} onChange={(e) => setTrigger(i, { agent_id: e.target.value })} aria-label="Agent to run" required>
                <option value="">Agent to run…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input className="form-control" style={{ width: 220 }} value={t.filter} onChange={(e) => setTrigger(i, { filter: e.target.value })}
                placeholder={`${meta.filter} (all)${t.event === 'deployment_status' ? ', e.g. preview*' : ', e.g. main, release/*'}`} aria-label={meta.filter} />
              {t.event === 'deployment_status' && (
                <label className="flex gap-2 text-sm" style={{ alignItems: 'center' }}>
                  <input type="checkbox" checked={t.use_deployment_url} onChange={(e) => setTrigger(i, { use_deployment_url: e.target.checked })} />
                  Test the deployed address
                </label>
              )}
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove trigger" onClick={() => setTriggers((rows) => rows.filter((_r, n) => n !== i))}>✕</button>
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTriggers((rows) => [...rows, { event: 'pull_request', agent_id: agents[0]?.id ?? '', filter: '', use_deployment_url: true }])}>＋ Add trigger</button>
      </div>

      <div className="form-group">
        <div className="form-label">Report</div>
        <label className="flex gap-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={commitStatus} onChange={(e) => setCommitStatus(e.target.checked)} />
          Status check on the commit (“AI tests / agent”, can be made required in branch protection)
        </label>
        <label className="flex gap-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={prComment} onChange={(e) => setPrComment(e.target.checked)} />
          Comment on the pull request with the results (one comment per agent, updated)
        </label>
        <label className="flex gap-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={defects} onChange={(e) => setDefects(e.target.checked)} />
          File issues for new failures, close them when the tests pass
        </label>
      </div>
      {defects && (
        <div className="form-group">
          <div className="chip-group mb-2">
            {CATEGORIES.map((o) => (
              <div key={o.value} role="checkbox" aria-checked={categories.includes(o.value)} tabIndex={0} className={`chip${categories.includes(o.value) ? ' selected' : ''}`}
                onClick={() => setCategories((v) => (v.includes(o.value) ? v.filter((x) => x !== o.value) : [...v, o.value]))}>{o.label}</div>
            ))}
          </div>
          <label className="flex gap-2" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={onlyUnattended} onChange={(e) => setOnlyUnattended(e.target.checked)} />
            Only for webhook, scheduled and CI runs
          </label>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="g-secret">Webhook secret {editing && '(leave empty to keep)'}</label>
        <div className="flex gap-2">
          <input id="g-secret" className="form-control" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" style={{ fontFamily: 'monospace' }} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSecret(randomSecret())}>New</button>
        </div>
        <p className="form-hint">Copy it now: GitHub needs the same secret (Setup shows where). It is stored encrypted and not shown again.</p>
      </div>

      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Checking…' : editing ? 'Save' : 'Connect'}</button>
        {editing && <button className="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** What to set up on GitHub: the webhook, and optionally an Actions workflow. */
export function GitHubSetup({ integration, agents }: { integration: any; agents: any[] }) {
  const hookUrl = `${API_URL.replace(/\/+$/, '')}/hooks/github/${integration.id}`;
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [workflow, setWorkflow] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!agentId) return;
    setError(null);
    api.get(`/integrations/${integration.id}/workflow`, { params: { agentId, apiUrl: API_URL } })
      .then((r) => setWorkflow(r.data)).catch((e) => setError(errorMessage(e)));
  }, [agentId, integration.id]);

  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => setCopied(what)).catch(() => undefined);
  };

  return (
    <div className="card-body" style={{ background: 'var(--gray-50)' }} data-testid="github-setup">
      <h4 className="mb-2">1 · Webhook (runs on pull requests, pushes, deployments)</h4>
      <p className="text-sm mb-2">
        On GitHub: <a href={`https://github.com/${integration.config.repository}/settings/hooks/new`} target="_blank" rel="noreferrer">{integration.config.repository} → Settings → Webhooks → Add webhook</a>
      </p>
      <table className="data-table text-sm mb-4" style={{ maxWidth: 760 }}>
        <tbody>
          <tr><td className="fw-600">Payload URL</td><td><code data-testid="hook-url">{hookUrl}</code> <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy('url', hookUrl)}>{copied === 'url' ? '✓ copied' : 'Copy'}</button></td></tr>
          <tr><td className="fw-600">Content type</td><td><code>application/json</code></td></tr>
          <tr><td className="fw-600">Secret</td><td>the webhook secret of this integration</td></tr>
          <tr><td className="fw-600">Events</td><td>Pull requests, Pushes, Deployment statuses</td></tr>
        </tbody>
      </table>
      <p className="form-hint mb-4">GitHub must reach this server. Behind a firewall, use the Actions workflow below instead (it calls the API from GitHub&apos;s runners).</p>

      <h4 className="mb-2">2 · Or: GitHub Actions workflow</h4>
      <div className="flex gap-2 mb-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="text-sm" htmlFor="wf-agent">Agent</label>
        <select id="wf-agent" className="form-control" style={{ width: 220 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {workflow && <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy('yaml', workflow.yaml)}>{copied === 'yaml' ? '✓ copied' : 'Copy workflow'}</button>}
      </div>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {workflow && (
        <>
          <p className="text-sm">Save as <code>{workflow.path}</code> and add the repository secret <code>{workflow.secret}</code> (an API key from Account → API keys, editor role).</p>
          <pre className="code" style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }} data-testid="workflow-yaml">{workflow.yaml}</pre>
        </>
      )}
    </div>
  );
}
