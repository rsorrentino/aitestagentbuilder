/**
 * GitHub integration (integration, real PostgreSQL + headless Chromium, a fake GitHub
 * REST API): signed webhooks start runs for pull requests and preview deployments,
 * the commit gets a status and the pull request one comment that is updated, bugs are
 * filed as issues and closed when fixed, issues linked to tests show their results,
 * CI runs started through the API report to the commit too, and the Actions workflow.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-github-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '2500',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

const TOKEN = 'ghp_fake_token_123';
const SECRET = 'webhook-secret-0123456789';

// ---- the application (production and a preview deployment) ----
let cartBroken = true;
const shop = (broken: () => boolean) => http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Shop</title><h1>Cart</h1><p id="total">${broken() ? 'NaN' : '42.00'}</p>`);
});

// ---- fake GitHub ----
const gh = {
  statuses: [] as Array<{ sha: string; state: string; context: string; description: string; target_url?: string }>,
  issues: new Map<number, any>([[7, { number: 7, title: 'Cart shows the order total', body: 'Acceptance: 42.00', state: 'open', html_url: 'https://github.test/acme/shop/issues/7' }]]),
  comments: [] as Array<{ id: number; issue: number; body: string; html_url: string }>,
  next: 100,
};
async function fakeGitHub(req: http.IncomingMessage, res: http.ServerResponse) {
  const send = (status: number, body?: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  if (p === '/user') return send(200, { login: 'qa-bot' });
  if (p === '/repos/acme/shop') return send(200, { full_name: 'acme/shop', has_issues: true });
  if ((m = p.match(/^\/repos\/acme\/shop\/statuses\/(\w+)$/))) { gh.statuses.push({ sha: m[1], ...body }); return send(201, {}); }
  if (p === '/repos/acme/shop/issues' && req.method === 'POST') {
    const n = gh.next++;
    gh.issues.set(n, { number: n, ...body, state: 'open', html_url: `https://github.test/acme/shop/issues/${n}` });
    return send(201, gh.issues.get(n));
  }
  if ((m = p.match(/^\/repos\/acme\/shop\/issues\/(\d+)$/))) {
    const issue = gh.issues.get(Number(m[1]));
    if (!issue) return send(404, { message: 'Not Found' });
    if (req.method === 'PATCH') Object.assign(issue, body);
    return send(200, issue);
  }
  if ((m = p.match(/^\/repos\/acme\/shop\/issues\/(\d+)\/comments$/))) {
    const n = Number(m[1]);
    if (req.method === 'GET') return send(200, gh.comments.filter((c) => c.issue === n));
    const c = { id: gh.next++, issue: n, body: body.body, html_url: `https://github.test/acme/shop/issues/${n}#c${gh.next}` };
    gh.comments.push(c);
    return send(201, c);
  }
  if ((m = p.match(/^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/))) {
    const c = gh.comments.find((x) => x.id === Number(m![1]))!;
    c.body = body.body;
    return send(200, c);
  }
  if (p === '/search/issues') return send(200, { items: [...gh.issues.values()].filter((i) => /cart/i.test(i.title) && /cart/i.test(url.searchParams.get('q') ?? '')) });
  send(404, { message: `No route ${req.method} ${p}` });
}

let app: Server;
let preview: Server;
let github: Server;
let api: Server;
let base = '';
let previewUrl = '';
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, data?: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${apiUrl}/api/v1${path}`, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text };
}
let delivery = 0;
function hook(integrationId: string, event: string, payload: any, opts: { secret?: string; delivery?: string } = {}) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac('sha256', opts.secret ?? SECRET).update(raw).digest('hex')}`;
  return call('POST', `/hooks/github/${integrationId}`, raw, { 'X-GitHub-Event': event, 'X-Hub-Signature-256': sig, 'X-GitHub-Delivery': opts.delivery ?? `d-${++delivery}` });
}
/** A run is done for this test once its integrations ran (they report into run.metadata). */
async function finished(runId: string): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const run = (await call('GET', `/runs/${runId}`)).data;
    if (!['pending', 'running'].includes(run.status) && run.metadata?.integrations) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Run ${runId} did not finish`);
}
const repo = { full_name: 'acme/shop' };
const pr = (action: string, sha: string, extra: any = {}) => ({ action, repository: repo, sender: { login: 'dev' }, pull_request: { number: 12, title: 'Fix cart', draft: false, head: { sha, ref: 'fix-cart' }, base: { ref: 'main' }, ...extra } });

before(async () => {
  const pg = (await import('pg')).default;
  const probe = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
    await probe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!dbAvailable) return;
  app = shop(() => cartBroken);
  preview = shop(() => false);
  github = http.createServer((req, res) => void fakeGitHub(req, res));
  for (const s of [app, preview, github]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  previewUrl = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { createApp } = await import('../../app.js');
  const { initializeWebSocket } = await import('../../infra/websocket/server.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  await runMigrations();
  api = http.createServer(createApp());
  const ws = initializeWebSocket(api);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    await ws.close();
    for (const s of [api, app, preview, github]) s.closeAllConnections();
    for (const s of [api, app, preview, github]) await new Promise((r) => s.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('GitHub integration (integration)', () => {
  it('runs tests for pull requests and deployments and reports on commits, pull requests and issues', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, evidence: { trace: 'off', video: 'off' }, unattended: { rerun_failed: false } } })).data;
    const tc = (await call('POST', '/testcases', {
      title: 'Cart shows the order total', module: 'Cart', priority: 'High', expectedResults: ['42.00'],
      steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#total', data: { value: '42.00' } }],
    })).data;

    // Connect: secrets hidden, trigger agents checked
    const config = {
      repository: 'acme/shop', token: TOKEN, api_url: `http://127.0.0.1:${(github.address() as AddressInfo).port}`, webhook_secret: SECRET,
      triggers: [
        { event: 'pull_request', agent_id: agent.id, branches: ['main'] },
        { event: 'deployment_status', agent_id: agent.id, environments: ['preview*'], use_deployment_url: true },
      ],
      defects: { enabled: true },
    };
    const bad = await call('POST', '/integrations', { type: 'github', name: 'GitHub', config: { ...config, triggers: [{ event: 'push', agent_id: 'nope' }], webhook_secret: 'short' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /webhook_secret must be at least 16 characters/);
    assert.match((await call('POST', '/integrations', { type: 'github', name: 'GitHub', config: { ...config, triggers: [{ event: 'push', agent_id: 'nope' }] } })).data.error, /unknown agent nope/);
    const created = await call('POST', '/integrations', { type: 'github', name: 'Shop repo', config });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.config.token, '••••••••');
    assert.equal(created.data.config.webhook_secret, '••••••••');
    const id = created.data.id;
    assert.deepEqual((await call('POST', `/integrations/${id}/check`)).data, { ok: true, account: 'qa-bot', details: 'repository acme/shop' });

    // Webhook security and events that ask for nothing
    assert.equal((await hook(id, 'pull_request', pr('opened', 'a1'), { secret: 'wrong-secret-0123456789' })).status, 401);
    assert.equal((await hook('00000000-0000-0000-0000-000000000000', 'ping', {})).status, 404);
    assert.match((await hook(id, 'ping', { zen: 'hi', repository: repo })).data.message, /Connected to Shop repo/);
    assert.match((await hook(id, 'pull_request', pr('closed', 'a1'))).data.ignored, /Nothing to test for pull_request \(closed\)/);
    assert.match((await hook(id, 'push', { ref: 'refs/heads/feature', after: 'b1', repository: repo })).data.ignored, /No trigger matches this push on feature/);
    assert.match((await hook(id, 'pull_request', pr('opened', 'a1', { draft: true }))).data.ignored, /No trigger matches/);
    assert.match((await hook(id, 'pull_request', { ...pr('opened', 'a1'), repository: { full_name: 'acme/other' } })).data.ignored, /for acme\/other/);

    // Pull request opened, the cart is broken: failing status, a comment, a bug
    const opened = await hook(id, 'pull_request', pr('opened', 'aaa111'), { delivery: 'same-delivery' });
    assert.equal(opened.status, 202, opened.text);
    assert.equal((await hook(id, 'pull_request', pr('opened', 'aaa111'), { delivery: 'same-delivery' })).data.ignored, 'Delivery already handled');
    const run1 = await finished(opened.data.runs[0].runId);
    assert.equal(run1.status, 'failed');
    assert.equal(run1.metadata.triggeredBy, 'webhook');
    assert.deepEqual([run1.metadata.git.pr, run1.metadata.git.sha, run1.metadata.git.event], [12, 'aaa111', 'pull_request']);
    const s1 = gh.statuses.filter((s) => s.sha === 'aaa111');
    assert.deepEqual(s1.map((s) => s.state), ['pending', 'failure']);
    assert.equal(s1[0].context, 'AI tests / Shop');
    assert.equal(s1[1].description, '1 of 1 failed');
    assert.match(s1[1].target_url!, new RegExp(`/runs/${run1.id}$`));
    const prComments = () => gh.comments.filter((c) => c.issue === 12);
    assert.equal(prComments().length, 1);
    assert.match(prComments()[0].body, /^<!-- atab:run:/);
    assert.match(prComments()[0].body, /### ❌ AI tests failed: Shop/);
    assert.match(prComments()[0].body, /\| Cart shows the order total \| Expected #total to contain "42.00" but found "NaN" \|/);
    assert.match(prComments()[0].body, /Bugs filed: \[#100\]/);
    const bug = gh.issues.get(100);
    assert.match(bug.title, /^\[Automated test\] Shop: Expected #total/);
    assert.ok(bug.labels.includes('atab'));
    assert.deepEqual(run1.metadata.integrations[0].filed.map((f: any) => f.key), ['#100']);

    // New commit fixes it: success, the same comment edited, the bug closed
    cartBroken = false;
    const sync = await hook(id, 'pull_request', pr('synchronize', 'bbb222'));
    const run2 = await finished(sync.data.runs[0].runId);
    assert.equal(run2.status, 'completed');
    assert.deepEqual(gh.statuses.filter((s) => s.sha === 'bbb222').map((s) => s.state), ['pending', 'success']);
    assert.equal(prComments().length, 1, 'edited, not added');
    assert.match(prComments()[0].body, /### ✅ AI tests passed: Shop/);
    assert.equal(bug.state, 'closed');
    assert.equal(bug.state_reason, 'completed');
    assert.ok(gh.comments.some((c) => c.issue === 100 && /Passing again in run/.test(c.body)));

    // Preview deployment: tested at the deployed address
    const deployed = await hook(id, 'deployment_status', {
      repository: repo, sender: { login: 'vercel' },
      deployment: { sha: 'ccc333', ref: 'fix-cart', environment: 'preview-12' }, deployment_status: { state: 'success', environment_url: previewUrl },
    });
    const run3 = await finished(deployed.data.runs[0].runId);
    assert.equal(run3.metadata.baseUrl, previewUrl);
    assert.equal(run3.status, 'completed');
    assert.deepEqual(gh.statuses.filter((s) => s.sha === 'ccc333').map((s) => s.state), ['pending', 'success']);
    assert.match((await hook(id, 'deployment_status', { repository: repo, deployment: { sha: 'x', environment: 'production' }, deployment_status: { state: 'success' } })).data.ignored, /to production/);

    // Issues as requirements: results on the issue, one comment kept up to date
    assert.equal((await call('POST', `/testcases/${tc.id}/links`, { integrationId: id, key: '#7' })).status, 201);
    assert.deepEqual((await call('GET', `/integrations/${id}/issues?q=cart`)).data.map((i: any) => i.key), ['#7']);
    assert.deepEqual((await call('GET', `/integrations/${id}/issues?q=%237,100`)).data.map((i: any) => [i.key, i.status]), [['#7', 'open'], ['#100', 'closed']]);

    // A CI job (GitHub Actions) starting the run through the API reports to its commit as well
    const ci = await call('POST', '/runs', { agentId: agent.id, wait: true, metadata: { triggeredBy: 'ci', git: { provider: 'github', repository: 'acme/shop', sha: 'ddd444', pr: 12 } } });
    assert.equal(ci.data.status, 'completed', ci.text);
    await finished(ci.data.id);
    assert.deepEqual(gh.statuses.filter((s) => s.sha === 'ddd444').map((s) => s.state), ['pending', 'success']);
    const results = gh.comments.filter((c) => c.issue === 7);
    assert.equal(results.length, 1);
    assert.match(results[0].body, /<!-- atab:results -->/);
    assert.match(results[0].body, /- \[✅ Test “Cart shows the order total”: passed/);
    assert.equal(prComments().length, 1);
    assert.equal((await call('POST', '/runs', { agentId: agent.id, baseUrl: 'ftp://nope' })).status, 400);

    // The GitHub Actions workflow for the agent
    const wf = await call('GET', `/integrations/${id}/workflow?agentId=${agent.id}&apiUrl=https://atab.example.com/api/v1`);
    assert.equal(wf.data.path, '.github/workflows/ai-tests.yml');
    assert.match(wf.data.yaml, new RegExp(`ATAB_AGENT: ${agent.id}`));
    assert.match(wf.data.yaml, /ATAB_URL: https:\/\/atab\.example\.com\/api\/v1/);
    assert.match(wf.data.yaml, /Authorization: ApiKey \$ATAB_API_KEY/);
    assert.match(wf.data.yaml, /\$\{\{ secrets\.ATAB_API_KEY \}\}/);
    assert.equal((await call('GET', `/integrations/${id}/workflow?agentId=nope`)).status, 400);
  });
});
