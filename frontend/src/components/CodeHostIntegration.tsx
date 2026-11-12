/**
 * Code host integrations (GitHub, GitLab, Azure DevOps): connection form (where the code is,
 * token, triggers, statuses, pull / merge request comments, bugs) and the setup panel
 * (webhook to add on the host, CI template).
 */

import { useEffect, useState } from 'react';
import { API_URL, api, errorMessage } from '../lib/api';

export type CodeHostType = 'github' | 'gitlab' | 'azure_devops';

interface Field { key: string; label: string; placeholder?: string; hint?: React.ReactNode; required?: boolean; secret?: boolean }

const HOSTS: Record<CodeHostType, {
  label: string; pr: string; hookPath: string; tokenKey: string; issues: string;
  fields: Field[]; events: Array<{ value: string; label: string; filter: string }>;
}> = {
  github: {
    label: 'GitHub', pr: 'pull request', hookPath: 'github', tokenKey: 'token', issues: 'issues',
    fields: [
      { key: 'repository', label: 'Repository', placeholder: 'acme/shop', required: true },
      { key: 'token', label: 'Token', secret: true, required: true, hint: <><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Fine-grained token</a> for this repository: Commit statuses, Issues and Pull requests read &amp; write.</> },
      { key: 'api_url', label: 'API URL', placeholder: 'https://api.github.com', hint: 'Only for GitHub Enterprise Server: https://github.example.com/api/v3' },
    ],
    events: [
      { value: 'pull_request', label: 'Pull request opened / updated', filter: 'Target branches' },
      { value: 'push', label: 'Push', filter: 'Branches' },
      { value: 'deployment_status', label: 'Deployment succeeded', filter: 'Environments' },
    ],
  },
  gitlab: {
    label: 'GitLab', pr: 'merge request', hookPath: 'gitlab', tokenKey: 'token', issues: 'issues',
    fields: [
      { key: 'project', label: 'Project', placeholder: 'group/shop or 1234', required: true },
      { key: 'token', label: 'Token', secret: true, required: true, hint: 'A project access token (or personal access token) with the api scope and the Developer role.' },
      { key: 'base_url', label: 'GitLab URL', placeholder: 'https://gitlab.com', hint: 'Only for self-managed GitLab.' },
    ],
    events: [
      { value: 'pull_request', label: 'Merge request opened / new commits', filter: 'Target branches' },
      { value: 'push', label: 'Push', filter: 'Branches' },
      { value: 'deployment_status', label: 'Deployment succeeded (review apps)', filter: 'Environments' },
    ],
  },
  azure_devops: {
    label: 'Azure DevOps', pr: 'pull request', hookPath: 'azure', tokenKey: 'pat', issues: 'work items',
    fields: [
      { key: 'organization_url', label: 'Organization URL', placeholder: 'https://dev.azure.com/acme', required: true },
      { key: 'project', label: 'Project', placeholder: 'Shop', required: true },
      { key: 'repository', label: 'Repository', placeholder: 'shop-web', hint: 'Azure Repos repository: needed for triggers, commit statuses and pull request comments.' },
      { key: 'pat', label: 'Personal access token', secret: true, required: true, hint: 'Scopes: Work Items (read & write), Code (status), Code (read & write) for pull request comments.' },
      { key: 'work_item_type', label: 'Bug work item type', placeholder: 'Bug' },
    ],
    events: [
      { value: 'pull_request', label: 'Pull request created / source branch updated', filter: 'Target branches' },
      { value: 'push', label: 'Code pushed', filter: 'Branches' },
    ],
  },
};

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

export const codeHostLabel = (type: string) => HOSTS[type as CodeHostType]?.label ?? type;

