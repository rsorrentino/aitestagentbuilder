/**
 * GitLab (gitlab.com and self-managed, REST API v4):
 *
 *  - issues as a tracker (bugs filed with the screenshot uploaded, commented, closed;
 *    issues linked to tests with one results note kept up to date);
 *  - commit statuses ("AI tests / <agent>", shown in pipelines and merge requests) and one
 *    merge request note per agent;
 *  - webhooks (Push Hook, Merge Request Hook, Deployment Hook) as GitEvents.
 *
 * Auth: a project access token (or personal access token) with the `api` scope, role Developer or higher.
 */

import crypto from 'crypto';
import { issueNumber } from './github.js';
import { CodeHost, CommitState, GitEvent, IntegrationError, IssueTracker, NewIssue, RunLink, TrackerIssue } from './types.js';

export interface GitLabConfig {
  project: string;
  token: string;
  base_url?: string;
  webhook_secret?: string;
}

const RESULTS_MARKER = '<!-- atab:results -->';
const ZERO = /^0+$/;

/** X-Gitlab-Token check (the secret is sent as is), constant time. */
export function verifyGitLabToken(secret: string, token: string | undefined): boolean {
  if (!secret || !token) return false;
  const a = crypto.createHash('sha256').update(secret).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** A GitLab webhook as a GitEvent; null when it asks for nothing. */
export function parseGitLabEvent(event: string, p: any): GitEvent | null {
  const repository = p?.project?.path_with_namespace;
  if (!repository) return null;
  const repositoryId = p.project.id !== undefined ? String(p.project.id) : undefined;
  if (event === 'Push Hook') {
    if (!p.after || ZERO.test(p.after) || !String(p.ref).startsWith('refs/heads/')) return null;
    const last = (p.commits ?? []).find((c: any) => c.id === p.after);
    return { event: 'push', repository, repositoryId, sha: p.after, ref: p.ref, branch: String(p.ref).replace('refs/heads/', ''), actor: p.user_username ?? p.user_name, title: last?.title };
  }
  if (event === 'Merge Request Hook') {
    const a = p.object_attributes ?? {};
    // "update" also fires for title, label or assignee changes: only new commits (oldrev) count
    if (!(['open', 'reopen'].includes(a.action) || (a.action === 'update' && a.oldrev))) return null;
    if (a.state && a.state !== 'opened') return null;
    return {
      event: 'pull_request', repository, repositoryId, sha: a.last_commit?.id, ref: a.source_branch, branch: a.source_branch, baseBranch: a.target_branch,
      pr: a.iid, draft: !!(a.draft ?? a.work_in_progress), actor: p.user?.username, title: a.title,
    };
  }
  if (event === 'Deployment Hook') {
    if (p.status !== 'success' || !p.sha) return null;
    return {
      event: 'deployment_status', repository, repositoryId, sha: p.sha, ref: p.ref, branch: p.ref, environment: p.environment,
      deploymentUrl: p.environment_external_url || undefined, actor: p.user?.username, title: `Deployment to ${p.environment}`,
    };
  }
  return null;
}

const STATE: Record<CommitState, string> = { pending: 'running', success: 'success', failure: 'failed', error: 'failed' };

export class GitLabClient implements IssueTracker, CodeHost {
  private api: string;
  private project: string;

  constructor(private cfg: GitLabConfig) {
    this.api = `${String(cfg.base_url || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`;
    this.project = encodeURIComponent(String(cfg.project ?? '').trim());
  }

  private async req(method: string, path: string, body?: any): Promise<any> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': this.cfg.token ?? '', Accept: 'application/json', ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => {
      throw new IntegrationError(`GitLab is not reachable at ${this.api}: ${e?.cause?.code ?? e.message}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = typeof j.message === 'string' ? j.message : JSON.stringify(j.message ?? j.error ?? j).slice(0, 300);
      } catch {
        // not JSON
      }
      const hint = res.status === 401 ? ' (check the token)'
        : res.status === 403 ? ' (the token needs the api scope and the Developer role)'
          : res.status === 404 ? ` (project ${decodeURIComponent(this.project)} not found, or the token cannot see it)` : '';
      throw new IntegrationError(`GitLab answered HTTP ${res.status}${hint}: ${detail}`, res.status === 404 ? 404 : 502);
    }
    return text ? JSON.parse(text) : {};
  }

  private toIssue(i: any): TrackerIssue {
    return { key: `#${i.iid}`, url: i.web_url, title: i.title ?? '', status: i.state, type: i.issue_type ?? 'issue', description: i.description ?? '', resolved: i.state === 'closed' };
  }

  async check() {
    const project = await this.req('GET', `/projects/${this.project}`);
    let account = 'token';
    try {
      account = (await this.req('GET', '/user')).username ?? account;
    } catch {
      // some tokens cannot read /user
    }
    return { ok: true as const, account, details: `project ${project.path_with_namespace}${project.issues_enabled === false ? ' (issues are turned off)' : ''}` };
  }

  async search(query: string, limit = 25): Promise<TrackerIssue[]> {
    const keys = query.split(/[\s,]+/).filter(Boolean);
    if (keys.length && keys.every((k) => /^#?\d+$/.test(k))) return Promise.all(keys.slice(0, limit).map((k) => this.get(k)));
    const res = await this.req('GET', `/projects/${this.project}/issues?search=${encodeURIComponent(query)}&per_page=${Math.min(limit, 100)}`);
    return res.map((i: any) => this.toIssue(i));
  }

  async get(key: string): Promise<TrackerIssue> {
    return this.toIssue(await this.req('GET', `/projects/${this.project}/issues/${issueNumber(key)}`));
  }

  async create(issue: NewIssue): Promise<TrackerIssue> {
    return this.toIssue(await this.req('POST', `/projects/${this.project}/issues`, { title: issue.title, description: issue.body, labels: issue.labels.join(',') }));
  }

  async comment(key: string, body: string): Promise<void> {
    await this.req('POST', `/projects/${this.project}/issues/${issueNumber(key)}/notes`, { body });
  }

  async resolve(key: string): Promise<boolean> {
    await this.req('PUT', `/projects/${this.project}/issues/${issueNumber(key)}`, { state_event: 'close' });
    return true;
  }

  private async findNote(kind: 'issues' | 'merge_requests', iid: number, marker: string): Promise<any | undefined> {
    for (let page = 1; page <= 5; page++) {
      const notes = await this.req('GET', `/projects/${this.project}/${kind}/${iid}/notes?per_page=100&page=${page}&sort=asc`);
      const found = notes.find((n: any) => String(n.body ?? '').includes(marker));
      if (found || notes.length < 100) return found;
    }
    return undefined;
  }

  private async upsertNote(kind: 'issues' | 'merge_requests', iid: number, marker: string, body: string) {
    const existing = await this.findNote(kind, iid, marker);
    if (existing) return { note: await this.req('PUT', `/projects/${this.project}/${kind}/${iid}/notes/${existing.id}`, { body }), updated: true };
    return { note: await this.req('POST', `/projects/${this.project}/${kind}/${iid}/notes`, { body }), updated: false };
  }

  async link(key: string, link: RunLink): Promise<void> {
    const iid = issueNumber(key);
    const existing = await this.findNote('issues', iid, RESULTS_MARKER);
    const lineMarker = `<!-- ${link.id} -->`;
    const lines = String(existing?.body ?? '').split('\n').filter((l) => l.startsWith('- ') && !l.includes(lineMarker));
    const body = [RESULTS_MARKER, '**Automated test results** (updated after every run by AI Test Agent Builder)', '', ...lines, `- [${link.title}](${link.url}) ${lineMarker}`].join('\n');
    await this.upsertNote('issues', iid, RESULTS_MARKER, body);
  }

  /** Upload the screenshot to the project and show it in a note on the issue. */
  async attach(key: string, file: { name: string; data: Buffer; contentType: string }): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
    const up = await this.req('POST', `/projects/${this.project}/uploads`, form);
    await this.comment(key, `Screenshot of the failure:\n\n${up.markdown}`);
  }

  async setStatus(sha: string, state: CommitState, status: { context: string; description: string; url: string }): Promise<void> {
    await this.req('POST', `/projects/${this.project}/statuses/${sha}`, {
      state: STATE[state], name: status.context.slice(0, 255), description: status.description.slice(0, 255),
      ...(/^https?:\/\//.test(status.url) ? { target_url: status.url } : {}),
    });
  }

  async upsertPullRequestComment(mr: number, marker: string, body: string): Promise<{ url: string; updated: boolean }> {
    const { note, updated } = await this.upsertNote('merge_requests', mr, marker, `${marker}\n${body}`);
    const project = decodeURIComponent(this.project);
    const web = this.api.replace(/\/api\/v4$/, '');
    return { url: /^\d+$/.test(project) ? `${web}/-/merge_requests/${mr}#note_${note.id}` : `${web}/${project}/-/merge_requests/${mr}#note_${note.id}`, updated };
  }
}
