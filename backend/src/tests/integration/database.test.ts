/**
 * Database steps (integration, real PostgreSQL + Chromium): a test prepares data, uses the UI,
 * checks what the application wrote, keeps a value for later steps; read-only databases refuse
 * changes; passwords are encrypted, never returned and never in messages.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const SHOP_DB = 'aitestagentbuilder_shopdb';
const SHOP_URL = DB_URL.replace(/\/[^/?]+(\?|$)/, `/${SHOP_DB}$1`);
const workDir = mkdtempSync(join(tmpdir(), 'atab-db-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '3000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

let shop: any;
let app: Server;
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
  return { status: res.status, data: parsed, text };
}

before(async () => {
  const pg = (await import('pg')).default;
  const probe = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
    await probe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    if (!(await probe.query('SELECT 1 FROM pg_database WHERE datname = $1', [SHOP_DB])).rowCount) await probe.query(`CREATE DATABASE ${SHOP_DB}`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!dbAvailable) return;
  // The application's own database and a small order form writing to it
  shop = new pg.Pool({ connectionString: SHOP_URL, max: 2 });
  await shop.query('DROP TABLE IF EXISTS orders; CREATE TABLE orders (id SERIAL PRIMARY KEY, email TEXT NOT NULL, total NUMERIC(10,2) NOT NULL, status TEXT NOT NULL)');
  app = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (html: string) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>Shop</title>${html}`); };
    if (url.pathname === '/order' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const email = new URLSearchParams(raw).get('email') ?? '';
      const r = await shop.query("INSERT INTO orders (email, total, status) VALUES ($1, 42.00, 'new') RETURNING id", [email]);
      return send(`<h1>Order ${r.rows[0].id} placed</h1>`);
    }
    const m = /^\/orders\/(\d+)$/.exec(url.pathname);
    if (m) {
      const r = await shop.query('SELECT * FROM orders WHERE id = $1', [m[1]]);
      return send(r.rows[0] ? `<h1>Order ${r.rows[0].id}</h1><p id="status">${r.rows[0].status}</p>` : '<h1>Not found</h1>');
    }
    send('<form method="post" action="/order"><label>Email <input name="email"></label><button>Order</button></form>');
  });
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
    await shop.end();
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('database steps (integration)', () => {
  it('prepares data, checks what the UI wrote, keeps values; read-only databases refuse changes', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const u = new URL(SHOP_URL);
    assert.match((await call('POST', '/agents', { name: 'Bad', config: { base_url: base, databases: [{ name: 'shop', type: 'db2', host: 'x' }, { name: 'shop', type: 'mysql' }] } })).data.error,
      /databases\[0\]\.type must be one of postgres, mysql, sqlserver, oracle; config\.databases\[1\]\.name "shop" is used twice; config\.databases\[1\] needs host/);
    const created = await call('POST', '/agents', {
      name: 'Shop', config: {
        base_url: base, evidence: { trace: 'off', video: 'off' },
        databases: [
          { name: 'shop', type: 'postgres', url: SHOP_URL, read_only: false },
          { name: 'reporting', type: 'postgres', host: u.hostname, port: Number(u.port || 5432), database: SHOP_DB, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
          { name: 'broken', type: 'postgres', host: u.hostname, port: Number(u.port || 5432), database: SHOP_DB, user: decodeURIComponent(u.username), password: 'wrong-Pa55word' },
        ],
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.config.databases[0].url, '••••••••');
    assert.equal(created.data.config.databases[1].password, '••••••••');
    const { default: getDatabaseClient } = await import('../../infra/db/client.js');
    const stored = JSON.stringify((await getDatabaseClient().query('SELECT config FROM agents WHERE id = $1', [created.data.id])).rows[0].config);
    assert.ok(!stored.includes(SHOP_URL) && !stored.includes('wrong-Pa55word'), 'secrets are encrypted at rest');
    const agent = created.data.id;

    const tc = async (title: string, steps: any[]) => (await call('POST', '/testcases', { title, module: 'Orders', priority: 'High', expectedResults: ['ok'], steps })).data.id;
    const ids = [
      await tc('An order is stored', [
        { action: 'db_execute', target: 'shop', data: { sql: 'DELETE FROM orders WHERE email = ?', params: ['{{fake.email:buyer}}'] } },
        { action: 'navigate', target: '/' },
        { action: 'fill', target: 'Email', data: { value: '{{fake.email:buyer}}' } },
        { action: 'click', target: 'Order' },
        { action: 'assert_text', target: 'h1', data: { value: 'placed' } },
        { action: 'Check database', target: 'reporting', data: { sql: "SELECT status, total FROM orders WHERE email = ? AND status <> '?'", params: ['{{fake.email:buyer}}'], rows: 1, equals: { status: 'new', TOTAL: '42.00' } } },
        { action: 'db_query', target: 'reporting', data: { sql: 'SELECT id FROM orders WHERE email = ?', params: ['{{fake.email:buyer}}'], save_as: 'orderId' } },
        { action: 'navigate', target: '/orders/{{vars.orderId}}' },
        { action: 'assert_text', target: '#status', data: { value: 'new' } },
      ]),
      await tc('Wrong expectation', [{ action: 'assert_db', target: 'reporting', data: { sql: "SELECT count(*) AS n FROM orders WHERE email = 'nobody@example.com'", equals: { n: 1 } } }]),
      await tc('Read-only refuses changes', [{ action: 'db_execute', target: 'reporting', data: { sql: 'DELETE FROM orders' } }]),
      await tc('Only queries on a read-only database', [{ action: 'db_query', target: 'reporting', data: { sql: 'SELECT 1; DELETE FROM orders' } }]),
      await tc('No database named', [{ action: 'db_query', data: { sql: 'SELECT 1' } }]),
      await tc('Wrong password', [{ action: 'db_query', target: 'broken', data: { sql: 'SELECT 1' } }]),
    ];
    const r = await call('POST', '/runs', { agentId: agent, testIds: ids, wait: true });
    const run = (await call('GET', `/runs/${r.data.id}`)).data;
    const res = (title: string) => run.results.find((x: any) => x.metadata.title === title);
    assert.equal(res('An order is stored').status, 'passed', res('An order is stored').error);
    assert.match(res('An order is stored').metadata.steps[5].message, /reporting: 1 row\(s\) as expected\. First row: \{"status":"new","total":"42\.00"\}/);
    assert.match(res('Wrong expectation').error, /Database reporting: n is "0", expected "1"/);
    assert.match(res('Read-only refuses changes').error, /Database "reporting" is read-only: set read_only: false/);
    assert.match(res('Only queries on a read-only database').error, /Only one SELECT-like statement can run here/);
    assert.match(res('No database named').error, /Say which database \(target\): shop, reporting, broken/);
    assert.match(res('Wrong password').error, /password authentication failed/);
    assert.ok(!JSON.stringify(run).includes('wrong-Pa55word'), 'the password is never shown');
    assert.equal((await shop.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1, 'nothing was deleted through the read-only database');
  });
});
