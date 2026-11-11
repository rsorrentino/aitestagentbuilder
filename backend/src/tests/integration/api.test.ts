/**
 * Integration tests: real PostgreSQL + real headless browser.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test \
 *     npm run test:integration
 *
 * Skipped automatically when the database is unreachable. AI calls go to
 * local fakes of the GitHub Copilot CLI and Copilot API — no keys needed.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';

// ---- environment for the app under test (set before any app module loads) ----
const workDir = mkdtempSync(join(tmpdir(), 'atab-it-'));
const fakeCopilot = join(workDir, 'copilot');
writeFileSync(fakeCopilot, `#!/usr/bin/env node
// Fake GitHub Copilot CLI: checks the non-interactive flags and returns test cases as JSON.
const args = process.argv.slice(2);
const need = ['-p', '-s', '--no-ask-user', '--available-tools'];
for (const f of need) if (!args.includes(f)) { console.error('missing flag ' + f); process.exit(2); }
const prompt = args[args.indexOf('-p') + 1];
if (!prompt.includes('Sign in')) { console.error('document text not in prompt'); process.exit(3); }
console.log(JSON.stringify([{ title: 'Extracted: sign in', module: 'Auth', priority: 'High',
  steps: [{ action: 'navigate', target: '/login' }, { action: 'assert_visible', target: '#login-btn' }],
  expectedResults: ['Login form shown'] }]));
`);
chmodSync(fakeCopilot, 0o755);

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'false',
  ARTIFACTS_PATH: join(workDir, 'artifacts'),
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '3000',
  COPILOT_MODE: 'cli',
  COPILOT_CLI_PATH: fakeCopilot,
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER']) {
  delete process.env[k];
}

// ---- fixture web application under test ----
const FIXTURE_PAGES: Record<string, string> = {
  '/login': `<!doctype html><html><head><title>Login - Demo</title></head><body>
    <h1>Sign in</h1>
    <form id="f" onsubmit="event.preventDefault(); location.href='/dashboard?user=' + encodeURIComponent(document.getElementById('username').value)">
      <label for="username">Username</label><input id="username" name="username">
      <label for="password">Password</label><input id="password" type="password">
      <button id="login-btn" type="submit">Sign in</button>
    </form></body></html>`,
  '/dashboard': `<!doctype html><html><head><title>Dashboard - Demo</title></head><body>
    <h1 id="welcome"></h1><script>document.getElementById('welcome').textContent = 'Welcome, ' + new URLSearchParams(location.search).get('user');</script>
    </body></html>`,
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
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

async function waitForRun(runId: string, timeoutMs = 90000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await call('GET', `/api/v1/runs/${runId}`);
    if (!['pending', 'running'].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('run did not finish in time');
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

  fixture = http.createServer((req, res) => {
    const page = FIXTURE_PAGES[(req.url || '/').split('?')[0]];
    res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(page ?? 'not found');
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
  if (process.env.DEBUG_HANDLES) {
    setTimeout(() => console.log('ACTIVE HANDLES', (process as any)._getActiveHandles().map((h: any) => h.constructor?.name + ' ' + (h._host ?? h.remoteAddress ?? h.localPort ?? ''))), 2000).unref();
  }
});

describe('API + executor (integration)', () => {
  let agentId = '';

  it('reports readiness', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const { status, data } = await call('GET', '/health/ready');
    assert.equal(status, 200);
    assert.equal(data.ready, true);
  });

  it('validates and creates agents', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const bad = await call('POST', '/api/v1/agents', { name: 'Bad', config: { base_url: 'nope' } });
    assert.equal(bad.status, 400);

    const ok = await call('POST', '/api/v1/agents', {
      name: 'Demo app',
      config: { base_url: fixtureUrl, test_selection: { module: ['Auth'] }, retries: 0 },
    });
    assert.equal(ok.status, 201, ok.text);
    agentId = ok.data.id;

    const dup = await call('POST', '/api/v1/agents', { name: 'Demo app', config: { base_url: fixtureUrl } });
    assert.equal(dup.status, 409);
  });

  it('refuses a run with no matching tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const { status, data } = await call('POST', '/api/v1/runs', { agentId });
    assert.equal(status, 400);
    assert.match(data.error, /No test cases match/);
  });

  it('creates test cases with validation', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const invalid = await call('POST', '/api/v1/testcases', { name: 'missing fields' });
    assert.equal(invalid.status, 400);

    const passing = await call('POST', '/api/v1/testcases', {
      title: 'Valid login shows welcome',
      module: 'Auth',
      priority: 'Critical',
      steps: [
        { action: 'navigate', target: '/login' },
        { action: 'Enter username', target: '#username', data: { value: 'alice' } },
        { action: 'fill', target: 'Password', data: { value: 'secret' } },
        { action: 'click', target: 'Sign in button' },
        { action: 'assert_url', data: { value: '/dashboard' } },
        { action: 'Verify welcome message', target: '#welcome', data: { value: 'Welcome, alice' } },
      ],
      expectedResults: ['Dashboard greets the user'],
    });
    assert.equal(passing.status, 201, passing.text);
    assert.equal(passing.data.steps[0].stepId, 1);

    const failing = await call('POST', '/api/v1/testcases', {
      title: 'Broken selector fails',
      module: 'Auth',
      priority: 'Low',
      steps: [{ action: 'navigate', target: '/login' }, { action: 'click', target: '#does-not-exist' }],
      expectedResults: ['should fail'],
    });
    assert.equal(failing.status, 201);

    const other = await call('POST', '/api/v1/testcases', {
      title: 'Other module is not selected', module: 'Billing', priority: 'High', steps: [{ action: 'navigate', target: '/' }], expectedResults: [],
    });
    assert.equal(other.status, 201);

    const plan = await call('GET', `/api/v1/agents/${agentId}/plan`);
    assert.equal(plan.data.count, 2);
    assert.equal(plan.data.testCases[0].title, 'Valid login shows welcome'); // Critical first
  });

  it('runs tests in a real browser and records results', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const start = await call('POST', '/api/v1/runs', { agentId });
    assert.equal(start.status, 201, start.text);
    assert.equal(start.data.totalTests, 2);

    const run = await waitForRun(start.data.id);
    assert.equal(run.status, 'failed'); // one test fails by design
    assert.equal(run.passedTests, 1);
    assert.equal(run.failedTests, 1);

    const passed = run.results.find((r: any) => r.status === 'passed');
    assert.equal(passed.metadata.title, 'Valid login shows welcome');
    assert.equal(passed.metadata.steps.length, 6);
    assert.ok(passed.evidence.screenshots.length >= 1);

    const failed = run.results.find((r: any) => r.status === 'failed');
    assert.match(failed.error, /#does-not-exist/);

    const shot = await fetch(`${apiUrl}/artifacts/${passed.evidence.screenshots[0]}`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');

    const html = await call('GET', `/api/v1/runs/${run.id}/report?format=html`);
    assert.equal(html.status, 200);
    assert.match(html.text, /Valid login shows welcome/);
    const junit = await call('GET', `/api/v1/runs/${run.id}/report?format=junit`);
    assert.match(junit.text, /<testsuite[^>]+tests="2"[^>]+failures="1"/);

    const list = await call('GET', `/api/v1/runs?agentId=${agentId}`);
    assert.equal(list.data[0].agentName, 'Demo app');
  });

  it('runs selected tests only and supports cancellation', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const tcs = await call('GET', '/api/v1/testcases?q=Valid login');
    const start = await call('POST', '/api/v1/runs', { agentId, testIds: [tcs.data[0].id] });
    assert.equal(start.data.totalTests, 1);
    const cancel = await call('POST', `/api/v1/runs/${start.data.id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.status, 'cancelled');
    const again = await call('POST', `/api/v1/runs/${start.data.id}/cancel`);
    assert.equal(again.status, 409);
  });

  it('uploads text documents verbatim and extracts tests through the Copilot CLI', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const form = new FormData();
    form.append('file', new Blob(['# Login spec\n\n1. Open /login\n2. Sign in with valid user\n'], { type: 'text/markdown' }), 'login-spec.md');
    const up = await call('POST', '/api/v1/ingestion/upload', form);
    assert.equal(up.status, 201, up.text);
    assert.equal(up.data.sourceType, 'markdown');

    const preview = await call('GET', `/api/v1/ingestion/documents/${up.data.id}/preview`);
    assert.match(preview.data.text, /Sign in with valid user/);

    const extract = await call('POST', `/api/v1/ingestion/documents/${up.data.id}/extract`, {});
    assert.equal(extract.status, 200, extract.text);
    assert.equal(extract.data.metadata.provider, 'copilot');
    assert.equal(extract.data.extracted, 1);

    const docs = await call('GET', '/api/v1/ingestion/documents');
    const doc = docs.data.find((d: any) => d.id === up.data.id);
    assert.equal(doc.status, 'processed');
    assert.equal(doc.testCaseCount, 1);
    assert.equal(doc.content, undefined); // list omits content
  });

  it('exposes provider status including the Copilot mode', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const { data } = await call('GET', '/api/v1/llm/providers');
    const copilot = data.providers.find((p: any) => p.provider === 'copilot');
    assert.equal(copilot.configured, true);
    assert.equal(copilot.mode, 'cli');
    assert.deepEqual(data.routing.chat, ['copilot']);
  });
});

describe('GitHub Copilot API transport', () => {
  it('exchanges the GitHub token and calls the chat completions endpoint', async () => {
    const seen: string[] = [];
    const mock = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.url === '/copilot_internal/v2/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'copilot-session-token', expires_at: Math.floor(Date.now() / 1000) + 600, endpoints: { api: `http://127.0.0.1:${(mock.address() as AddressInfo).port}` } }));
        return;
      }
      if (req.url === '/chat/completions') {
        assert.equal(req.headers['copilot-integration-id'], 'vscode-chat');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4o',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    const port = (mock.address() as AddressInfo).port;

    const saved = { ...process.env };
    Object.assign(process.env, { COPILOT_MODE: 'api', COPILOT_GITHUB_TOKEN: 'gho_test', COPILOT_TOKEN_URL: `http://127.0.0.1:${port}/copilot_internal/v2/token` });
    try {
      const { CopilotClient } = await import('../../infra/llm/copilot.js');
      const client = new CopilotClient();
      const res = await client.chat([{ role: 'user', content: 'ping' }]);
      assert.equal(res.content, 'pong');
      assert.ok(seen.some((s) => s.startsWith('GET /copilot_internal/v2/token token gho_test')));
      assert.ok(seen.some((s) => s.startsWith('POST /chat/completions Bearer copilot-session-token')));
    } finally {
      process.env = saved;
      await new Promise((r) => mock.close(r));
    }
  });
});
