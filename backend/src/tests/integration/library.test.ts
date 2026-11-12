/**
 * Library (integration, real PostgreSQL + Chromium): reusable step blocks with parameters
 * (nested), named elements with React-style (data-testid, ARIA role) and Salesforce-style
 * (inside a web component's shadow root) locators, element alternatives when the UI changes,
 * the repair saved once in the element for every test, renames followed by the tests,
 * deletions of used items refused.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-library-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '2500',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

// The application: React-style markup; a release renames the total's data-testid
let renamedTotal = false;
const page = (body: string) => `<!doctype html><title>Shop</title>${body}`;
const app = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const user = /user=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
  const send = (html: string, headers: Record<string, string> = {}) => { res.writeHead(200, { 'Content-Type': 'text/html', ...headers }); res.end(page(html)); };
  if (url.pathname === '/login') {
    return send(`<form onsubmit="event.preventDefault(); document.cookie='user=' + this.email.value; location.href='/home'">
      <input data-testid="email" name="email" aria-label="Email"><input type="password" data-testid="password" aria-label="Password">
      <button type="submit">Sign in</button></form>`);
  }
  if (url.pathname === '/home') return send(`<h1>Welcome ${user ?? 'nobody'}</h1>`);
  if (url.pathname === '/cart') return send(`<h2>Cart of ${user}</h2><p id="total" data-testid="${renamedTotal ? 'order-total' : 'total'}">42.00</p>`);
  if (url.pathname === '/account') {
    // A Lightning-style web component: the input lives in an open shadow root
    return send(`<record-field label="Account Name"></record-field><p id="saved"></p>
      <script>customElements.define('record-field', class extends HTMLElement { connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<label>' + this.getAttribute('label') + '<input></label>';
        root.querySelector('input').addEventListener('input', (e) => { document.getElementById('saved').textContent = e.target.value; });
      } });</script>`);
  }
  send('<h1>Shop</h1>');
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
const run = async (agentId: string) => {
  const r = await call('POST', '/runs', { agentId, wait: true, timeoutSeconds: 120 });
  assert.ok([200, 202].includes(r.status), r.text);
  return (await call('GET', `/runs/${r.data.id}`)).data;
};
const result = (r: any, title: string) => r.results.find((x: any) => x.metadata.title === title);

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

describe('library: blocks and elements (integration)', () => {
  it('runs tests built from blocks and elements, survives a UI change, follows renames', async (t) => {
    if (!dbAvailable) return t.skip('database not available');

    // Elements: React-style (data-testid, ARIA role) and one inside a shadow root (Lightning-style)
    assert.match((await call('POST', '/elements', { name: 'login email', locator: 'x' })).data.error, /letters, digits and underscores, with dots for groups/);
    const els: Record<string, any> = {};
    for (const [name, locator, alternatives] of [
      ['Login.Email', '[data-testid="email"]', []],
      ['Login.Password', 'role=textbox[name="Password"]', []],
      ['Login.Submit', 'role=button[name="Sign in"]', []],
      ['Cart.Total', '[data-testid="total"]', ['#total']],
      ['Account.Name', 'role=textbox[name="Account Name"]', []],
    ] as const) {
      const r = await call('POST', '/elements', { name, locator, alternatives });
      assert.equal(r.status, 201, r.text);
      els[name] = r.data;
    }
    assert.equal((await call('POST', '/elements', { name: 'cart.total', locator: '#x' })).status, 409, 'names are unique, any case');

    // Blocks: sign in with parameters; open the cart uses sign in
    const bad = await call('POST', '/blocks', { name: 'Bad', params: [], steps: [{ action: 'navigate', target: '/{{param.page}}' }] });
    assert.match(bad.data.error, /steps use \{\{param\.page\}\} but params does not declare it/);
    const signIn = await call('POST', '/blocks', {
      name: 'Sign in', description: 'Sign in through the form',
      params: [{ name: 'user' }, { name: 'password', default: 'pw' }],
      steps: [
        { action: 'navigate', target: '/login' },
        { action: 'fill', target: '{{el.Login.Email}}', data: { value: '{{param.user}}' } },
        { action: 'fill', target: '{{el.Login.Password}}', data: { value: '{{param.password}}' } },
        { action: 'click', target: '{{el.Login.Submit}}' },
        { action: 'assert_text', target: 'h1', data: { value: 'Welcome {{param.user}}' } },
      ],
    });
    assert.equal(signIn.status, 201, signIn.text);
    assert.deepEqual(signIn.data.steps.map((s: any) => s.stepId), [1, 2, 3, 4, 5]);
    const openCart = (await call('POST', '/blocks', {
      name: 'Open the cart', params: [{ name: 'user' }],
      steps: [{ action: 'use_block', target: 'Sign in', data: { params: { user: '{{param.user}}' } } }, { action: 'navigate', target: '/cart' }],
    })).data;

    const tc = async (title: string, steps: any[]) => (await call('POST', '/testcases', { title, module: 'Shop', priority: 'High', tags: ['lib'], expectedResults: ['ok'], steps })).data.id;
    const cartId = await tc('Cart total', [{ action: 'use_block', target: 'Open the cart', data: { params: { user: 'alice' } } }, { action: 'assert_text', target: '{{el.Cart.Total}}', data: { value: '42.00' } }]);
    await tc('Bob signs in', [{ action: 'use_block', target: 'sign in', data: { params: { user: 'bob' } } }]);
    await tc('Account name in a web component', [{ action: 'navigate', target: '/account' }, { action: 'fill', target: '{{el.Account.Name}}', data: { value: 'Acme' } }, { action: 'assert_text', target: '#saved', data: { value: 'Acme' } }]);
    await tc('Unknown block', [{ action: 'use_block', target: 'Checkout' }]);
    await tc('Missing parameter', [{ action: 'use_block', target: 'Sign in' }]);
    await tc('Unknown element', [{ action: 'navigate', target: '/' }, { action: 'click', target: '{{el.Nope.Button}}' }]);

    const agent = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, test_selection: { tags: ['lib'] }, evidence: { trace: 'off', video: 'off' }, ai: { auto_apply_healing: true } } })).data;
    const r1 = await run(agent.id);
    const cart = result(r1, 'Cart total');
    assert.equal(cart.status, 'passed', cart.error);
    // Step logs say which block each step came from
    assert.deepEqual(cart.metadata.steps.map((s: any) => [s.path ?? String(s.stepId), s.block ?? null, s.action]), [
      ['1.1.1', 'Sign in', 'navigate'], ['1.1.2', 'Sign in', 'fill'], ['1.1.3', 'Sign in', 'fill'], ['1.1.4', 'Sign in', 'click'], ['1.1.5', 'Sign in', 'assert_text'],
      ['1.2', 'Open the cart', 'navigate'], ['2', null, 'assert_text'],
    ]);
    assert.equal(result(r1, 'Bob signs in').status, 'passed', 'block names match in any case');
    assert.equal(result(r1, 'Account name in a web component').status, 'passed', result(r1, 'Account name in a web component').error);
    assert.match(result(r1, 'Unknown block').error, /Step 1: unknown block "Checkout" \(Library → Blocks\)/);
    assert.match(result(r1, 'Missing parameter').error, /Step 1: block "Sign in" needs the parameter "user"/);
    assert.match(result(r1, 'Unknown element').error, /Unknown element \{\{el\.Nope\.Button\}\} \(Library → Elements\)/);

    // A release renames the data-testid: the element's alternative locator keeps the test green, and the element takes it
    renamedTotal = true;
    const r2 = await run(agent.id);
    const healed = result(r2, 'Cart total');
    assert.equal(healed.status, 'passed', healed.error);
    assert.match(healed.metadata.steps[6].message, /element Cart\.Total: alternative locator "#total"/);
    const element = (await call('GET', `/elements/${els['Cart.Total'].id}`)).data;
    assert.equal(element.locator, '#total');
    assert.equal(element.source, 'healed');
    assert.ok(element.alternatives.includes('[data-testid="total"]'));
    assert.deepEqual(element.usage.tests.map((x: any) => x.title), ['Cart total']);
    // The test itself still says {{el.Cart.Total}}: fixed once, for every test
    assert.equal((await call('GET', `/testcases/${cartId}`)).data.steps[1].target, '{{el.Cart.Total}}');

    // Renames follow into the tests and blocks
    await call('PUT', `/elements/${els['Login.Submit'].id}`, { name: 'Login.SignInButton' });
    assert.equal((await call('GET', `/blocks/${signIn.data.id}`)).data.steps[3].target, '{{el.Login.SignInButton}}');
    await call('PUT', `/blocks/${signIn.data.id}`, { name: 'Log in' });
    assert.equal((await call('GET', `/blocks/${openCart.id}`)).data.steps[0].target, 'Log in');
    const used = (await call('GET', `/blocks/${signIn.data.id}`)).data.usage;
    assert.deepEqual([used.tests.map((x: any) => x.title), used.blocks.map((x: any) => x.name)], [['Bob signs in', 'Missing parameter'], ['Open the cart']]);
    assert.equal(result(await run(agent.id), 'Cart total').status, 'passed', 'still runs after the renames');

    // Used items are not deleted by accident
    const refused = await call('DELETE', `/blocks/${signIn.data.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /"Log in" is used by 2 test\(s\) and 1 block\(s\)/);
    assert.equal((await call('DELETE', `/elements/${els['Cart.Total'].id}`)).status, 409);
    assert.equal((await call('DELETE', `/blocks/${signIn.data.id}?force=true`)).status, 204);

    // A block that uses itself is caught
    const loop = (await call('POST', '/blocks', { name: 'Loop', steps: [{ action: 'use_block', target: 'Loop' }] })).data;
    await tc('Loops', [{ action: 'use_block', target: 'Loop' }]);
    const r4 = await run(agent.id);
    assert.match(result(r4, 'Loops').error, /Block "Loop" uses itself \(loop → loop\)/);
    assert.ok(loop.id);
  });
});
