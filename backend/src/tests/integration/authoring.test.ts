/**
 * Plain-English steps (integration, real PostgreSQL + Chromium, a fake Copilot CLI): sentences
 * become steps by rules (library blocks and elements used), the rest by the AI with the live
 * page's outline; the steps are saved in a test and replayed without the AI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-authoring-'));

// Fake Copilot CLI: answers the plain-English prompt, using a selector it can only know from the page outline
const isWindows = process.platform === 'win32';
const fakeScript = isWindows ? join(workDir, 'node_modules', 'fake-copilot', 'index.js') : join(workDir, 'copilot');
const fakeCli = isWindows ? join(workDir, 'copilot.cmd') : fakeScript;
mkdirSync(dirname(fakeScript), { recursive: true });
writeFileSync(fakeScript, `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
if (!prompt.includes('You turn test steps written in plain English')) { console.log('[]'); process.exit(0); }
const sawOutline = prompt.includes('Page outline') && prompt.includes('[data-testid="cart-link"]');
console.log(JSON.stringify([
  { line: 1, steps: sawOutline ? [{ action: 'click', target: '[data-testid="cart-link"]' }] : [] },
  { line: 2, steps: [{ action: 'fly', target: 'moon' }] },
]));
`);
chmodSync(fakeScript, 0o755);
if (isWindows) writeFileSync(fakeCli, '@ECHO off\r\nSETLOCAL\r\nendLocal & "node" "%dp0%\\node_modules\\fake-copilot\\index.js" %*\r\n');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '2500', COPILOT_MODE: 'cli', COPILOT_CLI_PATH: fakeCli,
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

const page = (body: string) => `<!doctype html><title>Shop</title>${body}`;
const app = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (url.pathname === '/cart') return res.end(page('<h1>Your cart</h1><p data-testid="total">42.00</p><label>Coupon <input name="coupon"></label><button onclick="document.querySelector(\'h1\').textContent=\'Saved \' + document.querySelector(\'input\').value">Apply</button>'));
  res.end(page('<h1>Shop</h1><a data-testid="cart-link" href="/cart">🛒</a>'));
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

describe('plain-English steps (integration)', () => {
  it('turns sentences into steps (rules, library, AI with the live page) that replay without the AI', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    await call('POST', '/elements', { name: 'Cart.Total', locator: '[data-testid="total"]' });
    await call('POST', '/blocks', { name: 'Open the shop', steps: [{ action: 'navigate', target: '/' }] });
    const agent = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, evidence: { trace: 'off', video: 'off' } } })).data;

    assert.equal((await call('POST', '/steps/from-text', { text: '  ' })).status, 400);
    const r = await call('POST', '/steps/from-text', {
      agentId: agent.id,
      text: [
        'Open the shop',
        'Go to the basket',
        'Check that Total shows 42.00',
        'Type "SPRING" into the Coupon field, then click Apply',
        'Verify the page shows "Saved SPRING"',
        'Do a backflip',
      ].join('\n'),
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.usedAi, true);
    assert.equal(r.data.pageOutline, true, 'the AI saw the live page');
    assert.deepEqual(r.data.lines.map((l: any) => [l.text, l.via]), [
      ['Open the shop', 'rules'], ['Go to the basket', 'ai'], ['Check that Total shows 42.00', 'rules'],
      ['Type "SPRING" into the Coupon field', 'rules'], ['click Apply', 'rules'], ['Verify the page shows "Saved SPRING"', 'rules'], ['Do a backflip', 'none'],
    ]);
    assert.match(r.data.lines[6].note, /could not turn this into steps/, 'an unknown action from the AI is dropped');
    assert.deepEqual(r.data.steps, [
      { action: 'use_block', target: 'Open the shop' },
      { action: 'click', target: '[data-testid="cart-link"]' },
      { action: 'assert_text', target: '{{el.Cart.Total}}', data: { value: '42.00' } },
      { action: 'fill', target: 'Coupon', data: { value: 'SPRING' } },
      { action: 'click', target: 'Apply' },
      { action: 'assert_text', target: 'body', data: { value: 'Saved SPRING' } },
    ]);

    // Saved as a test: it runs without the AI
    process.env.COPILOT_CLI_PATH = join(workDir, 'no-such-cli');
    const tc = (await call('POST', '/testcases', { title: 'Coupon', module: 'Cart', priority: 'High', expectedResults: ['saved'], steps: r.data.steps })).data;
    const runRes = await call('POST', '/runs', { agentId: agent.id, testIds: [tc.id], wait: true });
    const run = (await call('GET', `/runs/${runRes.data.id}`)).data;
    assert.equal(run.status, 'completed', JSON.stringify(run.results.map((x: any) => x.error)));
  });
});
