/**
 * Mock APIs (integration, real PostgreSQL + Chromium): a payment service mocked from its OpenAPI
 * description answers the application's backend; a test makes the next payment fail and checks
 * what the application sent; fixed routes, unknown paths, the request log; CI templates.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-mocks-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '4000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

const SPEC = {
  openapi: '3.0.3', info: { title: 'Payments', version: '1' }, servers: [{ url: '/v1' }],
  paths: {
    '/payments': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 201: { description: 'ok', content: { 'application/json': { example: { id: 'pay_1', status: 'approved' } } } } } } },
    '/payments/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id', 'amount'], properties: { id: { type: 'string', example: 'pay_9' }, amount: { type: 'number', example: 42 } } } } } } } } },
  },
};

// The application: its backend charges the card through the payment service (here: the mock)
let paymentsUrl = '';
const app = http.createServer(async (req, res) => {
  const send = (html: string) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>Checkout</title>${html}`); };
  if (req.method === 'POST' && req.url === '/pay') {
    let raw = '';
    for await (const c of req) raw += c;
    const card = new URLSearchParams(raw).get('card');
    const r = await fetch(`${paymentsUrl}/v1/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card, amount: 42 }) });
    const body: any = await r.json().catch(() => ({}));
    return send(r.ok ? `<h1>Payment ${body.status}</h1>` : `<h1>Payment declined: ${body.error}</h1>`);
  }
  send('<form method="post" action="/pay"><label>Card <input name="card"></label><button>Pay</button></form>');
});

let api: Server;
let base = '';
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, data?: any) {
  const res = await fetch(`${apiUrl}/api/v1${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text, headers: res.headers };
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
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
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
    for (const s of [api, app]) s.closeAllConnections();
    for (const s of [api, app]) await new Promise((r) => s.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('mock APIs (integration)', () => {
  it('stands in for a payment service: spec answers, fixed routes, per-test answers, recorded calls', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.match((await call('POST', '/mock-services', { name: 'Empty' })).data.error, /Give an OpenAPI description \(spec or specUrl\) or at least one route/);
    assert.match((await call('POST', '/mock-services', { name: 'X', routes: [{ method: 'FETCH', path: 'x', status: 9 }] })).data.error, /method must be GET[\s\S]*path must start with \/[\s\S]*status must be an HTTP status/);
    const created = await call('POST', '/mock-services', { name: 'Payments', spec: JSON.stringify(SPEC), routes: [{ method: 'get', path: '/health', status: 200, body: { ok: true }, delay_ms: 50 }] });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(created.data.operations, ['POST /payments', 'GET /payments/{id}']);
    assert.match(created.data.path, /^\/api\/v1\/mocks\/payments-[0-9a-f]{12}$/);
    const mockBase = `${apiUrl}${created.data.path}`;
    paymentsUrl = mockBase;

    // The mock itself (no login)
    const get = await fetch(`${mockBase}/v1/payments/abc`);
    assert.deepEqual([get.status, get.headers.get('x-mock-source'), await get.json()], [200, 'spec', { id: 'pay_9', amount: 42 }]);
    const health = await fetch(`${mockBase}/health`);
    assert.deepEqual([health.status, health.headers.get('x-mock-source'), await health.json()], [200, 'route', { ok: true }]);
    const none = await fetch(`${mockBase}/refunds`, { method: 'POST' });
    assert.deepEqual([none.status, (await none.json()).error], [404, 'No mocked answer for POST /refunds']);
    assert.equal((await fetch(`${apiUrl}/api/v1/mocks/nope-000000000000/x`)).status, 404);

    // Tests: a declined payment set by the test, and the normal one from the spec
    const steps = (extra: any[]) => [...extra, { action: 'navigate', target: '/' }, { action: 'fill', target: 'Card', data: { value: '4242 4242' } }, { action: 'click', target: 'Pay' }];
    const tc = async (title: string, s: any[]) => (await call('POST', '/testcases', { title, module: 'Checkout', priority: 'High', expectedResults: ['x'], steps: s })).data.id;
    const ids = [
      await tc('Declined card', [
        ...steps([{ action: 'mock_service_respond', target: 'Payments', data: { method: 'POST', path: '/v1/payments', status: 402, body: { error: 'card declined' } } }]),
        { action: 'assert_text', target: 'h1', data: { value: 'Payment declined: card declined' } },
        { action: 'assert_mock_service_called', target: 'payments', data: { method: 'POST', path: '/v1/payments', body_contains: '4242 4242', times: 1 } },
      ]),
      await tc('Approved card', [...steps([]), { action: 'assert_text', target: 'h1', data: { value: 'Payment approved' } }]),
      await tc('Expects a refund', [{ action: 'assert_mock_service_called', target: 'Payments', data: { method: 'POST', path: '/v1/refunds' } }]),
      await tc('Unknown mock', [{ action: 'mock_service_respond', target: 'Shipping', data: { path: '/x' } }]),
    ];
    const agent = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, evidence: { trace: 'off', video: 'off' } } })).data;
    const r = await call('POST', '/runs', { agentId: agent.id, testIds: ids, wait: true });
    const run = (await call('GET', `/runs/${r.data.id}`)).data;
    const res = (title: string) => run.results.find((x: any) => x.metadata.title === title);
    assert.equal(res('Declined card').status, 'passed', res('Declined card').error);
    assert.equal(res('Approved card').status, 'passed', res('Approved card').error);
    assert.match(res('Expects a refund').error, /Payments: expected a call POST \/v1\/refunds during this test, got 0/);
    assert.match(res('Unknown mock').error, /Unknown mock service "Shipping"/);

    const log = (await call('GET', `/mock-services/${created.data.id}/requests`)).data;
    const payments = log.filter((c: any) => c.path === '/v1/payments');
    assert.deepEqual(payments.map((c: any) => [c.method, c.status, c.source]).sort(), [['POST', 201, 'spec'], ['POST', 402, 'test']]);
    assert.deepEqual(payments.find((c: any) => c.status === 402).body, { card: '4242 4242', amount: 42 });
    assert.ok(new Date(log[0].at) >= new Date(log[log.length - 1].at), 'newest first');

    // CI templates for the agent
    const jf = await call('GET', `/agents/${agent.id}/ci-template?kind=jenkins&apiUrl=https://atab.example.com/api/v1`);
    assert.equal(jf.data.path, 'Jenkinsfile');
    assert.match(jf.data.text, new RegExp(`ATAB_AGENT = '${agent.id}'`));
    assert.match(jf.data.text, /credentialsId: 'atab-api-key'/);
    assert.match(jf.data.text, /junit allowEmptyResults: true, testResults: 'ai-tests-junit\.xml'/);
    assert.equal((await call('GET', `/agents/${agent.id}/ci-template?kind=github`)).data.path, '.github/workflows/ai-tests.yml');
    assert.equal((await call('GET', `/agents/${agent.id}/ci-template?kind=circleci`)).status, 400);
  });
});
