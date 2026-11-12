/**
 * Azure DevOps (Services and Server, REST API 7.1):
 *
 *  - work items as a tracker: bugs filed (repro steps, tags, screenshot attached), commented,
 *    moved to a resolved state; work items (user stories) linked to tests with one results
 *    comment kept up to date; stories imported by id or WIQL;
 *  - Azure Repos: commit statuses ("AI tests / <agent>") and one pull request thread per agent;
 *  - service hooks (git.push, git.pullrequest.created / updated) as GitEvents.
 *
 * Auth: a personal access token with Work Items (read & write) and Code (status, read & write)
 * scopes. Service hooks send the integration's webhook secret in the X-ATAB-Token header (or
 * as the basic authentication password).
 */

import crypto from 'crypto';
import { issueNumber } from './github.js';
import { CodeHost, CommitState, GitEvent, IntegrationError, IssueTracker, NewIssue, RunLink, TrackerIssue } from './types.js';

export interface AzureDevOpsConfig {
  organization_url: string;
  project: string;
  pat: string;
  /** Azure Repos repository (name or id): needed for statuses, PR comments and triggers */
  repository?: string;
  work_item_type?: string;
  webhook_secret?: string;
}

const API = 'api-version=7.1';
const COMMENTS_API = 'api-version=7.1-preview.4';
const RESULTS_TITLE = 'Automated test results (atab)';
const ZERO = /^0+$/;
const branchOf = (ref?: string) => String(ref ?? '').replace(/^refs\/heads\//, '');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text (blank-line paragraphs) → HTML for work item fields and comments. */
export function textToHtml(text: string): string {
  return String(text).split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p).replace(/https?:\/\/[^\s<>"]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>')}</p>`).join('');
}

/** HTML of a work item field → plain text (for the AI). */
export function htmlToText(html: string): string {
  return String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

/** Service hook check: X-ATAB-Token header or basic auth password equals the secret (constant time). */
export function verifyAzureHook(secret: string, headers: { token?: string; authorization?: string }): boolean {
  if (!secret) return false;
  let given = headers.token;
  if (!given && headers.authorization?.startsWith('Basic ')) given = Buffer.from(headers.authorization.slice(6), 'base64').toString().split(':').slice(1).join(':');
  if (!given) return false;
  const a = crypto.createHash('sha256').update(secret).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** An Azure DevOps service hook as a GitEvent; null when it asks for nothing. */
export function parseAzureEvent(p: any): GitEvent | null {
  const r = p?.resource ?? {};
  const repository = r.repository?.name;
  if (!repository) return null;
  if (p.eventType === 'git.push') {
    const u = (r.refUpdates ?? []).find((x: any) => String(x.name).startsWith('refs/heads/') && x.newObjectId && !ZERO.test(x.newObjectId));
    if (!u) return null;
    return { event: 'push', repository, repositoryId: r.repository.id, sha: u.newObjectId, ref: u.name, branch: branchOf(u.name), actor: r.pushedBy?.uniqueName ?? r.pushedBy?.displayName, title: r.commits?.[0]?.comment?.split('\n')[0] };
  }
  if (p.eventType === 'git.pullrequest.created' || p.eventType === 'git.pullrequest.updated') {
    if (r.status && r.status !== 'active') return null;
    // "updated" also fires for votes, reviewers, descriptions: only new commits on the source branch count
    if (p.eventType === 'git.pullrequest.updated' && !/source branch/i.test(String(p.message?.text ?? ''))) return null;
    const sha = r.lastMergeSourceCommit?.commitId;
    if (!sha) return null;
    return {
      event: 'pull_request', repository, repositoryId: r.repository.id, sha, ref: r.sourceRefName, branch: branchOf(r.sourceRefName), baseBranch: branchOf(r.targetRefName),
      pr: r.pullRequestId, draft: !!r.isDraft, actor: r.createdBy?.uniqueName, title: r.title,
    };
  }
  return null;
}

const STATE: Record<CommitState, string> = { pending: 'pending', success: 'succeeded', failure: 'failed', error: 'error' };

export class AzureDevOpsClient implements IssueTracker, CodeHost {
  private org: string;
  private project: string;

  constructor(private cfg: AzureDevOpsConfig) {
    this.org = String(cfg.organization_url ?? '').replace(/\/+$/, '');
    this.project = encodeURIComponent(String(cfg.project ?? '').trim());
  }

  private async req(method: string, path: string, body?: any, contentType = 'application/json'): Promise<any> {
    const res = await fetch(path.startsWith('http') ? path : `${this.org}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${this.cfg.pat ?? ''}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': contentType } : {}),
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => {
      throw new IntegrationError(`Azure DevOps is not reachable at ${this.org}: ${e?.cause?.code ?? e.message}`);
    });
    const text = await res.text();
    // A wrong token is answered with a redirect to the sign-in page
    if (res.status >= 300 && res.status < 400) throw new IntegrationError(`Azure DevOps answered HTTP ${res.status} (check the personal access token)`);
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = JSON.parse(text).message ?? detail;
      } catch {
        // not JSON
      }
      const hint = res.status === 401 ? ' (check the personal access token)' : res.status === 403 ? ' (the token lacks the Work Items or Code scope)' : '';
      throw new IntegrationError(`Azure DevOps answered HTTP ${res.status}${hint}: ${detail}`, res.status === 404 ? 404 : 502);
    }
    return text ? JSON.parse(text) : {};
  }

  private get repo(): string {
    if (!this.cfg.repository) throw new IntegrationError('Set config.repository (the Azure Repos repository) for commit statuses and pull request comments', 400);
    return encodeURIComponent(this.cfg.repository);
  }

  private toIssue(w: any): TrackerIssue {
    const f = w.fields ?? {};
    const state = String(f['System.State'] ?? '');
    return {
      key: `#${w.id}`,
      url: w._links?.html?.href ?? `${this.org}/${this.project}/_workitems/edit/${w.id}`,
      title: f['System.Title'] ?? '',
      status: state,
      type: f['System.WorkItemType'],
      description: htmlToText([f['System.Description'], f['Microsoft.VSTS.Common.AcceptanceCriteria'] ? `<p>Acceptance criteria:</p>${f['Microsoft.VSTS.Common.AcceptanceCriteria']}` : ''].filter(Boolean).join('')),
      resolved: /^(resolved|closed|done|removed)$/i.test(state),
    };
  }

  async check() {
    const project = await this.req('GET', `/_apis/projects/${this.project}?${API}`);
    let account = 'token';
    try {
      const data = await this.req('GET', '/_apis/connectionData');
      account = data.authenticatedUser?.providerDisplayName ?? account;
    } catch {
      // not essential
    }
    let details = `project ${project.name}`;
    if (this.cfg.repository) {
      const repo = await this.req('GET', `/${this.project}/_apis/git/repositories/${this.repo}?${API}`);
      details += `, repository ${repo.name}`;
    }
    return { ok: true as const, account, details };
  }

  private async getMany(ids: number[]): Promise<TrackerIssue[]> {
    if (!ids.length) return [];
    const res = await this.req('GET', `/${this.project}/_apis/wit/workitems?ids=${ids.slice(0, 200).join(',')}&$expand=links&${API}`);
    return (res.value ?? []).map((w: any) => this.toIssue(w));
  }

  async search(query: string, limit = 25): Promise<TrackerIssue[]> {
    const keys = query.split(/[\s,]+/).filter(Boolean);
    if (keys.length && keys.every((k) => /^#?\d+$/.test(k))) return this.getMany(keys.slice(0, limit).map((k) => issueNumber(k)));
    const wiql = /^\s*select\s/i.test(query) ? query
      : `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '${query.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`;
    const res = await this.req('POST', `/${this.project}/_apis/wit/wiql?$top=${Math.min(limit, 100)}&${API}`, { query: wiql });
    return this.getMany((res.workItems ?? []).slice(0, limit).map((w: any) => w.id));
  }

  async get(key: string): Promise<TrackerIssue> {
    return this.toIssue(await this.req('GET', `/${this.project}/_apis/wit/workitems/${issueNumber(key)}?$expand=links&${API}`));
  }

  async create(issue: NewIssue): Promise<TrackerIssue> {
    const type = issue.issueType || this.cfg.work_item_type || 'Bug';
    const html = textToHtml(issue.body);
    const ops = [
      { op: 'add', path: '/fields/System.Title', value: issue.title.slice(0, 255) },
      { op: 'add', path: type === 'Bug' ? '/fields/Microsoft.VSTS.TCM.ReproSteps' : '/fields/System.Description', value: html },
      { op: 'add', path: '/fields/System.Tags', value: issue.labels.join('; ') },
    ];
    const w = await this.req('POST', `/${this.project}/_apis/wit/workitems/$${encodeURIComponent(type)}?${API}`, ops, 'application/json-patch+json');
    return this.toIssue(w);
  }

  async comment(key: string, body: string): Promise<void> {
    await this.req('POST', `/${this.project}/_apis/wit/workItems/${issueNumber(key)}/comments?${COMMENTS_API}`, { text: textToHtml(body) });
  }

  /** Move to the resolve state: the configured one, else Resolved, Closed or Done (whichever the process has). */
  async resolve(key: string, transition?: string): Promise<boolean> {
    for (const state of transition ? [transition] : ['Resolved', 'Closed', 'Done']) {
      try {
        await this.req('PATCH', `/${this.project}/_apis/wit/workitems/${issueNumber(key)}?${API}`, [{ op: 'add', path: '/fields/System.State', value: state }], 'application/json-patch+json');
        return true;
      } catch {
        // state not allowed for this work item type: try the next
      }
    }
    return false;
  }

  async link(key: string, link: RunLink): Promise<void> {
    const id = issueNumber(key);
    const res = await this.req('GET', `/${this.project}/_apis/wit/workItems/${id}/comments?$top=200&${COMMENTS_API}`);
    const existing = (res.comments ?? []).find((c: any) => String(c.text ?? '').includes(RESULTS_TITLE));
    const tag = `<code>${link.id}</code>`;
    const items = (String(existing?.text ?? '').match(/<li>.*?<\/li>/g) ?? []).filter((li) => !li.includes(tag));
    items.push(`<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a> ${tag}</li>`);
    const text = `<p><b>${RESULTS_TITLE}</b>: updated after every run by AI Test Agent Builder</p><ul>${items.join('')}</ul>`;
    if (existing) await this.req('PATCH', `/${this.project}/_apis/wit/workItems/${id}/comments/${existing.id}?${COMMENTS_API}`, { text });
    else await this.req('POST', `/${this.project}/_apis/wit/workItems/${id}/comments?${COMMENTS_API}`, { text });
  }

  async attach(key: string, file: { name: string; data: Buffer; contentType: string }): Promise<void> {
    const up = await this.req('POST', `/${this.project}/_apis/wit/attachments?fileName=${encodeURIComponent(file.name)}&${API}`, file.data, 'application/octet-stream');
    await this.req('PATCH', `/${this.project}/_apis/wit/workitems/${issueNumber(key)}?${API}`,
      [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'Screenshot of the failure' } } }], 'application/json-patch+json');
  }

  async setStatus(sha: string, state: CommitState, status: { context: string; description: string; url: string }): Promise<void> {
    const [genre, ...rest] = status.context.split(' / ');
    await this.req('POST', `/${this.project}/_apis/git/repositories/${this.repo}/commits/${sha}/statuses?${API}`, {
      state: STATE[state], description: status.description.slice(0, 255),
      context: { genre: rest.length ? genre : 'AI tests', name: (rest.length ? rest.join(' / ') : status.context).slice(0, 100) },
      ...(/^https?:\/\//.test(status.url) ? { targetUrl: status.url } : {}),
    });
  }

  async upsertPullRequestComment(pr: number, marker: string, body: string): Promise<{ url: string; updated: boolean }> {
    const base = `/${this.project}/_apis/git/repositories/${this.repo}/pullRequests/${pr}/threads`;
    const content = `${marker}\n${body}`;
    const threads = (await this.req('GET', `${base}?${API}`)).value ?? [];
    const thread = threads.find((t: any) => String(t.comments?.[0]?.content ?? '').includes(marker));
    const url = `${this.org}/${this.project}/_git/${this.repo}/pullrequest/${pr}`;
    if (thread) {
      await this.req('PATCH', `${base}/${thread.id}/comments/${thread.comments[0].id}?${API}`, { content });
      return { url: `${url}?discussionId=${thread.id}`, updated: true };
    }
    const created = await this.req('POST', `${base}?${API}`, { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 'active' });
    return { url: `${url}?discussionId=${created.id}`, updated: false };
  }
}
