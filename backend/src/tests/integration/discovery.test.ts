/**
 * App discovery (integration, real PostgreSQL + Chromium): the crawler signs in, maps the screens
 * once per URL pattern (links inside web components included), never requests sign-out or
 * destructive links, names elements (test ids first, accessible roles otherwise), marks screens
 * that tests already visit; proposed elements and tests are saved and the tests pass.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-discovery-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '3000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

const requested: string[] = [];
const page = (title: string, body: string) => `<!doctype html><title>${title} – Shop</title>
  <nav><a href="/">Home</a> <a href="/products">Products</a> <a href="/orders">Orders</a> <a href="/account">Account</a>
  <a href="/logout">Sign out</a> <a href="/admin/delete-all">Delete everything</a> <a href="https://example.com/help">Help</a>
  <a href="/terms.pdf">Terms</a> <a href="mailto:help@shop.test">Mail us</a></nav><main>${body}</main>`;
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  requested.push(url.pathname);
  const send = (html: string, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(html); };
  if (url.pathname === '/login' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    if (new URLSearchParams(raw).get('password') === 'alice-pw') return send('', 302, { Location: '/', 'Set-Cookie': 'sid=alice; Path=/' });
    return send('<p>Wrong</p>');
  }
  if (url.pathname === '/login') return send('<!doctype html><title>Sign in</title><h1>Sign in</h1><form method="post" action="/login"><input type="email" name="email" aria-label="Email"><input type="password" name="password" aria-label="Password"><button>Sign in</button></form>');
  if (!/sid=alice/.test(req.headers.cookie ?? '')) return send('', 302, { Location: '/login' });
  if (url.pathname === '/') return send(page('Home', '<h1>Welcome</h1><p>Hello alice</p>'));
  if (url.pathname === '/products') return send(page('Products', '<h1>Products</h1><input data-testid="product-search" aria-label="Search products"><button data-testid="add-lamp">Add to cart</button>'));
  if (url.pathname === '/orders') return send(page('Orders', '<h1>Your orders</h1><a href="/orders/101">Order 101</a> <a href="/orders/102">Order 102</a>'));
  const order = /^\/orders\/(\d+)$/.exec(url.pathname);
  if (order) return send(page(`Order ${order[1]}`, `<h1>Order ${order[1]}</h1><button>Cancel order</button>`));
  if (url.pathname === '/account') {
    return send(page('Account', `<h1>My account</h1><account-form></account-form>
      <script>customElements.define('account-form', class extends HTMLElement { connectedCallback() {
        this.attachShadow({ mode: 'open' }).innerHTML = '<label>Account Name <input></label><select aria-label="Country"><option>Italy</option></select><a href="/account/settings">Settings</a>';
      } });</script>`));
  }
  if (url.pathname === '/account/settings') return send(page('Settings', '<h1>Settings</h1><label><input type="checkbox"> Newsletter</label>'));
  send(page('Not found', '<h1>Not found</h1>'), 404);
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
  return { status: res.status, data: parsed, text };
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

describe('app discovery (integration)', () => {
  it('maps the app as a signed-in user, safely, and turns the map into elements and passing tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = (await call('POST', '/agents', {
      name: 'Shop', config: {
        base_url: base, evidence: { trace: 'off', video: 'off' },
        auth: { default_profile: 'alice', profiles: [{ name: 'alice', login_url: '/login', username: 'alice@example.com', password: 'alice-pw', landing_path: '/' }] },
      },
    })).data;
    // An existing test already visits the products screen
    await call('POST', '/testcases', { title: 'Products list', module: 'Products', priority: 'High', expectedResults: ['x'], steps: [{ action: 'navigate', target: '/products' }, { action: 'assert_visible', target: 'h1' }] });

    const started = await call('POST', `/agents/${agent.id}/discover`, { maxPages: 20, maxDepth: 3 });
    assert.equal(started.status, 202, started.text);
    assert.equal((await call('POST', `/agents/${agent.id}/discover`, {})).status, 409, 'one at a time');
    let d: any;
    for (let i = 0; i < 240; i++) {
      d = (await call('GET', `/discoveries/${started.data.id}`)).data;
      if (d.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(d.status, 'completed', d.error);
    assert.equal(d.signedInAs, 'alice');
    assert.deepEqual(d.pages.map((p: any) => p.pattern).sort(), ['/', '/account', '/account/settings', '/orders', '/orders/:id', '/products']);
    // Safety: never asked for sign-out or destructive pages, other sites, files
    assert.ok(!requested.includes('/logout') && !requested.includes('/admin/delete-all') && !requested.includes('/terms.pdf'), requested.join(' '));
    assert.equal(requested.filter((p) => /^\/orders\/\d+$/.test(p)).length, 1, 'one record of a kind');
    for (const why of ['sign-out or destructive', 'another site', 'a file', 'not a page']) assert.ok(d.skipped[why] > 0, why);

    const screen = (pattern: string) => d.pages.find((p: any) => p.pattern === pattern);
    assert.equal(screen('/products').name, 'Products');
    assert.equal(screen('/products').covered, true);
    assert.equal(screen('/orders').covered, false);
    const els = (pattern: string) => Object.fromEntries(screen(pattern).elements.map((e: any) => [e.name, e.locator]));
    assert.equal(els('/products')['Products.SearchProductsField'], '[data-testid="product-search"]', 'test ids first');
    assert.equal(els('/products')['Products.AddToCartButton'], '[data-testid="add-lamp"]');
    assert.equal(els('/account')['MyAccount.AccountNameField'], 'role=textbox[name="Account Name"]', 'found inside the web component');
    assert.equal(els('/account')['MyAccount.CountrySelect'], 'role=combobox[name="Country"]');
    assert.equal(els('/account')['MyAccount.MyAccountTitle'], 'role=heading[name="My account"]');

    // Proposed smoke tests: for screens no test visits
    const titles = d.proposals.map((p: any) => p.title);
    assert.ok(!titles.some((x: string) => x.startsWith('Products ')), 'products is covered already');
    assert.ok(titles.includes('My account screen shows its main parts'));
    assert.ok(titles.includes('Order 101 screen shows its main parts (example record)'));
    assert.deepEqual(d.proposals.find((p: any) => p.title.startsWith('My account')).data, { login_as: 'alice' });

    // Elements into the library, then the proposed tests (their elements are added as needed): they pass
    const saved = await call('POST', `/discoveries/${d.id}/elements`, { names: ['Products.AddToCartButton'] });
    assert.deepEqual(saved.data, { created: ['Products.AddToCartButton'], skipped: [] });
    const created = await call('POST', `/discoveries/${d.id}/tests`, {});
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.tests.length, d.proposals.length);
    assert.ok(created.data.elements.includes('MyAccount.AccountNameField'));
    const lib = (await call('GET', '/elements')).data;
    assert.equal(lib.find((e: any) => e.name === 'Products.AddToCartButton').source, 'discovery');
    const run = await call('POST', '/runs', { agentId: agent.id, testIds: created.data.tests.map((x: any) => x.id), wait: true });
    const full = (await call('GET', `/runs/${run.data.id}`)).data;
    assert.equal(full.status, 'completed', JSON.stringify(full.results.filter((r: any) => r.status !== 'passed').map((r: any) => [r.metadata.title, r.error])));
    assert.equal(full.passedTests, created.data.tests.length);
  });
});