export function CodeHostForm({ type, editing, agents, onSaved, onCancel, onError }: {
  type: CodeHostType; editing?: any; agents: any[]; onSaved: (message: string) => void; onCancel: () => void; onError: (message: string | null) => void;
}) {
  const host = HOSTS[type];
  const c = editing?.config ?? {};
  const [name, setName] = useState(editing?.name ?? host.label);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(host.fields.map((f) => [f.key, f.secret ? '' : String(c[f.key] ?? '')])));
  const [secret, setSecret] = useState(editing ? '' : randomSecret());
  const [commitStatus, setCommitStatus] = useState(c.commit_status !== false);
  const [prComment, setPrComment] = useState(c.pr_comment !== false);
  const [defects, setDefects] = useState(c.defects?.enabled === true);
  const [onlyUnattended, setOnlyUnattended] = useState(c.defects?.only_unattended !== false);
  const [resolveState, setResolveState] = useState(c.defects?.resolve_transition ?? '');
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
    const fields = Object.fromEntries(host.fields
      .filter((f) => !(f.secret && !values[f.key]))
      .map((f) => [f.key, values[f.key].trim()]));
    const config = {
      ...fields,
      ...(secret ? { webhook_secret: secret } : {}),
      commit_status: commitStatus,
      pr_comment: prComment,
      triggers: triggers.filter((t) => t.agent_id).map((t) => ({
        event: t.event, agent_id: t.agent_id,
        ...(t.event === 'deployment_status' ? { environments: list(t.filter), use_deployment_url: t.use_deployment_url } : { branches: list(t.filter) }),
      })),
      defects: { enabled: defects, only_unattended: onlyUnattended, categories, ...(type === 'azure_devops' ? { resolve_transition: resolveState.trim() } : {}) },
    };
    try {
      if (editing) await api.put(`/integrations/${editing.id}`, { name, config });
      else {
        const created = (await api.post('/integrations', { type, name, config })).data;
        const check = (await api.post(`/integrations/${created.id}/check`)).data;
        if (!check.ok) throw new Error(`Saved, but the connection check failed: ${check.error}`);
      }
      onSaved(editing ? 'Saved.' : `${host.label} connected. Open “Setup” to add the webhook on ${host.label}.`);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} data-testid={`${type}-form`}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <div className="form-group">
          <label className="form-label" htmlFor={`${type}-name`}>Name *</label>
          <input id={`${type}-name`} className="form-control" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        {host.fields.map((f) => (
          <div className="form-group" key={f.key}>
            <label className="form-label" htmlFor={`${type}-${f.key}`}>{f.label}{f.secret && editing ? ' (leave empty to keep)' : f.required ? ' *' : ''}</label>
            <input id={`${type}-${f.key}`} className="form-control" type={f.secret ? 'password' : 'text'} value={values[f.key]} placeholder={f.placeholder}
              autoComplete={f.secret ? 'new-password' : 'off'} required={!!f.required && !(f.secret && editing)}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
            {f.hint && <p className="form-hint">{f.hint}{f.secret && ' Stored encrypted.'}</p>}
          </div>
        ))}
      </div>

      <div className="form-group">
        <div className="form-label">Run tests when</div>
        {triggers.length === 0 && <p className="form-hint">No triggers: runs started by schedules or CI still report to their commit.</p>}
        {triggers.map((t, i) => {
          const meta = host.events.find((e) => e.value === t.event) ?? host.events[0];
          return (
            <div key={i} className="flex gap-2 mb-2" style={{ flexWrap: 'wrap', alignItems: 'center' }} data-testid="trigger-row">
              <select className="form-control" style={{ width: 280 }} value={t.event} onChange={(e) => setTrigger(i, { event: e.target.value })} aria-label="Event">
                {host.events.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
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
          Status on the commit (“AI tests / agent”{type === 'github' ? ', can be made required in branch protection' : type === 'azure_devops' ? ', can be required by a status policy' : ', shown in the merge request'})
        </label>
        <label className="flex gap-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={prComment} onChange={(e) => setPrComment(e.target.checked)} />
          Comment on the {host.pr} with the results (one per agent, updated)
        </label>
        <label className="flex gap-2" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={defects} onChange={(e) => setDefects(e.target.checked)} />
          File {host.issues} for new failures, resolve them when the tests pass
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
          {type === 'azure_devops' && (
            <div className="mt-2" style={{ maxWidth: 320 }}>
              <label className="form-label" htmlFor="az-resolve">Resolve to state</label>
              <input id="az-resolve" className="form-control" value={resolveState} onChange={(e) => setResolveState(e.target.value)} placeholder="Resolved, Closed or Done (first that works)" />
            </div>
          )}
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor={`${type}-secret`}>Webhook secret {editing && '(leave empty to keep)'}</label>
        <div className="flex gap-2">
          <input id={`${type}-secret`} className="form-control" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" style={{ fontFamily: 'monospace' }} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSecret(randomSecret())}>New</button>
        </div>
        <p className="form-hint">Copy it now: {host.label} needs the same secret (Setup shows where). It is stored encrypted and not shown again.</p>
      </div>

      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Checking…' : editing ? 'Save' : 'Connect'}</button>
        {editing && <button className="btn btn-secondary btn-sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function HookInstructions({ integration, hookUrl, copy, copied }: { integration: any; hookUrl: string; copy: (what: string, text: string) => void; copied: string }) {
  const c = integration.config;
  const url = <><code data-testid="hook-url">{hookUrl}</code> <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy('url', hookUrl)}>{copied === 'url' ? '✓ copied' : 'Copy'}</button></>;
  if (integration.type === 'gitlab') {
    const web = String(c.base_url || 'https://gitlab.com').replace(/\/+$/, '');
    return (
      <>
        <p className="text-sm mb-2">On GitLab: <a href={`${web}/${c.project}/-/hooks`} target="_blank" rel="noreferrer">{c.project} → Settings → Webhooks → Add new webhook</a></p>
        <table className="data-table text-sm mb-4" style={{ maxWidth: 760 }}>
          <tbody>
            <tr><td className="fw-600">URL</td><td>{url}</td></tr>
            <tr><td className="fw-600">Secret token</td><td>the webhook secret of this integration</td></tr>
            <tr><td className="fw-600">Trigger</td><td>Push events, Merge request events, Deployment events</td></tr>
          </tbody>
        </table>
      </>
    );
  }
  if (integration.type === 'azure_devops') {
    return (
      <>
        <p className="text-sm mb-2">In Azure DevOps: <a href={`${String(c.organization_url).replace(/\/+$/, '')}/${encodeURIComponent(c.project)}/_settings/serviceHooks`} target="_blank" rel="noreferrer">{c.project} → Project settings → Service hooks</a> → ＋ → Web Hooks, one subscription per event:</p>
        <table className="data-table text-sm mb-4" style={{ maxWidth: 760 }}>
          <tbody>
            <tr><td className="fw-600">Events</td><td>Code pushed; Pull request created; Pull request updated (change: Source branch updated) — repository {c.repository || '(set one)'}</td></tr>
            <tr><td className="fw-600">URL</td><td>{url}</td></tr>
            <tr><td className="fw-600">HTTP headers</td><td><code>X-ATAB-Token:&lt;webhook secret&gt;</code> (or basic authentication with the secret as password)</td></tr>
            <tr><td className="fw-600">Messages to send</td><td>All</td></tr>
          </tbody>
        </table>
      </>
    );
  }
  return (
    <>
      <p className="text-sm mb-2">On GitHub: <a href={`https://github.com/${c.repository}/settings/hooks/new`} target="_blank" rel="noreferrer">{c.repository} → Settings → Webhooks → Add webhook</a></p>
      <table className="data-table text-sm mb-4" style={{ maxWidth: 760 }}>
        <tbody>
          <tr><td className="fw-600">Payload URL</td><td>{url}</td></tr>
          <tr><td className="fw-600">Content type</td><td><code>application/json</code></td></tr>
          <tr><td className="fw-600">Secret</td><td>the webhook secret of this integration</td></tr>
          <tr><td className="fw-600">Events</td><td>Pull requests, Pushes, Deployment statuses</td></tr>
        </tbody>
      </table>
    </>
  );
}

const CI_NAME: Record<string, string> = { github: 'GitHub Actions workflow', gitlab: 'GitLab CI job', azure_devops: 'Azure Pipelines pipeline' };

/** What to set up on the code host: the webhook, and optionally a CI template. */
export function CodeHostSetup({ integration, agents }: { integration: any; agents: any[] }) {
  const host = HOSTS[integration.type as CodeHostType];
  const hookUrl = `${API_URL.replace(/\/+$/, '')}/hooks/${host.hookPath}/${integration.id}`;
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
    <div className="card-body" style={{ background: 'var(--gray-50)' }} data-testid="codehost-setup">
      <h4 className="mb-2">1 · Webhook (runs on {host.pr}s, pushes{integration.type !== 'azure_devops' ? ', deployments' : ''})</h4>
      <HookInstructions integration={integration} hookUrl={hookUrl} copy={copy} copied={copied} />
      <p className="form-hint mb-4">{host.label} must reach this server. Behind a firewall, use the {CI_NAME[integration.type]} below instead (it calls the API from the CI runners).</p>

      <h4 className="mb-2">2 · Or: {CI_NAME[integration.type]}</h4>
      <div className="flex gap-2 mb-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="text-sm" htmlFor={`wf-agent-${integration.id}`}>Agent</label>
        <select id={`wf-agent-${integration.id}`} className="form-control" style={{ width: 220 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {workflow && <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy('yaml', workflow.yaml)}>{copied === 'yaml' ? '✓ copied' : 'Copy'}</button>}
      </div>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {workflow && (
        <>
          <p className="text-sm">Save as / add to <code>{workflow.path}</code> and set the secret <code>{workflow.secret}</code> in {workflow.secretWhere}: an API key from Account → API keys, editor role.</p>
          <pre className="code" style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }} data-testid="workflow-yaml">{workflow.yaml}</pre>
        </>
      )}
    </div>
  );
}
