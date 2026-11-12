/**
 * Unattended runs (integration, real PostgreSQL + headless Chromium):
 * pre-flight checks with retries, failed tests re-run at the end, the run
 * watchdog, interrupted runs started again after a restart, daily digest.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import net, { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(mkdtempSync(join(tmpdir(), 'atab-unattended-')), 'artifacts'),
  LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '3000', NOTIFICATIONS_ALLOW_PRIVATE_URLS: 'true',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

// ---- application under test: can be "down" for a number of requests; one page fails on its first visit ----
let downFor = 0;
let flakyVisits = 0;
const hooks: any[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

let fixture: Server;
let base = '';
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
async function newAgent(name: string, config: Record<string, any>): Promise<string> {
  const r = await call('POST', '/agents', { name, config: { evidence: { trace: 'off', video: 'off' }, ...config } });
  assert.equal(r.status, 201, r.text);
  return r.data.id;
}
async function newTest(title: string, steps: any[]): Promise<string> {
  const r = await call('POST', '/testcases', { title, module: 'Night', priority: 'High', steps, expectedResults: ['ok'] });
  assert.equal(r.status, 201, r.text);
  return r.data.id;
}
async function run(agentId: string, testIds: string[], triggeredBy?: string): Promise<any> {
  const r = await call('POST', '/runs', { agentId, testIds, wait: true, timeoutSeconds: 120, ...(triggeredBy ? { metadata: { triggeredBy } } : {}) });
  assert.ok([200, 202].includes(r.status), r.text);
  return (await call('GET', `/runs/${r.data.id}`)).data;
}
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
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
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/hook') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { hooks.push(JSON.parse(raw)); res.writeHead(204); res.end(); });
      return;
    }
    if (downFor > 0) {
      downFor--;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return void res.end('Service Unavailable');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (url.pathname === '/flaky') return void res.end(page('Flaky', `<p id="state">${++flakyVisits === 1 ? 'Oops' : 'OK'}</p>`));
    res.end(page('Home', '<p id="state">OK</p>'));
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
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

describe('unattended runs (integration)', () => {
  it('checks the application first: waits for it to come back, or fails once without running the tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const home = await newTest('Home is up', [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#state', data: { value: 'OK' } }]);

    // Down for the first check, back for the retry
    const agent = await newAgent('Comes back', { base_url: base, unattended: { preflight_retries: 2, preflight_wait_seconds: 1 } });
    downFor = 1;
    const r1 = await run(agent, [home], 'schedule');
    assert.equal(r1.status, 'completed', JSON.stringify(r1.metadata));
    assert.equal(r1.metadata.preflight.ok, true);
    assert.equal(r1.metadata.preflight.attempts, 2);

    // Never answers: one failure with the reason, no test executed
    const down = await newAgent('Stays down', { base_url: `http://127.0.0.1:${await closedPort()}`, unattended: { preflight_retries: 1, preflight_wait_seconds: 1 } });
    const r2 = await run(down, [home], 'schedule');
    assert.equal(r2.status, 'failed');
    assert.equal(r2.results.length, 0, 'no test was run');
    assert.equal(r2.metadata.preflight.attempts, 2);
    assert.match(r2.metadata.error, /Pre-flight failed after 2 attempt\(s\): application — http:\/\/127\.0\.0\.1:\d+: no answer/);

    // Turned off: tests run (and fail) as before
    const off = await newAgent('No pre-flight', { base_url: `http://127.0.0.1:${await closedPort()}`, unattended: { preflight: false } });
    const r3 = await run(off, [home], 'schedule');
    assert.ok(r3.results.length >= 1, 'the tests ran');
    assert.equal(r3.metadata.preflight, undefined);
  });

  it('re-runs failed tests once at the end of unattended runs only', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Flaky night', { base_url: base });
    const flaky = await newTest('Flaky page', [{ action: 'navigate', target: '/flaky' }, { action: 'assert_text', target: '#state', data: { value: 'OK' } }]);

    flakyVisits = 0;
    const night = await run(agent, [flaky], 'schedule');
    assert.equal(night.status, 'completed', JSON.stringify(night.results.map((r: any) => r.error)));
    assert.equal(night.passedTests, 1);
    assert.equal(night.failedTests, 0);
    const attempts = night.results.map((r: any) => [r.status, r.metadata.rerun ?? false]);
    assert.deepEqual(attempts.sort(), [['failed', false], ['passed', true]]);

    flakyVisits = 0;
    const manual = await run(agent, [flaky]);
    assert.equal(manual.status, 'failed', 'a person watching gets the failure as it is');
    assert.equal(manual.results.length, 1);
  });

  it('stops a run that takes too long', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Hangs', { base_url: base, unattended: { max_run_minutes: 0.05 } });
    const slow = await newTest('Waits forever', [{ action: 'navigate', target: '/' }, { action: 'wait', data: { ms: 20000 } }, { action: 'wait', data: { ms: 20000 } }]);
    const started = Date.now();
    const r = await run(agent, [slow], 'schedule');
    assert.equal(r.status, 'failed');
    assert.match(r.metadata.error, /Stopped after 0\.05 minutes/);
    assert.ok(Date.now() - started < 30_000, 'stopped early');
  });

  it('starts an unattended run again after a restart interrupted it', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Restarted', { base_url: base });
    const home = await newTest('Home after restart', [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#state', data: { value: 'OK' } }]);
    const { default: getDatabaseClient } = await import('../../infra/db/client.js');
    const db = getDatabaseClient();
    const projectId = (await db.query('SELECT project_id FROM agents WHERE id = $1', [agent])).rows[0].project_id;
    // As if the server died during a scheduled run, and a person's run
    await db.query(`INSERT INTO runs (id, agent_id, project_id, status, started_at, total_tests, metadata) VALUES
      ('RUN-NIGHT', $1, $2, 'running', NOW() - INTERVAL '10 minutes', 1, $3), ('RUN-MANUAL', $1, $2, 'running', NOW(), 1, '{"triggeredBy":"user"}')`,
    [agent, projectId, JSON.stringify({ triggeredBy: 'schedule', scheduleName: 'Nightly', testIds: [home] })]);
    const { RunRepository } = await import('../../core/repositories/run.repository.js');
    const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
    const interrupted = await new RunRepository().failInterruptedRuns();
    assert.deepEqual(interrupted.map((r) => r.id).sort(), ['RUN-MANUAL', 'RUN-NIGHT']);
    const resumed = await OrchestratorService.get().resumeInterruptedRuns(interrupted);
    assert.equal(resumed.length, 1, 'only the unattended run starts again');
    const { runEvents } = await import('../../modules/automation/run-events.js');
    const done = await runEvents.waitForFinish(resumed[0], 60_000);
    assert.equal(done?.status, 'completed');
    assert.equal(done?.metadata?.resumedFrom, 'RUN-NIGHT');
    assert.equal(done?.metadata?.scheduleName, 'Nightly');
    const old = (await call('GET', '/runs/RUN-NIGHT')).data;
    assert.equal(old.metadata.resumedAs, resumed[0]);
    assert.equal((await OrchestratorService.get().resumeInterruptedRuns([{ ...interrupted[0], metadata: { triggeredBy: 'schedule', resumedFrom: 'X' } }])).length, 0, 'started again only once');
  });

  it('sends a daily digest of the night', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const channel = await call('POST', '/notifications', {
      name: 'Morning', type: 'webhook', config: { url: `${base}/hook`, digest_time: '07:30', digest_timezone: 'Europe/Rome' }, events: ['digest.daily'],
    });
    assert.equal(channel.status, 201, channel.text);
    assert.equal((await call('POST', '/notifications', { name: 'Bad', type: 'webhook', config: { url: `${base}/hook`, digest_time: '25:00' }, events: ['digest.daily'] })).status, 400);

    const sent = await call('POST', `/notifications/${channel.data.id}/digest`);
    assert.equal(sent.data.ok, true, sent.text);
    const hook = hooks.find((h) => h.event === 'digest.daily');
    assert.ok(hook);
    assert.match(hook.run.headline, /🌅 Default: \d+ of \d+ agent\(s\) failing/);
    const lines = hook.run.failures.map((f: any) => f.title).join('\n');
    assert.match(lines, /⚠️ Stays down: 0 passed, 0 failed \(1 pre-flight failure\(s\): application unreachable\)/);
    assert.match(lines, /Flaky night: .*passed only when re-run/);

    // The background job sends it once per day, after its time
    const { sendDueDigests } = await import('../../modules/automation/digest.js');
    const before = hooks.length;
    const morning = new Date('2030-01-15T06:31:00Z');
    assert.equal(await sendDueDigests(new Date('2030-01-15T06:00:00Z')), 0);
    assert.equal(await sendDueDigests(morning), 1);
    assert.equal(await sendDueDigests(new Date('2030-01-15T08:00:00Z')), 0);
    assert.equal(hooks.length, before + 1);
  });
});
