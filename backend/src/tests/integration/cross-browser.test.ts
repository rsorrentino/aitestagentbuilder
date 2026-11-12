/**
 * Cross-browser runs (integration, real PostgreSQL + Playwright): every test once per browser /
 * emulated device, results kept apart per browser, a browser that cannot start fails only its
 * tests, and a grid (here a real Playwright server, as BrowserStack / LambdaTest / Sauce Labs
 * would be) runs the browsers remotely. Grid access keys are encrypted and redacted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrowserServer } from 'playwright';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-xbrowser-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '2500',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO', 'PLAYWRIGHT_BROWSER']) delete process.env[k];

let app: Server;
let api: Server;
let grid: BrowserServer | null = null;
let base = '';
let apiUrl = '';
let dbAvailable = false;
let firefoxInstalled = false;
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
const byTitle = (r: any) => Object.fromEntries(r.results.map((x: any) => [x.metadata.title, [x.status, x.metadata.browser]]));

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
  const { firefox } = await import('playwright');
  firefoxInstalled = await import('fs').then((fs) => fs.existsSync(firefox.executablePath()));
  // The page says whether it is shown on a phone-sized screen
  app = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Shop</title><h1>Shop</h1><p id="screen"></p><p id="ua"></p>
      <script>document.getElementById('screen').textContent = innerWidth < 600 ? 'phone' : 'desktop';
      document.getElementById('ua').textContent = /Android/.test(navigator.userAgent) ? 'android' : 'other';</script>`);
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
    await grid?.close().catch(() => undefined);
    for (const s of [api, app]) s.closeAllConnections();
    for (const s of [api, app]) await new Promise((r) => s.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('cross-browser runs (integration)', () => {
  let testIds: string[] = [];

  it('runs every test per browser and emulated device; a missing browser fails only its tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const steps = (sel: string, value: string) => [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: sel, data: { value } }];
    testIds = [
      (await call('POST', '/testcases', { title: 'Desktop layout', module: 'Layout', priority: 'High', expectedResults: ['desktop'], steps: steps('#screen', 'desktop') })).data.id,
      (await call('POST', '/testcases', { title: 'Shop opens', module: 'Layout', priority: 'High', expectedResults: ['Shop'], steps: steps('h1', 'Shop') })).data.id,
    ];

    const bad = await call('POST', '/agents', { name: 'Bad', config: { base_url: base, browsers: ['chromium', 'netscape'] } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /config\.browsers: unknown "netscape"/);
    const sauce = await call('POST', '/agents', { name: 'Sauce', config: { base_url: base, browsers: ['firefox'], grid: { provider: 'saucelabs', username: 'u', access_key: 'k' } } });
    assert.match(sauce.data.error, /Sauce Labs runs Playwright through its Selenium Grid, which supports Chrome \/ Chromium only/);

    const agent = (await call('POST', '/agents', {
      name: 'Shop everywhere',
      config: { base_url: base, browsers: ['chromium', 'Pixel 7', 'firefox'], evidence: { trace: 'off', video: 'off' } },
    })).data;
    const r = await run(agent.id);
    assert.equal(r.results.length, 6, 'two tests × three targets');
    const results = byTitle(r);
    assert.deepEqual(results['Desktop layout [chromium]'], ['passed', 'chromium']);
    assert.deepEqual(results['Shop opens [chromium]'], ['passed', 'chromium']);
    // The emulated phone: a small screen and an Android user agent
    assert.deepEqual(results['Desktop layout [Pixel 7]'], ['failed', 'Pixel 7']);
    assert.match(r.results.find((x: any) => x.metadata.title === 'Desktop layout [Pixel 7]').error, /Expected #screen to contain "desktop" but found "phone"/);
    assert.deepEqual(results['Shop opens [Pixel 7]'], ['passed', 'Pixel 7']);
    if (!firefoxInstalled) {
      // Firefox is not installed on this server: its tests fail with how to fix it, the others ran
      assert.deepEqual(results['Shop opens [firefox]'], ['error', 'firefox']);
      assert.match(r.results.find((x: any) => x.metadata.title === 'Shop opens [firefox]').error, /Could not start firefox on this server\. Install it with: cd backend && npx playwright install firefox — or run on a cloud grid/);
    } else {
      assert.deepEqual(results['Shop opens [firefox]'], ['passed', 'firefox']);
    }
    assert.equal(r.status, 'failed');
    // Results per browser are counted apart (not the last attempt of the test across browsers)
    assert.equal(r.passedTests, firefoxInstalled ? 4 : 3);
    assert.equal(r.failedTests, firefoxInstalled ? 1 : 3);
    // The failure triage tells the browser
    const phone = r.metadata.triage.groups.find((g: any) => /found "phone"/.test(g.sample.error));
    assert.deepEqual(phone.tests.map((x: any) => x.browser), ['Pixel 7']);
  });

  it('runs on a grid (a Playwright server); the access key is encrypted and never returned', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const { chromium } = await import('playwright');
    grid = await chromium.launchServer({ headless: true });
    const agent = await call('POST', '/agents', {
      name: 'On the grid',
      config: { base_url: base, browsers: ['chromium', 'Pixel 7'], grid: { provider: 'playwright', ws_endpoint: grid.wsEndpoint(), access_key: 'grid-key-123' }, evidence: { trace: 'off', video: 'off' }, test_selection: { testIds: [testIds[1]] } },
    });
    assert.equal(agent.status, 201, agent.text);
    assert.equal(agent.data.config.grid.access_key, '••••••••');
    const { default: getDatabaseClient } = await import('../../infra/db/client.js');
    const stored = (await getDatabaseClient().query('SELECT config FROM agents WHERE id = $1', [agent.data.id])).rows[0].config;
    assert.notEqual(stored.grid.access_key, 'grid-key-123');
    assert.ok(!JSON.stringify(stored).includes('grid-key-123'));

    // Saving the agent with the redacted key keeps it; changing the provider drops it
    await call('PUT', `/agents/${agent.data.id}`, { config: { ...agent.data.config, browsers: ['Pixel 7', 'chromium'] } });
    const kept = (await getDatabaseClient().query('SELECT config FROM agents WHERE id = $1', [agent.data.id])).rows[0].config;
    assert.equal(kept.grid.access_key, stored.grid.access_key);

    const r = await run(agent.data.id);
    assert.equal(r.status, 'completed', JSON.stringify(r.results.map((x: any) => x.error)));
    assert.deepEqual(r.results.map((x: any) => x.metadata.title).sort(), ['Shop opens [Pixel 7]', 'Shop opens [chromium]']);

    // The grid is really used: once it is gone, the browsers cannot start
    await grid.close();
    grid = null;
    const down = await run(agent.data.id);
    assert.equal(down.status, 'failed');
    assert.ok(down.results.every((x: any) => x.status === 'error' && /Could not start (chromium|Pixel 7) on playwright/.test(x.error)), JSON.stringify(down.results.map((x: any) => x.error)));

    const changed = await call('PUT', `/agents/${agent.data.id}`, { config: { ...agent.data.config, grid: { provider: 'browserstack', username: 'qa' } } });
    assert.equal(changed.status, 200, changed.text);
    const moved = (await getDatabaseClient().query('SELECT config FROM agents WHERE id = $1', [agent.data.id])).rows[0].config;
    assert.equal(moved.grid.access_key, undefined, 'another provider does not inherit the key');
  });
});
