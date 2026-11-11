/**
 * Quality extensions (integration, real PostgreSQL + headless Chromium):
 * accessibility checks, trace/video evidence with secret redaction, visual
 * regression with baselines and approval, and keeping AI-healed selectors.
 * The AI is a local fake of the GitHub Copilot CLI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import JSZip from 'jszip';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-quality-'));
const ARTIFACTS = join(workDir, 'artifacts');

// Fake Copilot CLI: answers selector-healing prompts with "#new-id" and counts its calls.
const isWindows = process.platform === 'win32';
const callsFile = join(workDir, 'copilot-calls.txt');
const fakeScript = isWindows ? join(workDir, 'node_modules', 'fake-copilot', 'index.js') : join(workDir, 'copilot');
const fakeCli = isWindows ? join(workDir, 'copilot.cmd') : fakeScript;
mkdirSync(dirname(fakeScript), { recursive: true });
writeFileSync(fakeScript, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, 'call\\n');
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
if (prompt.includes('fix broken UI test selectors')) console.log('[{"selector": "#new-id"}]');
else if (prompt.includes('senior API test engineer')) console.log(JSON.stringify([{ title: 'Unknown order is 404', module: 'Orders', priority: 'High',
  steps: [{ action: 'http_request', target: 'api/orders/999' }, { action: 'assert_status', data: { value: 404 } }], expectedResults: ['404'] }]));
else if (prompt.includes('You are a strict QA judge')) {
  const expectation = (prompt.match(/Expectation: (.*)/) || [])[1] || '';
  if (expectation.includes('unsure')) console.log('{"verdict": "unsure", "confidence": 0.3, "reason": "The content does not say"}');
  else if (expectation.includes('everything has a name') && prompt.includes('Everything here has a name')) console.log('{"verdict": "pass", "confidence": 0.92, "reason": "The page says everything has a name"}');
  else console.log('{"verdict": "fail", "confidence": 0.85, "reason": "No shopping cart is shown on the page"}');
}
else if (prompt.includes('You generate test data for software tests')) console.log(JSON.stringify([
  { _label: 'valid', email: 'ada@example.com', qty: 2 }, { _label: 'empty email', email: '', qty: 1, 'bad key': 'x' }, 'not a row']));
else if (prompt.includes('You triage failed UI test runs')) console.log('[{"group": 1, "category": "app_bug", "cause": "The page no longer shows the expected text", "suggestion": "Check the release notes of the last deploy"}]');
else console.log('[]');
`);
chmodSync(fakeScript, 0o755);
if (isWindows) writeFileSync(fakeCli, '@ECHO off\r\nSETLOCAL\r\nendLocal & "node" "%dp0%\\node_modules\\fake-copilot\\index.js" %*\r\n');
const copilotCalls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'false',
  ARTIFACTS_PATH: ARTIFACTS,
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '2500',
  COPILOT_MODE: 'cli',
  COPILOT_CLI_PATH: fakeCli,
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) {
  delete process.env[k];
}

// ---- application under test ----
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:0}main{padding:20px}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
// ---- a small JSON API with an OpenAPI description ----
const ORDERS: any[] = [{ id: 1, item: 'Book', total: 12.5, status: 'open' }];
const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0' },
  servers: [{ url: '/api' }],
  paths: {
    '/orders': {
      get: { tags: ['Orders'], summary: 'List orders', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } },
      post: {
        tags: ['Orders'], summary: 'Create an order',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, 400: { description: 'invalid' } },
      },
    },
    '/orders/{id}': {
      get: {
        tags: ['Orders'], summary: 'Get an order',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 1 } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, 404: { description: 'not found' } },
      },
    },
    '/customers/{customerId}': {
      get: { summary: 'No example for the id', parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
    },
  },
  components: {
    schemas: {
      NewOrder: { type: 'object', required: ['item'], properties: { item: { type: 'string', example: 'Pen' }, quantity: { type: 'integer', example: 2 } } },
      Order: { type: 'object', required: ['id', 'item', 'status'], properties: { id: { type: 'integer' }, item: { type: 'string' }, status: { type: 'string' }, total: { type: 'number' } } },
    },
  },
};

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-123', ...headers });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/openapi.json') return send(200, OPENAPI);
  if (url.pathname === '/api/price') return send(200, { price: '19.99' });
  if (url.pathname === '/api/slow') return void setTimeout(() => send(200, { ok: true }), 400);
  if (url.pathname === '/api/orders' && req.method === 'GET') return send(200, ORDERS);
  if (url.pathname === '/api/orders' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (!body.item) return send(400, { error: 'item is required' });
      const order = { id: ORDERS.length + 1, item: body.item, total: (body.quantity ?? 1) * 5, status: 'open' };
      ORDERS.push(order);
      send(201, order);
    });
    return;
  }
  const m = url.pathname.match(/^\/api\/orders\/(\d+)$/);
  if (m) {
    const order = ORDERS.find((o) => o.id === Number(m[1]));
    return order ? send(200, order) : send(404, { error: 'not found' });
  }
  send(404, { error: 'not found' });
}

let flakyVisits = 0;
let flakyMode: 'flaky' | 'stable' = 'flaky';
const PAGES: Record<string, (q: URLSearchParams) => string> = {
  '/good': () => page('Accessible page', '<p>Everything here has a name.</p><button type="button">Save</button>'),
  // Images without alt text, an unnamed button and an unlabeled input: serious/critical axe violations
  '/bad': () => `<!doctype html><html><head><title>Bad</title></head><body>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button></button><input type="text"></body></html>`,
  '/box': (q) => page('Box', `<div id="box" style="width:300px;height:120px;background:${q.get('color') === 'red' ? '#d00' : '#00d'}"></div>`),
  '/login': () => page('Login', '<label for="pw">Password</label><input id="pw" type="password"><button type="button">Go</button>'),
  // The button was "renamed": tests still use #old-id
  // Alternates OK / broken on each visit while flakyMode is 'flaky'
  '/flaky': () => {
    flakyVisits++;
    const ok = flakyMode === 'stable' || flakyVisits % 2 === 1;
    return page('Flaky', ok ? '<p id="state">OK</p>' : '<p id="state">Oops</p>');
  },
  // Shows the price from the API, or a message when the API fails
  '/checkout': () => page('Checkout', `<p id="price">…</p><script>
    fetch('/api/price').then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d) => { document.getElementById('price').textContent = 'Price: ' + d.price; })
      .catch(() => { document.getElementById('price').textContent = 'Price unavailable'; });
  </script>`),
  // Echoes a form back: data-driven tests fill it and check the result
  '/signup': () => page('Signup', `<form onsubmit="event.preventDefault(); document.getElementById('out').textContent =
    'Welcome ' + document.getElementById('name').value + ' <' + document.getElementById('email').value + '>' + ' x' + document.getElementById('qty').value;">
    <label for="name">Name</label><input id="name"><label for="email">Email</label><input id="email">
    <label for="qty">Quantity</label><input id="qty"><button type="submit">Sign up</button></form><p id="out"></p>`),
  '/heal': () => page('Heal', '<button id="new-id" type="button" onclick="document.getElementById(\'out\').textContent=\'clicked\'">Continue</button><p id="out"></p>'),
};

let fixture: Server;
let fixtureUrl = '';
let api: Server;
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, body?: any): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

async function newAgent(name: string, config: Record<string, any> = {}): Promise<string> {
  const res = await call('POST', '/api/v1/agents', { name, config: { base_url: fixtureUrl, ...config } });
  assert.equal(res.status, 201, res.text);
  return res.data.id;
}

async function newTest(title: string, steps: any[], data?: Record<string, any>): Promise<string> {
  const res = await call('POST', '/api/v1/testcases', { title, module: 'Quality', priority: 'High', steps, expectedResults: ['ok'], ...(data ? { data } : {}) });
  assert.equal(res.status, 201, res.text);
  return res.data.id;
}

async function run(agentId: string, testIds: string[]): Promise<any> {
  const res = await call('POST', '/api/v1/runs', { agentId, testIds, wait: true, timeoutSeconds: 120 });
  assert.ok([200, 202].includes(res.status), res.text);
  return (await call('GET', `/api/v1/runs/${res.data.id}`)).data;
}

const artifact = (signedPath: string) => join(ARTIFACTS, ...signedPath.split('?')[0].split('/'));

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

  fixture = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname.startsWith('/api/') || url.pathname === '/openapi.json') return void handleApi(req, res, url);
    const render = PAGES[url.pathname];
    res.writeHead(render ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(render ? render(url.searchParams) : 'not found');
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', () => r()));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { createApp } = await import('../../app.js');
  const { initializeWebSocket } = await import('../../infra/websocket/server.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  await runMigrations();
  api = http.createServer(createApp());
  const ws = initializeWebSocket(api);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    await ws.close();
    api.closeAllConnections();
    fixture.closeAllConnections();
    await new Promise((r) => api.close(r));
    await new Promise((r) => fixture.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('quality extensions (integration)', () => {
  it('checks accessibility with axe-core, as a step and as an agent-wide scan', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('A11y', { evidence: { trace: 'off', video: 'off' } });
    const good = await newTest('Accessible page passes', [{ action: 'navigate', target: '/good' }, { action: 'assert_accessible' }]);
    const bad = await newTest('Inaccessible page fails', [{ action: 'navigate', target: '/bad' }, { action: 'Verify the page is accessible (WCAG)' }]);
    const ignored = await newTest('Known issues ignored', [
      { action: 'navigate', target: '/bad' },
      { action: 'assert_accessible', data: { ignore: ['image-alt', 'button-name', 'label', 'html-has-lang', 'document-title', 'landmark-one-main', 'page-has-heading-one', 'region'] } },
    ]);
    const r = await run(agent, [good, bad, ignored]);
    const by = (title: string) => r.results.find((x: any) => x.metadata.title === title);

    assert.equal(by('Accessible page passes').status, 'passed', by('Accessible page passes').error);
    const failed = by('Inaccessible page fails');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /accessibility violation\(s\) at serious\+ \(WCAG21AA\)/);
    const ids = failed.metadata.accessibility[0].violations.map((v: any) => v.id);
    for (const id of ['image-alt', 'button-name', 'label']) assert.ok(ids.includes(id), `expected ${id} in ${ids}`);
    assert.equal(by('Known issues ignored').status, 'passed', by('Known issues ignored').error);

    // Agent-wide scan of the last page of every test
    const strict = await newAgent('A11y strict', { checks: { accessibility: 'fail' }, evidence: { trace: 'off', video: 'off' } });
    const onlyNav = await newTest('Just open the bad page', [{ action: 'navigate', target: '/bad' }]);
    const r2 = await run(strict, [onlyNav]);
    assert.equal(r2.results[0].status, 'failed');
    assert.match(r2.results[0].error, /image-alt/);
  });

  it('keeps a redacted trace and a video of failed tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const secret = 'Sup3r-Secret-Value-42';
    const agent = await newAgent('Evidence', { secrets: { PASSWORD: secret } });
    const failing = await newTest('Fails after typing a secret', [
      { action: 'navigate', target: '/login' },
      { action: 'fill', target: '#pw', data: { value: '{{secrets.PASSWORD}}' } },
      { action: 'assert_text', data: { value: 'Welcome back' } },
    ]);
    const passing = await newTest('Passes without evidence', [{ action: 'navigate', target: '/good' }]);
    const r = await run(agent, [failing, passing]);
    const bad = r.results.find((x: any) => x.testCaseId === failing);
    const good = r.results.find((x: any) => x.testCaseId === passing);
    assert.equal(bad.status, 'failed');
    assert.match(bad.evidence.trace, /-trace\.zip\?exp=\d+&sig=/);
    assert.match(bad.evidence.video, /-video\.webm\?exp=\d+&sig=/);
    assert.ok(existsSync(artifact(bad.evidence.video)), 'video file stored');
    assert.equal(good.evidence.trace, undefined, 'no trace for passing tests by default');
    assert.equal(good.evidence.video, undefined);

    // The trace is a valid Playwright trace and the secret is masked everywhere in it
    const zip = await JSZip.loadAsync(readFileSync(artifact(bad.evidence.trace)));
    const names = Object.keys(zip.files);
    assert.ok(names.some((n) => n.endsWith('.trace')), `trace entries: ${names.join(', ')}`);
    let all = '';
    for (const n of names) if (!zip.files[n].dir) all += await zip.files[n].async('string');
    assert.ok(!all.includes(secret), 'secret must not appear in the trace');
    assert.ok(all.includes('••••'), 'masked value present');
    assert.ok(bad.metadata.traceRedactions >= 1);

    // The trace is served
    const served = await fetch(`${apiUrl}/artifacts/${bad.evidence.trace}`);
    assert.equal(served.status, 200);

    // "always" keeps evidence for passing tests too
    const always = await newAgent('Evidence always', { evidence: { trace: 'always', video: 'off' } });
    const r2 = await run(always, [passing]);
    assert.ok(r2.results[0].evidence.trace);
    assert.equal(r2.results[0].evidence.video, undefined);
  });

  it('compares screenshots with baselines and lets a reviewer approve a change', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Visual', { evidence: { trace: 'off', video: 'off' } });
    const blue = await newTest('Box is blue', [{ action: 'navigate', target: '/box?color=blue' }, { action: 'assert_screenshot', target: '#box', data: { name: 'box' } }]);
    const red = await newTest('Box turned red', [{ action: 'navigate', target: '/box?color=red' }, { action: 'Verify the box looks the same visually', target: '#box', data: { name: 'box' } }]);

    const first = await run(agent, [blue]);
    assert.equal(first.results[0].status, 'passed', first.results[0].error);
    assert.equal(first.results[0].metadata.visual[0].status, 'created');

    const second = await run(agent, [blue]);
    assert.equal(second.results[0].metadata.visual[0].status, 'passed');

    const changed = await run(agent, [red]);
    const res = changed.results[0];
    assert.equal(res.status, 'failed');
    assert.match(res.error, /differs from the baseline: \d+(\.\d+)?% of pixels/);
    const entry = res.metadata.visual[0];
    for (const key of ['baseline', 'actual', 'diff']) {
      assert.match(entry[key], /\.png\?exp=\d+&sig=/, key);
      assert.equal((await fetch(`${apiUrl}/artifacts/${entry[key]}`)).status, 200, `${key} image served`);
    }

    const list = await call('GET', `/api/v1/visual/baselines?agentId=${agent}`);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].name, 'box');
    assert.equal(list.data[0].viewport, '1280x800');

    // Only failed comparisons can be approved
    const wrong = await call('POST', `/api/v1/runs/${second.id}/results/${second.results[0].id}/visual/approve`, { name: 'box' });
    assert.equal(wrong.status, 400);
    const approved = await call('POST', `/api/v1/runs/${changed.id}/results/${res.id}/visual/approve`, { name: 'box' });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.data.sourceRunId, changed.id);

    const after = await run(agent, [red]);
    assert.equal(after.results[0].status, 'passed', after.results[0].error);
    assert.equal(after.results[0].metadata.visual[0].status, 'passed');
    const reloaded = (await call('GET', `/api/v1/runs/${changed.id}`)).data;
    assert.equal(reloaded.results[0].metadata.visual[0].approved, true);
  });

  it('reuses healed selectors within a run and writes them back to the test case', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Healing', { ai: { self_healing: true, provider: 'copilot' }, evidence: { trace: 'off', video: 'off' } });
    const steps = [{ action: 'navigate', target: '/heal' }, { action: 'click', target: '#old-id' }, { action: 'assert_text', target: '#out', data: { value: 'clicked' } }];
    const one = await newTest('Heal me once', steps);
    const two = await newTest('Heal me twice', steps);

    const before = copilotCalls();
    const r = await run(agent, [one, two]);
    for (const res of r.results) assert.equal(res.status, 'passed', `${res.error}\n${(res.logs ?? []).join('\n')}\ncalls=${copilotCalls() - before}`);
    assert.equal(copilotCalls() - before, 1, 'the second test reuses the healed selector without calling the AI');
    const second = r.results.find((x: any) => x.testCaseId === two);
    assert.match(second.metadata.steps[1].message, /healed selector reused/);
    assert.deepEqual(second.metadata.healing.steps, [{ stepId: 2, from: '#old-id', to: '#new-id' }]);
    assert.equal(second.metadata.healing.applied, false);

    // Apply on request
    const firstResult = r.results.find((x: any) => x.testCaseId === one);
    const applied = await call('POST', `/api/v1/runs/${r.id}/results/${firstResult.id}/apply-healing`, {});
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(applied.data.applied, [{ stepId: 2, from: '#old-id', to: '#new-id' }]);
    assert.equal((await call('GET', `/api/v1/testcases/${one}`)).data.steps[1].target, '#new-id');
    const again = await call('POST', `/api/v1/runs/${r.id}/results/${firstResult.id}/apply-healing`, {});
    assert.equal(again.data.applied.length, 0, 'already applied: the step no longer has the broken selector');

    // Automatic write-back
    const auto = await newAgent('Healing auto', { ai: { self_healing: true, provider: 'copilot', auto_apply_healing: true }, evidence: { trace: 'off', video: 'off' } });
    const three = await newTest('Heal me automatically', steps);
    const r2 = await run(auto, [three]);
    assert.equal(r2.results[0].status, 'passed', r2.results[0].error);
    assert.equal(r2.results[0].metadata.healing.applied, true);
    assert.equal((await call('GET', `/api/v1/testcases/${three}`)).data.steps[1].target, '#new-id');
  });

  it('triages failures: groups, categories, known vs new, AI explanation', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Triage', { evidence: { trace: 'off', video: 'off' } });
    const wrongText = await newTest('Shows the promo banner', [{ action: 'navigate', target: '/good' }, { action: 'assert_text', data: { value: 'Summer sale' } }]);
    const wrongText2 = await newTest('Shows the promo banner (mobile)', [{ action: 'navigate', target: '/good' }, { action: 'assert_text', data: { value: 'Winter sale' } }]);
    const missing = await newTest('Clicks a removed button', [{ action: 'navigate', target: '/good' }, { action: 'click', target: '#removed-button' }]);
    // A port that was free a moment ago: nothing listens there
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const down = await newTest('Opens a server that is down', [{ action: 'navigate', target: `http://127.0.0.1:${closedPort}/` }]);
    const ids = [wrongText, wrongText2, missing, down];

    const first = await run(agent, ids);
    const triage = first.metadata.triage;
    assert.ok(triage, 'failed runs are triaged automatically');
    assert.equal(triage.ai, false);
    assert.deepEqual(triage.summary, { app_bug: 2, test_bug: 1, environment: 1, unknown: 0 });
    const byCategory = (c: string) => triage.groups.find((g: any) => g.category === c);
    assert.equal(byCategory('app_bug').tests.length, 2, 'the two text assertions are one group');
    assert.equal(byCategory('test_bug').sample.target, '#removed-button');
    assert.match(byCategory('environment').sample.error, /ERR_CONNECTION_REFUSED/);
    assert.ok(triage.groups.every((g: any) => g.seenBefore === 0 && g.source === 'rules'));
    assert.ok(first.results.every((r: any) => r.metadata.failureSignature));

    // The same failures again: now known
    const second = await run(agent, ids);
    assert.ok(second.metadata.triage.groups.every((g: any) => g.seenBefore === 1 && g.firstSeen));

    // On demand, with the AI explaining the groups
    const explained = await call('POST', `/api/v1/runs/${second.id}/triage`, { ai: true });
    assert.equal(explained.status, 200, explained.text);
    assert.equal(explained.data.ai, true);
    const firstGroup = explained.data.groups[0];
    assert.equal(firstGroup.source, 'ai');
    assert.equal(firstGroup.cause, 'The page no longer shows the expected text');
    assert.equal(firstGroup.suggestion, 'Check the release notes of the last deploy');
    assert.equal((await call('GET', `/api/v1/runs/${second.id}`)).data.metadata.triage.ai, true, 'stored on the run');

    // Passing runs are not triaged
    const passing = await newTest('Passes', [{ action: 'navigate', target: '/good' }]);
    const ok = await run(agent, [passing]);
    assert.equal(ok.metadata?.triage, undefined);
  });

  it('quarantines flaky tests automatically: they run but do not fail the run, and are released when stable', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Flaky', { quarantine: { auto: true, flips: 2, release_after: 2 }, evidence: { trace: 'off', video: 'off' } });
    const flaky = await newTest('Sometimes works', [{ action: 'navigate', target: '/flaky' }, { action: 'assert_text', target: '#state', data: { value: 'OK' } }]);
    const steady = await newTest('Always works', [{ action: 'navigate', target: '/good' }]);

    const r1 = await run(agent, [flaky, steady]); // OK
    const r2 = await run(agent, [flaky, steady]); // Oops
    assert.equal(r1.status, 'completed');
    assert.equal(r2.status, 'failed', 'not quarantined yet');
    const r3 = await run(agent, [flaky, steady]); // OK: 2 flips → quarantined after this run
    assert.deepEqual(r3.metadata.quarantine, { quarantined: [flaky], released: [] });
    const list = await call('GET', '/api/v1/quarantine');
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].auto, true);
    assert.match(list.data[0].reason, /flipped between pass and fail 2 times/);

    const r4 = await run(agent, [flaky, steady]); // Oops, but quarantined
    assert.equal(r4.status, 'completed', 'a quarantined failure does not fail the run');
    assert.equal(r4.failedTests, 0);
    assert.equal(r4.metadata.quarantinedFailures, 1);
    const failed = r4.results.find((r: any) => r.testCaseId === flaky);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.metadata.quarantined, true);
    const junit = await fetch(`${apiUrl}/api/v1/runs/${r4.id}/report?format=junit`).then((r) => r.text());
    assert.match(junit, /failures="0" errors="0" skipped="1"/);

    // It becomes stable: released after 2 clean passes
    flakyMode = 'stable';
    await run(agent, [flaky]);
    const r6 = await run(agent, [flaky]);
    assert.deepEqual(r6.metadata.quarantine, { quarantined: [], released: [flaky] });
    assert.equal((await call('GET', '/api/v1/quarantine')).data.length, 0);

    // By hand
    const manual = await call('POST', `/api/v1/testcases/${steady}/quarantine`, { reason: 'Depends on a third-party sandbox' });
    assert.equal(manual.status, 201, manual.text);
    assert.equal(manual.data.auto, false);
    assert.equal((await call('GET', '/api/v1/quarantine')).data[0].reason, 'Depends on a third-party sandbox');
    assert.equal((await call('DELETE', `/api/v1/testcases/${steady}/quarantine`)).status, 204);
    assert.equal((await call('DELETE', `/api/v1/testcases/${steady}/quarantine`)).status, 404);
  });

  it('tests APIs: requests, assertions, captured variables, mocks in UI tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('API', { evidence: { trace: 'off', video: 'off' } });
    const crud = await newTest('Create and read an order', [
      { action: 'POST api/orders', data: { json: { item: 'Lamp', quantity: 3 }, extract: { orderId: '$.id' }, status: 201 } },
      { action: 'assert_json', data: { path: '$.total', equals: 15 } },
      { action: 'assert_header', target: 'content-type', data: { value: 'json' } },
      { action: 'http_request', target: 'api/orders/{{vars.orderId}}' },
      { action: 'Verify the status code is 2xx' },
      { action: 'assert_json', data: { path: '$.item', equals: 'Lamp' } },
      { action: 'assert_json', data: { path: '$.missing', exists: false } },
      { action: 'GET api/orders' },
      { action: 'assert_json', data: { path: '$.length', equals: 2 } },
      { action: 'assert_json', data: { path: '$[0].item', contains: 'Book' } },
    ]);
    const invalid = await newTest('Rejects an order without item', [
      { action: 'http_request', target: 'api/orders', data: { method: 'POST', json: {} } },
      { action: 'assert_status', data: { value: '4xx' } },
      { action: 'assert_json', data: { path: '$.error', matches: 'required' } },
    ]);
    const slow = await newTest('Slow endpoint is too slow', [
      { action: 'GET api/slow' },
      { action: 'assert_response_time', data: { value: 100 } },
    ]);
    const mocked = await newTest('Checkout shows a mocked price, and copes with the API being down', [
      { action: 'mock_route', target: '**/api/price', data: { json: { price: '0.01' }, times: 1 } },
      { action: 'navigate', target: '/checkout' },
      { action: 'assert_text', target: '#price', data: { value: 'Price: 0.01' } },
      { action: 'block_route', target: '**/api/price' },
      { action: 'navigate', target: '/checkout' },
      { action: 'assert_text', target: '#price', data: { value: 'Price unavailable' } },
    ]);
    const r = await run(agent, [crud, invalid, slow, mocked]);
    const by = (id: string) => r.results.find((x: any) => x.testCaseId === id);
    for (const id of [crud, invalid, mocked]) assert.equal(by(id).status, 'passed', `${by(id).metadata.title}: ${by(id).error}`);
    assert.match(by(crud).metadata.steps[0].message, /^POST http:\/\/127\.0\.0\.1:\d+\/api\/orders → 201 in \d+ ms · .*saved \{\{vars\.orderId\}\}/);
    assert.equal(by(slow).status, 'failed');
    assert.match(by(slow).error, /Response took \d+ ms, more than 100 ms/);

    // Tests from the OpenAPI description, without AI
    const gen = await call('POST', `/api/v1/agents/${agent}/generate-api-tests`, { specUrl: '/openapi.json' });
    assert.equal(gen.status, 200, gen.text);
    assert.equal(gen.data.operations, 4);
    assert.equal(gen.data.created, 3);
    assert.deepEqual(gen.data.skipped, [{ operation: 'GET /customers/{customerId}', reason: 'no example value for path parameter "customerId"' }]);
    const post = gen.data.tests.find((x: any) => x.title.startsWith('POST /orders'));
    assert.equal(post.steps[0].target, 'api/orders', 'paths are under the relative server URL /api');
    assert.deepEqual(post.steps[0].data, { method: 'POST', json: { item: 'Pen', quantity: 2 } });
    assert.ok(post.tags.includes(`agent:${agent}`));
    const r2 = await run(agent, gen.data.tests.map((x: any) => x.id));
    for (const res of r2.results) assert.equal(res.status, 'passed', `${res.metadata.title}: ${res.error}`);

    // With AI: negative cases too (fake Copilot CLI)
    const aiAgent = await newAgent('API with AI', { ai: { provider: 'copilot' }, evidence: { trace: 'off', video: 'off' } });
    const withAi = await call('POST', `/api/v1/agents/${aiAgent}/generate-api-tests`, { specUrl: `${fixtureUrl}/openapi.json`, ai: true });
    assert.equal(withAi.status, 200, withAi.text);
    assert.equal(withAi.data.provider, 'copilot');
    assert.equal(withAi.data.tests[0].title, 'Unknown order is 404');
    assert.ok(withAi.data.tests[0].tags.includes('ai-generated'));
    const r3 = await run(aiAgent, [withAi.data.tests[0].id]);
    assert.equal(r3.results[0].status, 'passed', r3.results[0].error);

    // Invalid input
    const bad = await call('POST', `/api/v1/agents/${agent}/generate-api-tests`, { spec: 'not: [an api' });
    assert.equal(bad.status, 400);
    const noPaths = await call('POST', `/api/v1/agents/${agent}/generate-api-tests`, { spec: { hello: 'world' } });
    assert.match(noPaths.data.error, /no "paths"/);
  });

  it('judges plain-language expectations with the AI (assert_ai)', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('AI checks', { ai: { provider: 'copilot' }, evidence: { trace: 'off', video: 'off' } });
    const ok = await newTest('Says everything has a name', [
      { action: 'navigate', target: '/good' },
      { action: 'Verify with AI that the page says everything has a name' },
    ]);
    const same = await newTest('Same check, same page', [
      { action: 'navigate', target: '/good' },
      { action: 'assert_ai', data: { value: 'the page says everything has a name' } },
    ]);
    const cart = await newTest('Shows a cart', [{ action: 'navigate', target: '/good' }, { action: 'assert_ai', data: { value: 'The page shows a shopping cart' } }]);
    const unsure = await newTest('Unsure fails by default', [{ action: 'navigate', target: '/good' }, { action: 'assert_ai', data: { value: 'unsure about this' } }]);
    const tolerant = await newTest('Unsure may pass', [{ action: 'navigate', target: '/good' }, { action: 'assert_ai', data: { value: 'unsure again', on_unsure: 'pass' } }]);

    const before = copilotCalls();
    const r = await run(agent, [ok, same, cart, unsure, tolerant]);
    const by = (id: string) => r.results.find((x: any) => x.testCaseId === id);
    assert.equal(by(ok).status, 'passed', by(ok).error);
    assert.match(by(ok).metadata.steps[1].message, /AI judged "the page says everything has a name": pass, confidence 92%.* — The page says everything has a name/);
    assert.equal(by(ok).metadata.aiChecks[0].provider, 'copilot');
    assert.equal(by(same).status, 'passed', by(same).error);
    // Whichever of the two identical checks ran second reused the verdict
    const cachedFlags = [by(ok), by(same)].map((x: any) => /same content as earlier in this run/.test(x.metadata.steps[1].message));
    assert.deepEqual(cachedFlags.sort(), [false, true]);
    assert.equal(by(cart).status, 'failed');
    assert.match(by(cart).error, /: fail, confidence 85% — No shopping cart is shown/);
    assert.equal(by(unsure).status, 'failed');
    assert.equal(by(tolerant).status, 'passed', by(tolerant).error);
    assert.equal(copilotCalls() - before, 4 + 0, 'one AI call per distinct expectation and page (the repeated check is cached)');
    // Triage knows AI verdicts
    const appBug = r.metadata.triage.groups.find((g: any) => g.category === 'app_bug');
    assert.ok(appBug.tests.some((x: any) => x.testCaseId === cart));
  });

  it('generates test data and runs data-driven tests with fake values', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    // Faker generation: preview, then saved as a data set
    const kinds = await call('GET', '/api/v1/testdata/fake-kinds?locale=it');
    assert.equal(kinds.status, 200, kinds.text);
    assert.ok(kinds.data.some((k: any) => k.kind === 'email' && /@example\./.test(k.example)));
    const preview = await call('POST', '/api/v1/testdata/generate', { fields: { name: 'fullName', email: 'email' }, count: 3, locale: 'it', seed: 5 });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.data.rows.length, 3);
    assert.equal(preview.data.source, 'faker');
    assert.equal((await call('POST', '/api/v1/testdata/generate', { fields: { e: 'nope' } })).status, 400);
    assert.equal((await call('POST', '/api/v1/testdata/generate', {})).status, 400);

    // AI generation: untrusted rows are sanitized before they are saved
    const ai = await call('POST', '/api/v1/testdata/generate', { prompt: 'Signup data with an edge case', count: 5, save: true, name: 'AI signups' });
    assert.equal(ai.status, 201, ai.text);
    assert.equal(ai.data.source, 'ai');
    assert.deepEqual(ai.data.rows, [{ _label: 'valid', email: 'ada@example.com', qty: 2 }, { _label: 'empty email', email: '', qty: 1 }]);
    assert.equal(ai.data.saved.data.generated.source, 'ai');

    // Stored data set given as an array of rows; one row uses a secret and a fake value
    const set = await call('POST', '/api/v1/testdata', { name: 'signups', data: [
      { _label: 'Ada', name: 'Ada', email: 'ada@example.com', qty: 1 },
      { name: '{{fake.firstName}}', email: '{{fake.email}}', qty: '{{secrets.QTY}}' },
    ] });
    assert.equal(set.status, 201, set.text);
    assert.equal((await call('GET', `/api/v1/testdata/${set.data.id}`)).data.rowCount, 2);

    const agent = await newAgent('Test data', { evidence: { trace: 'off', video: 'off' }, secrets: { QTY: '7' }, test_data: { locale: 'it', seed: 99 } });
    const driven = await newTest('Signup works', [
      { action: 'navigate', target: '/signup' },
      { action: 'fill', target: '#name', data: { value: '{{data.name}}' } },
      { action: 'fill', target: '#email', data: { value: '{{data.email}}' } },
      { action: 'fill', target: '#qty', data: { value: '{{data.qty}}' } },
      { action: 'click', target: 'text=Sign up' },
      { action: 'assert_text', target: '#out', data: { value: 'Welcome {{data.name}} <{{data.email}}> x{{data.qty}}' } },
    ], { dataset: 'signups' });
    const faked = await newTest('Signup with fake values', [
      { action: 'navigate', target: '/signup' },
      { action: 'fill', target: '#name', data: { value: '{{fake.fullName:buyer}}' } },
      { action: 'fill', target: '#email', data: { value: '{{fake.email:buyer}}' } },
      { action: 'fill', target: '#qty', data: { value: '{{fake.number}}' } },
      { action: 'click', target: 'text=Sign up' },
      { action: 'assert_text', target: '#out', data: { value: 'Welcome {{fake.fullName:buyer}} <{{fake.email:buyer}}> x{{fake.number}}' } },
    ]);
    const missing = await newTest('Unknown data set', [{ action: 'navigate', target: '/signup' }], { dataset: 'nope' });
    const r = await run(agent, [driven, faked, missing]);

    const rows = r.results.filter((x: any) => x.testCaseId === driven);
    assert.equal(rows.length, 2, 'one execution per row');
    assert.deepEqual(rows.map((x: any) => x.status), ['passed', 'passed'], rows.map((x: any) => x.error).join(' | '));
    assert.deepEqual(rows.map((x: any) => x.metadata.title), ['Signup works [Ada]', 'Signup works [row 2]']);
    assert.deepEqual(rows.map((x: any) => x.metadata.dataRow), [0, 1]);
    // The stored row keeps the placeholders (no secret in the result); fake values are listed
    assert.equal(rows[1].metadata.testData.row.qty, '{{secrets.QTY}}');
    assert.match(rows[1].metadata.testData.fake.email, /@example\./);
    const fakedResult = r.results.find((x: any) => x.testCaseId === faked);
    assert.equal(fakedResult.status, 'passed', fakedResult.error);
    assert.deepEqual(Object.keys(fakedResult.metadata.testData.fake).sort(), ['email:buyer', 'fullName:buyer', 'number']);
    const missed = r.results.find((x: any) => x.testCaseId === missing);
    assert.equal(missed.status, 'error');
    assert.match(missed.error, /Test data set "nope" not found/);
    assert.equal(r.metadata.triage.groups[0].category, 'test_bug');

    // The seed makes values reproducible across runs
    const again = await run(agent, [faked]);
    assert.deepEqual(again.results[0].metadata.testData.fake, fakedResult.metadata.testData.fake);
  });
});

