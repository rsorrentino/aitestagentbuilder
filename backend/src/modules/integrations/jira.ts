/**
 * Jira adapter: Jira Cloud (REST v3, email + API token, Atlassian Document
 * Format) and Jira Server / Data Center (REST v2, personal access token).
 *
 * config: { base_url, deployment: 'cloud' | 'server', email, api_token*, project_key,
 *           bug_issue_type ('Bug'), defects: {...}, requirements: { report_results } }
 */

import { IntegrationError, IssueTracker, NewIssue, RunLink, TrackerIssue } from './types.js';

export interface JiraConfig {
  base_url: string;
  deployment?: 'cloud' | 'server';
  email?: string;
  api_token?: string;
  project_key?: string;
  bug_issue_type?: string;
}

/** Plain text → Atlassian Document Format (paragraphs, line breaks, links). */
export function textToAdf(text: string): any {
  const inline = (line: string) => {
    const out: any[] = [];
    let last = 0;
    for (const m of line.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
      if (m.index! > last) out.push({ type: 'text', text: line.slice(last, m.index) });
      out.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
      last = m.index! + m[0].length;
    }
    if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
    return out;
  };
  const content = String(text).split(/\n{2,}/).filter((p) => p.trim()).map((para) => ({
    type: 'paragraph',
    content: para.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inline(line)]).filter((n) => n.type !== 'text' || n.text),
  }));
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

/** Atlassian Document Format → plain text (for story descriptions given to the AI). */
export function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content ?? []).map(adfToText).join('');
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type)) return `${inner}\n\n`;
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['bulletList', 'orderedList'].includes(node.type)) return `${inner}\n`;
  if (node.type === 'tableRow') return `${(node.content ?? []).map((c: any) => adfToText(c).trim()).join(' | ')}\n`;
  return inner;
}

const DONE = /^(done|closed|resolved|complete|completed|fatto|chiuso)$/i;

export class JiraClient implements IssueTracker {
  private base: string;
  private cloud: boolean;

  constructor(private cfg: JiraConfig) {
    this.base = String(cfg.base_url ?? '').replace(/\/+$/, '');
    this.cloud = (cfg.deployment ?? (/\.atlassian\.net$/i.test(safeHost(this.base)) ? 'cloud' : 'server')) === 'cloud';
  }

  private get api(): string {
    return `${this.base}/rest/api/${this.cloud ? 3 : 2}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Cloud: email + API token; Data Center / Server: personal access token
    const auth = this.cloud
      ? `Basic ${Buffer.from(`${this.cfg.email ?? ''}:${this.cfg.api_token ?? ''}`).toString('base64')}`
      : `Bearer ${this.cfg.api_token ?? ''}`;
    return { Authorization: auth, Accept: 'application/json', ...extra };
  }

  private async req(method: string, path: string, body?: any, extraHeaders: Record<string, string> = {}): Promise<any> {
    const res = await fetch(`${path.startsWith('http') ? '' : this.api}${path}`, {
      method,
      headers: this.headers(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => {
      throw new IntegrationError(`Jira is not reachable at ${this.base}: ${e?.cause?.code ?? e.message}`);
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ') || detail;
      } catch {
        // not JSON
      }
      const hint = res.status === 401 ? ' (check the email and API token)' : res.status === 403 ? ' (the account lacks permission)' : '';
      throw new IntegrationError(`Jira answered HTTP ${res.status}${hint}: ${detail}`, res.status === 404 ? 404 : 502);
    }
    return text ? JSON.parse(text) : {};
  }

  private browse(key: string) {
    return `${this.base}/browse/${key}`;
  }

  private toIssue(i: any): TrackerIssue {
    const desc = i.fields?.description;
    return {
      key: i.key,
      url: this.browse(i.key),
      title: i.fields?.summary ?? '',
      status: i.fields?.status?.name,
      type: i.fields?.issuetype?.name,
      description: typeof desc === 'string' ? desc : adfToText(desc).trim(),
      resolved: i.fields?.status?.statusCategory?.key === 'done' || DONE.test(i.fields?.status?.name ?? ''),
    };
  }

  async check() {
    const me = await this.req('GET', '/myself');
    let details: string | undefined;
    if (this.cfg.project_key) {
      const p = await this.req('GET', `/project/${encodeURIComponent(this.cfg.project_key)}`);
      details = `project ${p.key} — ${p.name}`;
    }
    return { ok: true as const, account: me.displayName ?? me.emailAddress ?? me.name ?? 'unknown', ...(details ? { details } : {}) };
  }

  async search(query: string, limit = 50): Promise<TrackerIssue[]> {
    // A bare key list or text becomes JQL
    const q = query.trim();
    const jql = /^[A-Z][A-Z0-9_]+-\d+(\s*,\s*[A-Z][A-Z0-9_]+-\d+)*$/i.test(q)
      ? `key in (${q.split(',').map((k) => k.trim().toUpperCase()).join(',')})`
      : /[=~]|\b(order by|and|or|in)\b/i.test(q) ? q
        : `${this.cfg.project_key ? `project = ${this.cfg.project_key} AND ` : ''}text ~ "${q.replace(/"/g, '\\"')}"`;
    const fields = 'summary,description,status,issuetype';
    const params = new URLSearchParams({ jql, fields, maxResults: String(Math.min(limit, 100)) });
    const data = this.cloud
      ? await this.req('GET', `/search/jql?${params}`)
      : await this.req('GET', `/search?${params}`);
    return (data.issues ?? []).map((i: any) => this.toIssue(i));
  }

  async get(key: string): Promise<TrackerIssue> {
    return this.toIssue(await this.req('GET', `/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype`));
  }

  async create(issue: NewIssue): Promise<TrackerIssue> {
    if (!this.cfg.project_key) throw new IntegrationError('Set the Jira project key to file issues', 400);
    const created = await this.req('POST', '/issue', {
      fields: {
        project: { key: this.cfg.project_key },
        summary: issue.title.slice(0, 250),
        issuetype: { name: issue.issueType ?? this.cfg.bug_issue_type ?? 'Bug' },
        labels: issue.labels.map((l) => l.replace(/\s+/g, '-')),
        description: this.cloud ? textToAdf(issue.body) : issue.body,
      },
    });
    return { key: created.key, url: this.browse(created.key), title: issue.title, status: 'open' };
  }

  async comment(key: string, body: string): Promise<void> {
    await this.req('POST', `/issue/${encodeURIComponent(key)}/comment`, { body: this.cloud ? textToAdf(body) : body });
  }

  async resolve(key: string, transition?: string): Promise<boolean> {
    if (!transition) return false;
    const { transitions = [] } = await this.req('GET', `/issue/${encodeURIComponent(key)}/transitions`);
    const t = transitions.find((x: any) => x.name?.toLowerCase() === transition.toLowerCase() || x.to?.name?.toLowerCase() === transition.toLowerCase());
    if (!t) return false;
    await this.req('POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }

  async link(key: string, link: RunLink): Promise<void> {
    await this.req('POST', `/issue/${encodeURIComponent(key)}/remotelink`, {
      globalId: link.id,
      application: { type: 'ai-test-agent-builder', name: 'AI Test Agent Builder' },
      relationship: 'tested by',
      object: {
        url: link.url,
        title: link.title,
        status: { resolved: link.passed === true, icon: { title: link.passed === null ? 'Not run' : link.passed ? 'Passed' : 'Failed' } },
      },
    });
  }

  async attach(key: string, file: { name: string; data: Buffer; contentType: string }): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
    await this.req('POST', `/issue/${encodeURIComponent(key)}/attachments`, form, { 'X-Atlassian-Token': 'no-check' });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
