/**
 * Jira integration (integration, real PostgreSQL + headless Chromium, a fake
 * Jira Cloud REST API): connection check, story search and import as AI-written
 * tests linked to the story, bugs filed for new failures (deduplicated,
 * screenshot attached), resolved when the tests pass, results on the story,
 * requirement coverage. The AI is a fake Copilot CLI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-jira-'));

// Fake Copilot CLI: turns the story into one test case of the cart page
const isWindows = process.platform === 'win32';
const fakeScript = isWindows ? join(workDir, 'node_modules', 'fake-copilot', 'index.js') : join(workDir, 'copilot');
const fakeCli = isWindows ? join(workDir, 'copilot.cmd') : fakeScript;
mkdirSync(dirname(fakeScript), { recursive: true });
writeFileSync(fakeScript, `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
if (prompt.includes('SHOP-1')) console.log(JSON.stringify([{ title: 'Cart shows the order total', module: 'Cart', priority: 'High',
  steps: [{ action: 'navigate', target: '/cart' }, { action: 'assert_text', target: '#total', data: { value: '42.00' } }], expectedResults: ['Total 42.00'] }]));
else console.log('[]');
`);
chmodSync(fakeScript, 0o755);
if (isWindows) writeFileSync(fakeCli, '@ECHO off\r\nSETLOCAL\r\nendLocal & "node" "%dp0%\\node_modules\\fake-copilot\\index.js" %*\r\n');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '2500', COPILOT_MODE: 'cli', COPILOT_CLI_PATH: fakeCli,
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

// ---- the application: the cart total is broken until fixed ----
let cartBroken = true;
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

// ---- fake Jira Cloud ----
const EMAIL = 'qa-bot@example.com';
const TOKEN = 'jira-token-123';
const jira = {
  issues: new Map<string, any>([
    ['SHOP-1', { key: 'SHOP-1', fields: { summary: 'Cart shows the order total', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'As a shopper I see the total. Acceptance: total is 42.00 for the demo cart.' }] }] }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' } } }],
    ['SHOP-2', { key: 'SHOP-2', fields: { summary: 'Checkout', description: null, status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' } } }],
  ]),
  comments: [] as Array<{ key: string; text: string }>,
  transitions: [] as Array<{ key: string; id: string }>,
  remoteLinks: new Map<string, any>(),
  attachments: [] as Array<{ key: string; bytes: number; token: string | undefined }>,
  next: 100,
};
const adfText = (n: any): string => (!n ? '' : n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n\n' : ''));

async function fakeJira(req: http.IncomingMessage, res: http.ServerResponse) {
  const send = (status: number, body?: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.headers.authorization !== `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`) return send(401, { errorMessages: ['Unauthorized'] });
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const body = (req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw.toString()) : undefined;
  const p = url.pathname.replace('/rest/api/3', '');
  let m: RegExpMatchArray | null;
  if (p === '/myself') return send(200, { displayName: 'QA Bot', emailAddress: EMAIL });
  if (p === '/project/SHOP') return send(200, { key: 'SHOP', name: 'Shop' });
  if (p === '/search/jql') {
    const jql = url.searchParams.get('jql') ?? '';
    const keys = (jql.match(/key in \(([^)]*)\)/)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    const found = [...jira.issues.values()].filter((i) => (keys.length ? keys.includes(i.key) : /text ~ "cart"/i.test(jql) ? /cart/i.test(i.fields.summary) : true));
    return send(200, { issues: found });
  }
  if (p === '/issue' && req.method === 'POST') {
    const key = `SHOP-${jira.next++}`;
    jira.issues.set(key, { key, fields: { ...body.fields, status: { name: 'To Do', statusCategory: { key: 'new' } } } });
    return send(201, { key, id: String(jira.next) });
  }
  if ((m = p.match(/^\/issue\/([A-Z]+-\d+)$/))) {
    const i = jira.issues.get(m[1]);
    return i ? send(200, i) : send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
  }
  if ((m = p.match(/^\/issue\/([A-Z]+-\d+)\/comment$/))) {
    jira.comments.push({ key: m[1], text: adfText(body.body) });
    return send(201, { id: '1' });
  }
  if ((m = p.match(/^\/issue\/([A-Z]+-\d+)\/transitions$/))) {
    if (req.method === 'GET') return send(200, { transitions: [{ id: '21', name: 'In Progress', to: { name: 'In Progress' } }, { id: '31', name: 'Done', to: { name: 'Done' } }] });
    jira.transitions.push({ key: m[1], id: body.transition.id });
    return send(204);
  }
  if ((m = p.match(/^\/issue\/([A-Z]+-\d+)\/remotelink$/))) {
    jira.remoteLinks.set(`${m[1]}|${body.globalId}`, body);
    return send(201, { id: 1 });
  }
  if ((m = p.match(/^\/issue\/([A-Z]+-\d+)\/attachments$/))) {
    jira.attachments.push({ key: m[1], bytes: raw.length, token: req.headers['x-atlassian-token'] as string | undefined });
    return send(200, [{ id: '1' }]);
  }
  send(404, { errorMessages: [`No route ${req.method} ${p}`] });
}

let app: Server;
let jiraServer: Server;
let base = '';
let jiraUrl = '';
let api: Server;
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, data?: any): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${apiUrl}/api/v1${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text };
}
async function run(agentId: string, testIds: string[], triggeredBy = 'schedule'): Promise<any> {
  const r = await call('POST', '/runs', { agentId, testIds, wait: true, timeoutSeconds: 120, metadata: { triggeredBy } });
  assert.ok([200, 202].includes(r.status), r.text);
  return (await call('GET', `/runs/${r.data.id}`)).data;
}

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
  app = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url === '/cart' ? page('Cart', `<p id="total">${cartBroken ? 'NaN' : '42.00'}</p>`) : page('Home', ''));
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  jiraServer = http.createServer((req, res) => void fakeJira(req, res));
  await new Promise<void>((r) => jiraServer.listen(0, '127.0.0.1', () => r()));
  jiraUrl = `http://127.0.0.1:${(jiraServer.address() as AddressInfo).port}`;
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
    for (const s of [api, app, jiraServer]) s.closeAllConnections();
    for (const s of [api, app, jiraServer]) await new Promise((r) => s.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('Jira integration (integration)', () => {
  it('imports stories as tests, files and resolves bugs, and reports results on the story', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    // Connection (token encrypted, never returned) and check
    const bad = await call('POST', '/integrations', { type: 'jira', name: 'Jira', config: { base_url: jiraUrl, deployment: 'cloud' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /email is required.*api_token is required/);
    const created = await call('POST', '/integrations', {
      type: 'jira', name: 'Shop Jira',
      config: { base_url: jiraUrl, deployment: 'cloud', email: EMAIL, api_token: TOKEN, project_key: 'SHOP', defects: { enabled: true, resolve_transition: 'Done' } },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.config.api_token, '••••••••');
    const jiraId = created.data.id;
    const check = await call('POST', `/integrations/${jiraId}/check`);
    assert.deepEqual(check.data, { ok: true, account: 'QA Bot', details: 'project SHOP — Shop' });

    // Search and import: the AI writes the story's tests, linked to it
    const found = await call('GET', `/integrations/${jiraId}/issues?q=cart`);
    assert.deepEqual(found.data.map((i: any) => i.key), ['SHOP-1']);
    assert.match(found.data[0].description, /total is 42\.00/);
    const imported = await call('POST', `/integrations/${jiraId}/import`, { keys: ['SHOP-1'] });
    assert.equal(imported.status, 200, imported.text);
    const testId = imported.data.issues[0].created[0].id;
    assert.equal(imported.data.issues[0].created[0].title, 'Cart shows the order total');
    const links = await call('GET', `/testcases/${testId}/links`);
    assert.deepEqual(links.data.map((l: any) => [l.key, l.title]), [['SHOP-1', 'Cart shows the order total']]);
    assert.ok((await call('GET', `/testcases/${testId}`)).data.tags.includes('jira:SHOP-1'));

    // Night run, the cart is broken: one bug, with the screenshot; the story shows the failure
    const agent = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, evidence: { trace: 'off', video: 'off' }, unattended: { rerun_failed: false } } })).data.id;
    const night1 = await run(agent, [testId]);
    assert.equal(night1.status, 'failed');
    const filed = night1.metadata.integrations[0].filed;
    assert.equal(filed.length, 1, JSON.stringify(night1.metadata.integrations));
    const bug = jira.issues.get(filed[0].key);
    assert.equal(bug.fields.issuetype.name, 'Bug');
    assert.match(bug.fields.summary, /^\[Automated test\] Shop: Expected #total to contain "42\.00"/);
    assert.ok(bug.fields.labels.includes('atab') && bug.fields.labels.some((l: string) => /^atab-[0-9a-f]{10}$/.test(l)));
    assert.match(adfText(bug.fields.description), /Failing test\(s\):\n- Cart shows the order total/);
    assert.equal(jira.attachments.length, 1);
    assert.equal(jira.attachments[0].token, 'no-check');
    const storyLink = jira.remoteLinks.get(`SHOP-1|atab-test-${testId}`);
    assert.match(storyLink.object.title, /^❌ Test “Cart shows the order total”: failed/);
    assert.equal(storyLink.object.status.resolved, false);

    // Same failure the next night: no new bug, no comment the same day
    const night2 = await run(agent, [testId]);
    assert.equal(night2.metadata.integrations?.[0]?.filed?.length ?? 0, 0);
    assert.equal([...jira.issues.keys()].filter((k) => k.startsWith('SHOP-1') && k !== 'SHOP-1').length, 1, 'still one bug');
    const defects = (await call('GET', '/defects?status=open')).data;
    assert.equal(defects.length, 1);
    assert.equal(defects[0].occurrences, 2);

    // A person's run does not file bugs
    const manual = await run(agent, [testId], 'user');
    assert.equal(manual.metadata.integrations?.[0]?.filed?.length ?? 0, 0);

    // Fixed: the bug gets a comment and is moved to Done; the story shows the pass
    cartBroken = false;
    const night3 = await run(agent, [testId]);
    assert.equal(night3.status, 'completed');
    assert.deepEqual(night3.metadata.integrations[0].resolved, [filed[0].key]);
    assert.ok(jira.comments.some((c) => c.key === filed[0].key && /Passing again in run/.test(c.text)));
    assert.deepEqual(jira.transitions, [{ key: filed[0].key, id: '31' }]);
    assert.equal(jira.remoteLinks.get(`SHOP-1|atab-test-${testId}`).object.status.resolved, true);
    assert.equal((await call('GET', '/defects?status=open')).data.length, 0);

    // Requirement coverage and manual links
    const link = await call('POST', `/testcases/${testId}/links`, { integrationId: jiraId, key: 'SHOP-2' });
    assert.equal(link.status, 201, link.text);
    assert.equal((await call('POST', `/testcases/${testId}/links`, { integrationId: jiraId, key: 'SHOP-999' })).status, 404);
    const coverage = await call('GET', '/requirements/coverage');
    assert.deepEqual(coverage.data.requirements.map((r: any) => [r.key, r.state]), [['SHOP-1', 'passing'], ['SHOP-2', 'passing']]);
    assert.equal(coverage.data.summary.passing, 2);
    assert.equal((await call('DELETE', `/testcases/${testId}/links/${jiraId}/SHOP-2`)).status, 204);

    // Wrong token: a readable check result
    await call('PUT', `/integrations/${jiraId}`, { config: { api_token: 'wrong' } });
    const failed = await call('POST', `/integrations/${jiraId}/check`);
    assert.equal(failed.data.ok, false);
    assert.match(failed.data.error, /HTTP 401 \(check the email and API token\)/);
    assert.ok(!failed.text.includes('wrong'));
  });
});
