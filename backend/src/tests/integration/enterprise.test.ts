/**
 * Enterprise features with AUTH_ENABLED=true: projects & RBAC, account
 * security, encrypted secrets, audit log, scoped API keys, signed artifacts,
 * authenticated WebSockets, schedules, notifications, CI wait mode,
 * analytics, OpenAPI. Real PostgreSQL + real browser.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { io as ioClient } from 'socket.io-client';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-ent-'));
const ADMIN = { email: 'admin@example.com', password: 'Adm1n-Passw0rd!' };

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'true',
  ADMIN_EMAIL: ADMIN.email,
  ADMIN_PASSWORD: ADMIN.password,
  JWT_SECRET: 'test-jwt-secret',
  SECRETS_ENCRYPTION_KEY: 'test-secrets-key',
  ARTIFACTS_PATH: join(workDir, 'artifacts'),
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '5000',
  MAX_FAILED_LOGINS: '3',
  NOTIFICATIONS_ALLOW_PRIVATE_URLS: 'true',
  RATE_LIMIT_POINTS: '100000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER']) {
  delete process.env[k];
}

let api: Server;
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;
let db: any;

// Webhook receiver for notification tests
const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
let receiver: Server;
let receiverUrl = '';

type Opts = { token?: string; apiKey?: string; project?: string };
async function call(method: string, path: string, body?: any, opts: Opts = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers.Authorization = `ApiKey ${opts.apiKey}`;
  if (opts.project) headers['X-Project-Id'] = opts.project;
  const res = await fetch(`${apiUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}

async function login(email: string, password: string) {
  return call('POST', '/api/v1/auth/login', { email, password });
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

  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { seedAdminUser } = await import('../../api/controllers/auth.controller.js');
  const { createApp } = await import('../../app.js');
  const { initializeWebSocket } = await import('../../infra/websocket/server.js');
  const { wireNotifications } = await import('../../modules/automation/notification.service.js');
  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  db = getDatabaseClient();
  await runMigrations();
  await seedAdminUser();
  wireNotifications();

  api = http.createServer(createApp());
  const ws = initializeWebSocket(api);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  process.env.DEMO_BASE_URL = `${apiUrl}/demo/`;

  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    await ws.close();
    api.closeAllConnections();
    receiver.closeAllConnections();
    await new Promise((r) => api.close(r));
    await new Promise((r) => receiver.close(r));
    await db.close();
  };
});

after(async () => { await closeAll(); });

describe('enterprise (AUTH_ENABLED=true)', () => {
  let adminToken = '';
  let userToken = '';
  let userId = '';
  let alphaId = '';
  let agentId = '';
  const userEmail = 'qa.engineer@example.com';
  const userPassword = 'Qa-Engineer-2026!';

  it('applies versioned migrations', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const rows = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r: any) => r.version);
    assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('requires authentication and logs the admin in', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.equal((await call('GET', '/api/v1/agents')).status, 401);
    const res = await login(ADMIN.email, ADMIN.password);
    assert.equal(res.status, 200, res.text);
    adminToken = res.data.accessToken;
    const me = await call('GET', '/api/v1/auth/me', undefined, { token: adminToken });
    assert.equal(me.data.user.role, 'admin');
    assert.ok(me.data.projects.some((p: any) => p.id === 'default'));
  });

  it('enforces the password policy and a first-login password change', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const weak = await call('POST', '/api/v1/admin/users', { email: userEmail, password: 'short' }, { token: adminToken });
    assert.equal(weak.status, 400);
    assert.match(weak.data.error, /at least 12 characters/);

    const created = await call('POST', '/api/v1/admin/users', { email: userEmail, name: 'QA Engineer' }, { token: adminToken });
    assert.equal(created.status, 201, created.text);
    userId = created.data.user.id;
    const temp = created.data.temporaryPassword;
    assert.ok(temp);

    const first = await login(userEmail, temp);
    assert.equal(first.data.user.mustChangePassword, true);
    const blocked = await call('GET', '/api/v1/projects', undefined, { token: first.data.accessToken });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

    const changed = await call('POST', '/api/v1/auth/change-password', { currentPassword: temp, newPassword: userPassword }, { token: first.data.accessToken });
    assert.equal(changed.status, 200, changed.text);
    userToken = (await login(userEmail, userPassword)).data.accessToken;
    assert.equal((await call('GET', '/api/v1/projects', undefined, { token: userToken })).status, 200);
  });

  it('locks accounts after repeated failures and lets an admin unlock them', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.equal((await login(userEmail, 'wrong-1')).status, 401);
    assert.equal((await login(userEmail, 'wrong-2')).status, 401);
    assert.equal((await login(userEmail, 'wrong-3')).status, 423);
    assert.equal((await login(userEmail, userPassword)).status, 423, 'locked even with the right password');
    assert.equal((await call('POST', `/api/v1/admin/users/${userId}/unlock`, {}, { token: adminToken })).status, 200);
    const ok = await login(userEmail, userPassword);
    assert.equal(ok.status, 200);
    userToken = ok.data.accessToken;
  });

  it('isolates projects and enforces project roles', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.equal((await call('POST', '/api/v1/projects', { name: 'Nope' }, { token: userToken })).status, 403, 'only admins create projects');
    const alpha = await call('POST', '/api/v1/projects', { name: 'Alpha Team' }, { token: adminToken });
    assert.equal(alpha.status, 201);
    alphaId = alpha.data.id;

    // Not a member yet
    assert.equal((await call('GET', '/api/v1/agents', undefined, { token: userToken, project: alphaId })).status, 403);

    // Viewer can read, not write
    assert.equal((await call('PUT', `/api/v1/projects/${alphaId}/members`, { email: userEmail, role: 'viewer' }, { token: adminToken })).status, 200);
    assert.equal((await call('GET', '/api/v1/agents', undefined, { token: userToken, project: alphaId })).status, 200);
    const denied = await call('POST', '/api/v1/agents', { name: 'x', config: { base_url: 'https://example.com' } }, { token: userToken, project: alphaId });
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /editor/);

    // Editor can write
    assert.equal((await call('PUT', `/api/v1/projects/${alphaId}/members`, { email: userEmail, role: 'editor' }, { token: adminToken })).status, 200);
    const seeded = await call('POST', '/api/v1/demo/seed', {}, { token: userToken, project: alphaId });
    assert.equal(seeded.status, 200, seeded.text);
    agentId = seeded.data.agentId;

    // The agent lives in Alpha only
    assert.equal((await call('GET', `/api/v1/agents/${agentId}`, undefined, { token: adminToken, project: 'default' })).status, 404);
    assert.equal((await call('GET', `/api/v1/agents/${agentId}`, undefined, { token: userToken, project: alphaId })).status, 200);
    // Editors cannot change roles above their own or delete agents
    assert.equal((await call('PUT', `/api/v1/projects/${alphaId}/members`, { email: ADMIN.email, role: 'owner' }, { token: userToken })).status, 403);
    assert.equal((await call('DELETE', `/api/v1/agents/${agentId}`, undefined, { token: userToken, project: alphaId })).status, 403);
  });

  it('encrypts agent secrets at rest, redacts them, and restricts who changes them', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const byEditor = await call('PUT', `/api/v1/agents/${agentId}`, { config: { secrets: { DEMO_PASSWORD: 'demo123' } } }, { token: userToken, project: alphaId });
    assert.equal(byEditor.status, 403, 'editors cannot set secrets');

    const set = await call('PUT', `/api/v1/agents/${agentId}`, { config: { secrets: { DEMO_PASSWORD: 'demo123' } } }, { token: adminToken, project: alphaId });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.data.config.secrets.DEMO_PASSWORD, '••••••••');

    const raw = (await db.query('SELECT config FROM agents WHERE id = $1', [agentId])).rows[0].config;
    assert.match(raw.secrets.DEMO_PASSWORD, /^enc:v1:/);
    assert.ok(!JSON.stringify(raw).includes('demo123'));

    // Sending the placeholder back keeps the value; other edits by editors are fine
    const keep = await call('PUT', `/api/v1/agents/${agentId}`, { config: { environment: 'qa' } }, { token: userToken, project: alphaId });
    assert.equal(keep.status, 200);
    const after = (await db.query('SELECT config FROM agents WHERE id = $1', [agentId])).rows[0].config;
    assert.equal(after.secrets.DEMO_PASSWORD, raw.secrets.DEMO_PASSWORD);

    // Salesforce personas: editors may verify them but not change them or move the agent's URL
    const sfAgent = await call('POST', '/api/v1/agents', {
      name: 'SF guard', config: { base_url: 'https://acme.my.salesforce.com', salesforce: { personas: [{ name: 'rep', auth_method: 'password', username: 'rep@acme.com', password: 'Rep-Secret-1!' }] } },
    }, { token: adminToken, project: alphaId });
    assert.equal(sfAgent.status, 201, sfAgent.text);
    const sfPath = `/api/v1/agents/${sfAgent.data.id}`;
    assert.equal((await call('PUT', sfPath, { config: { salesforce: { personas: [] } } }, { token: userToken, project: alphaId })).status, 403, 'editors cannot change personas');
    assert.equal((await call('PUT', sfPath, { config: { base_url: 'https://attacker.example' } }, { token: userToken, project: alphaId })).status, 403, 'editors cannot move a Salesforce agent');
    assert.equal((await call('PUT', sfPath, { config: { base_url: 'https://acme.my.salesforce.com', retries: 1 } }, { token: userToken, project: alphaId })).status, 200);
    assert.equal((await call('PUT', sfPath, { config: { base_url: 'https://acme2.my.salesforce.com' } }, { token: adminToken, project: alphaId })).status, 200);
    const sfGet = await call('GET', sfPath, undefined, { token: userToken, project: alphaId });
    assert.ok(!sfGet.text.includes('Rep-Secret-1!'));

    // Use the secret in a test step
    const tc = await call('POST', '/api/v1/testcases', {
      title: 'Login with a secret password', module: 'Secrets', priority: 'Critical', tags: ['demo'],
      steps: [
        { action: 'navigate', target: 'login' },
        { action: 'fill', target: '#username', data: { value: 'demo' } },
        { action: 'fill', target: '#password', data: { value: '{{secrets.DEMO_PASSWORD}}' } },
        { action: 'click', target: '#login-btn' },
        { action: 'assert_text', target: '#welcome', data: { value: 'Welcome, demo!' } },
      ],
      expectedResults: ['logged in'],
    }, { token: userToken, project: alphaId });
    assert.equal(tc.status, 201, tc.text);
  });

  it('runs in CI wait mode, masks secrets and signs artifact URLs', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const channel = await call('POST', '/api/v1/notifications', {
      name: 'CI hook', type: 'webhook', config: { url: receiverUrl, secret: 'hook-secret' }, events: ['run.completed', 'run.failed'],
    }, { token: adminToken, project: alphaId });
    assert.equal(channel.status, 201, channel.text);
    assert.equal(channel.data.config.secret, '••••••••');

    const res = await call('POST', '/api/v1/runs', { agentId, wait: true, timeoutSeconds: 120 }, { token: userToken, project: alphaId });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.passed, true, JSON.stringify(res.data.results?.map((r: any) => [r.metadata?.title, r.status, r.error])));
    assert.equal(res.data.passedTests, 4);
    assert.equal(res.data.metadata.triggeredBy, 'user');
    assert.ok(!JSON.stringify(res.data).includes('demo123'), 'secret never appears in results');

    const shot = res.data.results.find((r: any) => r.evidence?.screenshots?.length).evidence.screenshots[0];
    assert.match(shot, /\?exp=\d+&sig=/);
    assert.equal((await fetch(`${apiUrl}/artifacts/${shot}`)).status, 200);
    assert.equal((await fetch(`${apiUrl}/artifacts/${shot.split('?')[0]}`)).status, 403, 'unsigned artifact is refused');

    // Notification delivered with a valid HMAC signature
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
    const { headers, body } = received[0];
    const expected = `sha256=${crypto.createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
    assert.equal(headers['x-atab-signature'], expected);
    assert.equal(headers['x-atab-event'], 'run.completed');
    assert.equal(JSON.parse(body).run.passed, 4);
  });

  it('refuses private notification targets unless allowed (SSRF guard)', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const list = await call('GET', '/api/v1/notifications', undefined, { token: adminToken, project: alphaId });
    const id = list.data[0].id;
    process.env.NOTIFICATIONS_ALLOW_PRIVATE_URLS = 'false';
    try {
      const res = await call('POST', `/api/v1/notifications/${id}/test`, {}, { token: adminToken, project: alphaId });
      assert.equal(res.status, 502);
      assert.match(res.data.error, /private\/loopback/);
    } finally {
      process.env.NOTIFICATIONS_ALLOW_PRIVATE_URLS = 'true';
    }
  });

  it('authenticates WebSockets and authorises run subscriptions', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const runs = await call('GET', '/api/v1/runs', undefined, { token: adminToken, project: alphaId });
    const runId = runs.data[0].id;

    const anonymous = ioClient(apiUrl, { transports: ['websocket'], reconnection: false });
    const anonError = await new Promise<string>((resolve) => anonymous.on('connect_error', (e) => resolve(e.message)));
    anonymous.close();
    assert.match(anonError, /Authentication required/);

    const outsider = await call('POST', '/api/v1/admin/users', { email: 'outsider@example.com', password: 'Xyz-Strong-Pass-2026!' }, { token: adminToken });
    await db.query('UPDATE users SET must_change_password = false WHERE id = $1', [outsider.data.user.id]);
    const outsiderToken = (await login('outsider@example.com', 'Xyz-Strong-Pass-2026!')).data.accessToken;

    const check = async (token: string) => {
      const socket = ioClient(apiUrl, { transports: ['websocket'], reconnection: false, auth: { token } });
      await new Promise<void>((resolve, reject) => { socket.on('connect', () => resolve()); socket.on('connect_error', reject); });
      const ack = await socket.timeout(5000).emitWithAck('subscribe_run', { runId });
      socket.close();
      return ack.ok;
    };
    assert.equal(await check(userToken), true);
    assert.equal(await check(outsiderToken), false);
  });

  it('supports project-scoped, role-limited API keys', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const key = await call('POST', '/api/v1/auth/api-keys', { name: 'ci-readonly', projectId: alphaId, role: 'viewer' }, { token: adminToken });
    assert.equal(key.status, 201);
    const apiKey = key.data.apiKey;
    assert.equal((await call('GET', '/api/v1/agents', undefined, { apiKey })).status, 200, 'defaults to the key project');
    assert.equal((await call('POST', '/api/v1/runs', { agentId }, { apiKey })).status, 403, 'viewer cannot start runs');
    assert.equal((await call('GET', '/api/v1/agents', undefined, { apiKey, project: 'default' })).status, 403, 'key restricted to Alpha');
    assert.equal((await call('GET', '/api/v1/admin/users', undefined, { apiKey })).status, 403, 'scoped keys are never admin');
  });

  it('schedules runs (multi-replica safe) and validates cron', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const bad = await call('POST', '/api/v1/schedules', { agentId, cron: 'every day', timezone: 'UTC' }, { token: userToken, project: alphaId });
    assert.equal(bad.status, 400);
    const tooOften = await call('POST', '/api/v1/schedules', { agentId, cron: '* * * * *' }, { token: userToken, project: alphaId });
    assert.equal(tooOften.status, 400);
    const created = await call('POST', '/api/v1/schedules', { agentId, name: 'Nightly', cron: '0 2 * * *', timezone: 'Europe/Rome' }, { token: userToken, project: alphaId });
    assert.equal(created.status, 201, created.text);
    assert.ok(new Date(created.data.nextRunAt) > new Date());

    await db.query(`UPDATE schedules SET next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [created.data.id]);
    const { ScheduleService } = await import('../../modules/automation/schedule.service.js');
    // Two concurrent ticks (two replicas) start exactly one run
    const [a, b] = await Promise.all([new ScheduleService().tick(), new ScheduleService().tick()]);
    assert.equal(a + b, 1);
    const s = (await call('GET', '/api/v1/schedules', undefined, { token: userToken, project: alphaId })).data[0];
    assert.ok(s.lastRunId);
    assert.ok(new Date(s.nextRunAt) > new Date());
    const run = await call('GET', `/api/v1/runs/${s.lastRunId}`, undefined, { token: userToken, project: alphaId });
    assert.equal(run.data.metadata.triggeredBy, 'schedule');
    await call('POST', `/api/v1/runs/${s.lastRunId}/cancel`, {}, { token: userToken, project: alphaId });
  });

  it('records an audit trail with CSV export', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const failed = await call('GET', '/api/v1/admin/audit?action=auth.login.failed', undefined, { token: adminToken });
    assert.ok(failed.data.total >= 2);
    assert.ok((await call('GET', '/api/v1/admin/audit?action=auth.account.locked', undefined, { token: adminToken })).data.total >= 1);

    const projectLog = await call('GET', '/api/v1/audit', undefined, { token: adminToken, project: alphaId });
    const actions = projectLog.data.entries.map((e: any) => e.action);
    for (const a of ['demo.seed', 'agent.update', 'run.start', 'notification.create', 'schedule.create', 'project.member.set']) {
      assert.ok(actions.includes(a), `missing ${a} in ${actions.join(',')}`);
    }
    const secretChange = projectLog.data.entries.find((e: any) => e.action === 'agent.update' && e.details?.secretsChanged);
    assert.ok(secretChange, 'secret changes are flagged');
    assert.ok(!JSON.stringify(projectLog.data).includes('demo123'));
    assert.equal((await call('GET', '/api/v1/audit', undefined, { token: userToken, project: alphaId })).status, 403, 'editors cannot read the audit log');

    const csv = await call('GET', '/api/v1/admin/audit?format=csv', undefined, { token: adminToken });
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.ok(csv.text.startsWith('time,user,action'));
  });

  it('reports analytics and serves the OpenAPI spec', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const analytics = await call('GET', '/api/v1/analytics?days=7', undefined, { token: userToken, project: alphaId });
    assert.equal(analytics.status, 200, analytics.text);
    assert.ok(analytics.data.totals.runs >= 1);
    assert.equal(analytics.data.totals.passRate, 100);
    assert.equal(analytics.data.trend.length, 1);

    const spec = await call('GET', '/api/v1/openapi.json');
    assert.equal(spec.data.openapi, '3.1.0');
    assert.ok(spec.data.paths['/runs'].post);
    assert.equal((await fetch(`${apiUrl}/api/docs/`)).status, 200);
  });

  it('deactivated users lose access immediately', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    assert.equal((await call('PATCH', `/api/v1/admin/users/${userId}`, { active: false }, { token: adminToken })).status, 200);
    assert.equal((await call('GET', '/api/v1/projects', undefined, { token: userToken })).status, 401);
    const lastAdmin = await call('PATCH', `/api/v1/admin/users/${(await call('GET', '/api/v1/auth/me', undefined, { token: adminToken })).data.user.id}`, { role: 'user' }, { token: adminToken });
    assert.equal(lastAdmin.status, 409, 'cannot demote the last administrator');
  });
});
