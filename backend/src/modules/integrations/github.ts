/**
 * GitHub (github.com and GitHub Enterprise Server, REST API v2022-11-28):
 *
 *  - issues as a tracker: bugs filed / commented / closed, issues linked to tests, results shown
 *    on the issue as one comment that is edited after each run;
 *  - commit statuses ("AI tests / <agent>") and one pull request comment per agent;
 *  - webhooks (push, pull_request, deployment_status) understood as GitEvents.
 *
 * Auth: a fine-grained personal access token (or GitHub App installation token) with
 * Issues: read/write, Commit statuses: read/write, Pull requests: read/write, Metadata: read.
 */

import crypto from 'crypto';
import { CodeHost, CommitState, GitEvent, IntegrationError, IssueTracker, NewIssue, RunLink, TrackerIssue } from './types.js';

export interface GitHubConfig {
  repository: string;
  token: string;
  api_url?: string;
  webhook_secret?: string;
}

const RESULTS_MARKER = '<!-- atab:results -->';

/** "#12", "12", "owner/repo#12" or an issue URL → 12 */
export function issueNumber(key: string): number {
  const m = String(key).trim().match(/(?:^|[#/])(\d+)$/);
  if (!m) throw new IntegrationError(`"${key}" is not a GitHub issue number (e.g. #12)`, 400);
  return Number(m[1]);
}

/** X-Hub-Signature-256 check (constant time). */
export function verifyGitHubSignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** A GitHub webhook as a GitEvent; null when it asks for nothing (branch deleted, failed deployment, closed PR, …). */
export function parseGitHubEvent(event: string, p: any): GitEvent | null {
  const repository = p?.repository?.full_name;
  if (!repository) return null;
  if (event === 'push') {
    if (p.deleted || !p.after || /^0+$/.test(p.after) || !String(p.ref).startsWith('refs/heads/')) return null;
    return { event: 'push', repository, sha: p.after, ref: p.ref, branch: String(p.ref).replace('refs/heads/', ''), actor: p.pusher?.name ?? p.sender?.login, title: p.head_commit?.message?.split('\n')[0] };
  }
  if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(p.action)) return null;
    const pr = p.pull_request;
    return {
      event: 'pull_request', repository, sha: pr.head.sha, ref: pr.head.ref, branch: pr.head.ref, baseBranch: pr.base.ref,
      pr: pr.number, draft: !!pr.draft, actor: p.sender?.login, title: pr.title,
    };
  }
  if (event === 'deployment_status') {
    if (p.deployment_status?.state !== 'success') return null;
    const d = p.deployment;
    return {
      event: 'deployment_status', repository, sha: d.sha, ref: d.ref, branch: d.ref, environment: d.environment,
      deploymentUrl: p.deployment_status.environment_url || p.deployment_status.target_url || undefined,
      actor: p.sender?.login, title: `Deployment to ${d.environment}`,
    };
  }
  return null;
}

export class GitHubClient implements IssueTracker, CodeHost {
  private api: string;
  private repo: string;

  constructor(private cfg: GitHubConfig) {
    this.api = String(cfg.api_url || 'https://api.github.com').replace(/\/+$/, '');
    this.repo = String(cfg.repository ?? '').trim();
  }

  private async req(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token ?? ''}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-test-agent-builder',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => {
      throw new IntegrationError(`GitHub is not reachable at ${this.api}: ${e?.cause?.code ?? e.message}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = [j.message, ...(j.errors ?? []).map((e: any) => e.message ?? `${e.field} ${e.code}`)].filter(Boolean).join('; ') || detail;
      } catch {
        // not JSON
      }
      const hint = res.status === 401 ? ' (check the token)'
        : res.status === 403 ? ' (the token lacks a permission: Issues, Commit statuses and Pull requests read/write)'
          : res.status === 404 ? ` (repository ${this.repo} not found, or the token cannot see it)` : '';
      throw new IntegrationError(`GitHub answered HTTP ${res.status}${hint}: ${detail}`, res.status === 404 ? 404 : 502);
    }
    return text ? JSON.parse(text) : {};
  }

  private toIssue(i: any): TrackerIssue {
    return {
      key: `#${i.number}`,
      url: i.html_url,
      title: i.title ?? '',
      status: i.state,
      type: i.pull_request ? 'Pull request' : 'Issue',
      description: i.body ?? '',
      resolved: i.state === 'closed',
    };
  }

  async check() {
    const repo = await this.req('GET', `/repos/${this.repo}`);
    let account = 'token';
    try {
      account = (await this.req('GET', '/user')).login ?? account;
    } catch {
      // GitHub App installation tokens cannot read /user
    }
    return { ok: true as const, account, details: `repository ${repo.full_name}${repo.has_issues === false ? ' (issues are turned off)' : ''}` };
  }

  async search(query: string, limit = 25): Promise<TrackerIssue[]> {
    const keys = query.split(/[\s,]+/).filter(Boolean);
    if (keys.length && keys.every((k) => /^#?\d+$/.test(k))) return Promise.all(keys.slice(0, limit).map((k) => this.get(k)));
    const q = `repo:${this.repo} is:issue ${query}`;
    const res = await this.req('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 100)}`);
    return (res.items ?? []).map((i: any) => this.toIssue(i));
  }

  async get(key: string): Promise<TrackerIssue> {
    return this.toIssue(await this.req('GET', `/repos/${this.repo}/issues/${issueNumber(key)}`));
  }

  async create(issue: NewIssue): Promise<TrackerIssue> {
    return this.toIssue(await this.req('POST', `/repos/${this.repo}/issues`, { title: issue.title, body: issue.body, labels: issue.labels }));
  }

  async comment(key: string, body: string): Promise<void> {
    await this.req('POST', `/repos/${this.repo}/issues/${issueNumber(key)}/comments`, { body });
  }

  async resolve(key: string): Promise<boolean> {
    await this.req('PATCH', `/repos/${this.repo}/issues/${issueNumber(key)}`, { state: 'closed', state_reason: 'completed' });
    return true;
  }

  private async findComment(n: number, marker: string): Promise<any | undefined> {
    for (let page = 1; page <= 5; page++) {
      const comments = await this.req('GET', `/repos/${this.repo}/issues/${n}/comments?per_page=100&page=${page}`);
      const found = comments.find((c: any) => String(c.body ?? '').includes(marker));
      if (found || comments.length < 100) return found;
    }
    return undefined;
  }

  /** One "Test results" comment per issue: a line per test, replaced on each run. */
  async link(key: string, link: RunLink): Promise<void> {
    const n = issueNumber(key);
    const existing = await this.findComment(n, RESULTS_MARKER);
    const lineMarker = `<!-- ${link.id} -->`;
    const line = `- [${link.title}](${link.url}) ${lineMarker}`;
    const lines = String(existing?.body ?? '').split('\n').filter((l) => l.startsWith('- ') && !l.includes(lineMarker));
    const body = [RESULTS_MARKER, '**Automated test results** (updated after every run by AI Test Agent Builder)', '', ...lines, line].join('\n');
    if (existing) await this.req('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
    else await this.req('POST', `/repos/${this.repo}/issues/${n}/comments`, { body });
  }

  /** GitHub has no attachment API: the bug links to the run, which has the screenshots. */
  async attach(): Promise<void> {
    return undefined;
  }

  async setStatus(sha: string, state: CommitState, status: { context: string; description: string; url: string }): Promise<void> {
    await this.req('POST', `/repos/${this.repo}/statuses/${sha}`, {
      state, context: status.context.slice(0, 100), description: status.description.slice(0, 140),
      ...(/^https?:\/\//.test(status.url) ? { target_url: status.url } : {}),
    });
  }

  async upsertPullRequestComment(pr: number, marker: string, body: string): Promise<{ url: string; updated: boolean }> {
    const full = `${marker}\n${body}`;
    const existing = await this.findComment(pr, marker);
    if (existing) {
      const c = await this.req('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body: full });
      return { url: c.html_url, updated: true };
    }
    const c = await this.req('POST', `/repos/${this.repo}/issues/${pr}/comments`, { body: full });
    return { url: c.html_url, updated: false };
  }
}
