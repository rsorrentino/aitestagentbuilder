/**
 * Integrations — connect Jira (and, as they are added, GitHub, GitLab, Azure DevOps):
 * import stories as AI-written tests, file bugs for new failures automatically and
 * resolve them when the tests pass, show test results on the stories.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { api, errorMessage, formatDate } from '../../lib/api';
import { useSession } from '../../lib/session';
import { GitHubForm, GitHubSetup } from '../../components/GitHubIntegration';

const CATEGORIES = [
  { value: 'app_bug', label: 'Application bugs' },
  { value: 'environment', label: 'Environment problems' },
  { value: 'test_bug', label: 'Broken tests' },
  { value: 'unknown', label: 'Unclassified' },
];

const blankJira = {
  name: 'Jira', base_url: '', deployment: '', email: '', api_token: '', project_key: '', bug_issue_type: 'Bug',
  defects: true, only_unattended: true, categories: ['app_bug'], resolve_transition: 'Done',
};

function Chips({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[] }) {
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="chip-group">
      {options.map((o) => (
        <div key={o.value} role="checkbox" aria-checked={value.includes(o.value)} tabIndex={0} className={`chip${value.includes(o.value) ? ' selected' : ''}`}
          onClick={() => toggle(o.value)} onKeyDown={(e) => e.key === ' ' && toggle(o.value)}>{o.label}</div>
      ))}
    </div>
  );
}

export default function IntegrationsPage() {
  const session = useSession();
  const isAdmin = session.can('admin');
  const canEdit = session.can('editor');
  const [items, setItems] = useState<any[]>([]);
  const [defects, setDefects] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ ...blankJira });
  const [editing, setEditing] = useState<string | null>(null);
  const [kind, setKind] = useState<'jira' | 'github'>('jira');
  const [githubEditing, setGithubEditing] = useState<any>(null);
  const [setupOpen, setSetupOpen] = useState<string | null>(null);

  // Import stories
  const [importFrom, setImportFrom] = useState('');
  const [importWhat, setImportWhat] = useState('');
  const [importModule, setImportModule] = useState('');
  const [importAgent, setImportAgent] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, d] = await Promise.all([api.get('/integrations'), api.get('/defects')]);
      setItems(i.data);
      setDefects(d.data);
      setImportFrom((cur) => cur || i.data.find((x: any) => x.type === 'jira' || x.type === 'github')?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    load();
    api.get('/agents').then((r) => setAgents(r.data)).catch(() => undefined);
  }, [load]);

  const set = (k: keyof typeof blankJira) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const configOf = (f: typeof blankJira, isNew: boolean) => ({
    base_url: f.base_url.trim(),
    ...(f.deployment ? { deployment: f.deployment } : {}),
    email: f.email.trim(),
    ...(isNew || f.api_token ? { api_token: f.api_token } : {}),
    project_key: f.project_key.trim().toUpperCase(),
    bug_issue_type: f.bug_issue_type.trim() || 'Bug',
    defects: { enabled: f.defects, only_unattended: f.only_unattended, categories: f.categories, resolve_transition: f.resolve_transition.trim() },
  });

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      if (editing) await api.put(`/integrations/${editing}`, { name: form.name, config: configOf(form, false) });
      else {
        const created = (await api.post('/integrations', { type: 'jira', name: form.name, config: configOf(form, true) })).data;
        const check = (await api.post(`/integrations/${created.id}/check`)).data;
        if (!check.ok) throw new Error(`Saved, but the connection check failed: ${check.error}`);
      }
      setForm({ ...blankJira });
      setEditing(null);
    }, editing ? 'Saved.' : 'Jira connected.');
  };

  const edit = (i: any) => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (i.type === 'github') {
      setKind('github');
      setGithubEditing(i);
      return;
    }
    setKind('jira');
    const c = i.config;
    setEditing(i.id);
    setForm({
      name: i.name, base_url: c.base_url ?? '', deployment: c.deployment ?? '', email: c.email ?? '', api_token: '', project_key: c.project_key ?? '',
      bug_issue_type: c.bug_issue_type ?? 'Bug', defects: c.defects?.enabled === true, only_unattended: c.defects?.only_unattended !== false,
      categories: c.defects?.categories?.length ? c.defects.categories : ['app_bug'], resolve_transition: c.defects?.resolve_transition ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const check = (i: any) => act(async () => {
    const r = (await api.post(`/integrations/${i.id}/check`)).data;
    if (!r.ok) throw new Error(`${i.name}: ${r.error}`);
  }, `${i.name}: connected`);

  const runImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImporting(true);
    setImported(null);
    setError(null);
    const what = importWhat.trim();
    const keys = what.split(/[\s,]+/).filter(Boolean);
    const isKeys = keys.length > 0 && keys.every((k) => /^([A-Z][A-Z0-9_]*-\d+|#\d+)$/i.test(k));
    try {
      const res = await api.post(`/integrations/${importFrom}/import`, {
        ...(isKeys ? { keys: keys.map((k) => k.toUpperCase()) } : { query: what }),
        ...(importModule.trim() ? { module: importModule.trim() } : {}),
        ...(importAgent ? { agentId: importAgent } : {}),
      });
      setImported(res.data.issues);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const jiras = items.filter((i) => i.type === 'jira' || i.type === 'github');
  const openDefects = defects.filter((d) => d.status === 'open');

  return (
    <Layout title="Integrations">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {isAdmin && (
        <div className="card mb-6">
          <div className="card-header">
            <h3>{editing ? `Edit ${form.name}` : githubEditing ? `Edit ${githubEditing.name}` : '＋ Connect'}</h3>
            {!editing && !githubEditing && (
              <div className="chip-group" role="radiogroup" aria-label="Integration type">
                {(['jira', 'github'] as const).map((k) => (
                  <div key={k} role="radio" aria-checked={kind === k} tabIndex={0} className={`chip${kind === k ? ' selected' : ''}`} onClick={() => setKind(k)}
                    onKeyDown={(e) => e.key === ' ' && setKind(k)}>{k === 'jira' ? 'Jira' : 'GitHub'}</div>
                ))}
              </div>
            )}
          </div>
          {kind === 'github' ? (
            <div className="card-body">
              <GitHubForm key={githubEditing?.id ?? 'new'} editing={githubEditing} agents={agents} onError={setError}
                onCancel={() => setGithubEditing(null)}
                onSaved={async (message) => { setGithubEditing(null); setNotice(message); await load(); }} />
            </div>
          ) : (
        <form onSubmit={save} data-testid="jira-form">
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <div className="form-group">
                <label className="form-label" htmlFor="j-name">Name *</label>
                <input id="j-name" className="form-control" value={form.name} onChange={set('name')} required />
              </div>
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label" htmlFor="j-url">Jira URL *</label>
                <input id="j-url" className="form-control" value={form.base_url} onChange={set('base_url')} placeholder="https://acme.atlassian.net" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="j-deployment">Deployment</label>
                <select id="j-deployment" className="form-control" value={form.deployment} onChange={set('deployment')}>
                  <option value="">Detect from URL</option>
                  <option value="cloud">Jira Cloud</option>
                  <option value="server">Jira Data Center / Server</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="j-email">Account email {form.deployment !== 'server' && '(Cloud) *'}</label>
                <input id="j-email" className="form-control" type="email" value={form.email} onChange={set('email')} placeholder="qa-bot@acme.com" autoComplete="off" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="j-token">API token {editing ? '(leave empty to keep)' : '*'}</label>
                <input id="j-token" className="form-control" type="password" value={form.api_token} onChange={set('api_token')} autoComplete="new-password" required={!editing} />
                <p className="form-hint">
                  Cloud: <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">create an API token</a>.
                  Data Center: a personal access token. Stored encrypted.
                </p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="j-project">Project key</label>
                <input id="j-project" className="form-control" value={form.project_key} onChange={set('project_key')} placeholder="SHOP" />
                <p className="form-hint">Where bugs are filed; also limits story search.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="j-type">Bug issue type</label>
                <input id="j-type" className="form-control" value={form.bug_issue_type} onChange={set('bug_issue_type')} />
              </div>
            </div>

            <div className="form-group">
              <label className="flex gap-2" style={{ alignItems: 'center' }}>
                <input type="checkbox" checked={form.defects} onChange={(e) => setForm((f) => ({ ...f, defects: e.target.checked }))} />
                <span className="fw-600">File bugs automatically</span>
              </label>
              <p className="form-hint">
                One bug per distinct failure (screenshot attached), never duplicated: a comment is added when it fails again (at most once a day),
                and it is commented and moved to the resolve status when the tests pass again. Needs a project key.
              </p>
            </div>
            {form.defects && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <div className="form-label">For failures classified as</div>
                  <Chips value={form.categories} onChange={(categories) => setForm((f) => ({ ...f, categories }))} options={CATEGORIES} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="j-resolve">Resolve with transition / status</label>
                  <input id="j-resolve" className="form-control" value={form.resolve_transition} onChange={set('resolve_transition')} placeholder="Done" />
                </div>
                <div className="form-group">
                  <label className="flex gap-2" style={{ alignItems: 'center', marginTop: 24 }}>
                    <input type="checkbox" checked={form.only_unattended} onChange={(e) => setForm((f) => ({ ...f, only_unattended: e.target.checked }))} />
                    Only for scheduled / CI runs
                  </label>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" type="submit">{editing ? 'Save' : 'Connect'}</button>
              {editing && <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setEditing(null); setForm({ ...blankJira }); }}>Cancel</button>}
            </div>
          </div>
        </form>
          )}
        </div>
      )}

      <div className="card mb-6">
        <div className="card-header"><h3>Connections</h3></div>
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔗</div>
            <h3>No integrations yet</h3>
            <p>Connect Jira to turn stories into tests and get bugs filed for you overnight; connect GitHub to test every pull request and deployment.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Integration</th><th>Target</th><th>Bugs</th><th>Last check</th><th></th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <Fragment key={i.id}>
                  <tr>
                    <td><div className="fw-600">{i.name}</div><div className="text-sm text-muted">{i.type}{!i.enabled ? ' · disabled' : ''}</div></td>
                    <td className="text-sm">{i.config.base_url ?? i.config.repository ?? i.config.project}{i.config.project_key ? ` · ${i.config.project_key}` : ''}</td>
                    <td className="text-sm">
                      {i.config.defects?.enabled ? `filed for ${(i.config.defects.categories ?? ['app_bug']).join(', ')}` : <span className="text-muted">off</span>}
                      {i.type === 'github' && (
                        <div className="text-muted">
                          {(i.config.triggers ?? []).length} trigger{(i.config.triggers ?? []).length === 1 ? '' : 's'}
                          {i.config.commit_status !== false && ' · commit status'}{i.config.pr_comment !== false && ' · PR comment'}
                        </div>
                      )}
                    </td>
                    <td className="text-sm">
                      {i.lastCheck ? (
                        <>
                          <span className={i.lastCheck.ok ? 'badge badge-success' : 'badge badge-danger'}>{i.lastCheck.ok ? 'connected' : 'failed'}</span>
                          <div className="text-muted">{formatDate(i.lastCheck.at)}{i.lastCheck.account ? ` · ${i.lastCheck.account}` : ''}</div>
                          {i.lastCheck.error && <div className="text-danger">{i.lastCheck.error}</div>}
                        </>
                      ) : <span className="text-muted">never</span>}
                    </td>
                    <td>
                      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                        {canEdit && <button className="btn btn-secondary btn-sm" onClick={() => check(i)}>Check</button>}
                        {i.type === 'github' && <button className="btn btn-secondary btn-sm" onClick={() => setSetupOpen(setupOpen === i.id ? null : i.id)}>Setup</button>}
                        {isAdmin && <button className="btn btn-secondary btn-sm" onClick={() => edit(i)}>Edit</button>}
                        {isAdmin && <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.put(`/integrations/${i.id}`, { enabled: !i.enabled }))}>{i.enabled ? 'Disable' : 'Enable'}</button>}
                        {isAdmin && <button className="btn btn-danger btn-sm" onClick={() => confirm(`Delete “${i.name}”? Links and filed-bug tracking are removed (the issues stay in ${i.type}).`) && act(() => api.delete(`/integrations/${i.id}`))}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                  {setupOpen === i.id && <tr><td colSpan={5} style={{ padding: 0 }}><GitHubSetup integration={i} agents={agents} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && jiras.length > 0 && (
        <form className="card mb-6" onSubmit={runImport} data-testid="import-stories">
          <div className="card-header"><h3>📥 Import stories / issues as tests</h3></div>
          <div className="card-body">
            <p className="text-sm text-muted mb-3">The AI writes test cases from each story&apos;s description and acceptance criteria and links them to it, so the story shows their results after every run.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              {jiras.length > 1 && (
                <div className="form-group">
                  <label className="form-label" htmlFor="imp-from">From</label>
                  <select id="imp-from" className="form-control" value={importFrom} onChange={(e) => setImportFrom(e.target.value)}>
                    {jiras.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                </div>
              )}
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label" htmlFor="imp-what">Stories *</label>
                <input id="imp-what" className="form-control" value={importWhat} onChange={(e) => setImportWhat(e.target.value)} required
                  placeholder='SHOP-12, SHOP-15 or #12  ·  or JQL: sprint in openSprints() AND type = Story  ·  or words' />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="imp-module">Module</label>
                <input id="imp-module" className="form-control" value={importModule} onChange={(e) => setImportModule(e.target.value)} placeholder="Checkout" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="imp-agent">For agent</label>
                <select id="imp-agent" className="form-control" value={importAgent} onChange={(e) => setImportAgent(e.target.value)}>
                  <option value="">Any</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={importing || !importWhat.trim()}>{importing ? 'Writing tests…' : 'Import'}</button>
            {imported && (
              <ul className="mt-3 text-sm" data-testid="import-result">
                {imported.map((r) => (
                  <li key={r.key}>
                    <a href={r.url} target="_blank" rel="noreferrer">{r.key}</a> {r.title}:{' '}
                    {r.error ? <span className="text-danger">{r.error}</span>
                      : r.created.length ? `${r.created.length} test${r.created.length === 1 ? '' : 's'} — ${r.created.map((c: any) => c.title).join('; ')}`
                        : <span className="text-muted">no testable behaviour found</span>}
                  </li>
                ))}
                <li><Link href="/testcases">Open test cases →</Link></li>
              </ul>
            )}
          </div>
        </form>
      )}

      <div className="card">
        <div className="card-header"><h3>🐞 Bugs filed by the platform</h3><span className="text-sm text-muted">{openDefects.length} open</span></div>
        {defects.length === 0 ? (
          <div className="card-body text-sm text-muted">None yet. When enabled, new failures from unattended runs are filed here.</div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table" data-testid="defects">
              <thead><tr><th>Issue</th><th>Status</th><th>Tests</th><th>Seen</th><th>Runs</th></tr></thead>
              <tbody>
                {defects.map((d) => (
                  <tr key={d.id}>
                    <td><a href={d.url} target="_blank" rel="noreferrer" className="fw-600">{d.key}</a><div className="text-sm">{d.title}</div></td>
                    <td><span className={d.status === 'open' ? 'badge badge-danger' : 'badge badge-success'}>{d.status}</span>{d.resolvedAt && <div className="text-sm text-muted">{formatDate(d.resolvedAt)}</div>}</td>
                    <td className="text-sm">{d.tests.map((t: any) => t.title).join(', ')}</td>
                    <td className="text-sm">{d.occurrences}×<div className="text-muted">since {formatDate(d.createdAt)}</div></td>
                    <td className="text-sm">
                      {d.firstRunId && <Link href={`/runs/${d.firstRunId}`}>first</Link>}
                      {d.lastRunId && d.lastRunId !== d.firstRunId && <> · <Link href={`/runs/${d.lastRunId}`}>latest</Link></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
