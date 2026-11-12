/**
 * Parallel tests within a run (integration, real PostgreSQL + Chromium): tests of a browser
 * run N at a time, results and counts stay right, failures are still re-run, and parallel
 * tests signing in as the same user produce one sign-in (the others reuse its session).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-parallel-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '4000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO', 'MAX_PARALLEL_TESTS']) delete process.env[k];

// The application: a slow page (records how many requests overlap) and a sign-in form
let inFlight = 0;
let maxInFlight = 0;
let logins = 0;
const sessions = new Set<string>();
const page = (body: string) => `<!doctype html><title>App</title>${body}`;
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const cookie = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
  const send = (status: number, html: string, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(html); };
  if (url.pathname === '/slow') {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 700));
    inFlight--;
    return send(200, page(`<h1>Item ${url.searchParams.get('n')}</h1>`));
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    if (form.get('email') === 'alice@example.com' && form.get('password') === 'alice-pw') {
      logins++;
      const sid = Math.random().toString(36).slice(2);
      sessions.add(sid);
      return send(302, '', { Location: '/home', 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly` });
    }
    return send(200, page('<p>Wrong password</p>'));
  }
  if (url.pathname === '/login') {
    return send(200, page('<h1>Sign in</h1><form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>'));
  }
  if (!cookie || !sessions.has(cookie)) return send(302, '', { Location: '/login' });
  return send(200, page(`<h1>Welcome alice</h1><p id="path">${url.pathname}</p>`));
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
const run = async (agentId: string, metadata: any = {}) => {
  const r = await call('POST', '/runs', { agentId, wait: true, timeoutSeconds: 180, metadata });
  assert.ok([200, 202].includes(r.status), r.text);
  return (await call('GET', `/runs/${r.data.id}`)).data;
};

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

describe('parallel tests (integration)', () => {
  it('runs the tests of a browser N at a time, with correct results', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.match((await call('POST', '/agents', { name: 'Bad', config: { base_url: base, parallel: 40 } })).data.error, /config\.parallel must be a whole number of tests to run at the same time, 1–16/);

    const ids: string[] = [];
    for (let n = 1; n <= 8; n++) {
      ids.push((await call('POST', '/testcases', {
        title: `Item ${n}`, module: 'Slow', priority: 'Medium', tags: ['slow'], expectedResults: ['shown'],
        // Item 8 fails: its page says "Item 8"
        steps: [{ action: 'navigate', target: `/slow?n=${n}` }, { action: 'assert_text', target: 'h1', data: { value: n === 8 ? 'Item eight' : `Item ${n}` } }],
      })).data.id);
    }
    const sequential = (await call('POST', '/agents', { name: 'One at a time', config: { base_url: base, test_selection: { tags: ['slow'] }, evidence: { trace: 'off', video: 'off' } } })).data;
    const parallel = (await call('POST', '/agents', { name: 'Four at a time', config: { base_url: base, parallel: 4, test_selection: { tags: ['slow'] }, evidence: { trace: 'off', video: 'off' } } })).data;

    maxInFlight = 0;
    const one = await run(sequential.id);
    assert.equal(maxInFlight, 1);

    maxInFlight = 0;
    const four = await run(parallel.id);
    assert.equal(maxInFlight, 4, 'four pages loading at once');
    assert.ok(four.duration < one.duration * 0.7, `parallel ${four.duration} ms vs sequential ${one.duration} ms`);
    for (const r of [one, four]) {
      assert.equal(r.status, 'failed');
      assert.deepEqual([r.totalTests, r.passedTests, r.failedTests], [8, 7, 1]);
      assert.deepEqual(r.results.map((x: any) => x.metadata.title).sort(), ids.map((_, i) => `Item ${i + 1}`).sort());
    }

    // Unattended: the failure is re-run at the end, also in parallel mode
    const night = await run(parallel.id, { triggeredBy: 'schedule' });
    assert.equal(night.results.filter((x: any) => x.metadata.rerun).length, 1);
    assert.equal(night.failedTests, 1);
  });

  it('parallel tests signing in as the same user sign in once and share the session', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = (await call('POST', '/agents', {
      name: 'Signed in, four at a time',
      config: {
        base_url: base, parallel: 4, test_selection: { tags: ['home'] }, evidence: { trace: 'off', video: 'off' },
        auth: { default_profile: 'alice', profiles: [{ name: 'alice', login_url: '/login', username: 'alice@example.com', password: 'alice-pw', landing_path: '/home' }] },
      },
    })).data;
    for (let n = 1; n <= 4; n++) {
      await call('POST', '/testcases', {
        title: `Page ${n}`, module: 'Home', priority: 'High', tags: ['home'], expectedResults: ['greeting'], data: { login_as: 'alice' },
        steps: [{ action: 'navigate', target: `/page${n}` }, { action: 'assert_text', target: 'h1', data: { value: 'Welcome alice' } }],
      });
    }
    logins = 0;
    const r = await run(agent.id);
    assert.equal(r.status, 'completed', JSON.stringify(r.results.map((x: any) => x.error)));
    assert.equal(r.passedTests, 4);
    assert.equal(logins, 1, 'one sign-in, three reused sessions');
  });
});
