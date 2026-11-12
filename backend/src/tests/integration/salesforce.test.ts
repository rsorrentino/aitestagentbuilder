/**
 * Salesforce personas (integration): real PostgreSQL + headless browser
 * against the built-in Salesforce simulator (/demo/salesforce).
 *
 * Covers every login method — UI password, password + authenticator code
 * (TOTP), OAuth JWT bearer + frontdoor, OAuth username-password, and
 * "Log in as" — plus persona matrix runs with per-persona expectations for
 * object, field and record access, access-denied pages and identity checks.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { emailSource, startMailFixture } from './mail-fixture.js';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-sf-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'false',
  ARTIFACTS_PATH: join(workDir, 'artifacts'),
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '5000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER']) {
  delete process.env[k];
}

let api: Server;
let apiUrl = '';
let sfUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, body?: any): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

async function runAndWait(agentId: string, testIds: string[]): Promise<any> {
  const start = await call('POST', '/api/v1/runs', { agentId, testIds });
  assert.equal(start.status, 201, start.text);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { data } = await call('GET', `/api/v1/runs/${start.data.id}`);
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

  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { createApp } = await import('../../app.js');
  const { initializeWebSocket } = await import('../../infra/websocket/server.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  await runMigrations();
  api = http.createServer(createApp());
  const ws = initializeWebSocket(api);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  sfUrl = `${apiUrl}/demo/salesforce`;

  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    await ws.close();
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('Salesforce personas (integration)', () => {
  let agentId = '';
  const tests: Record<string, string> = {};

  it('stores personas with encrypted, redacted credentials', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const app = (await call('GET', '/demo/salesforce/_sim/connected-app')).data;

    const created = await call('POST', '/api/v1/agents', {
      name: 'Acme Salesforce',
      config: {
        base_url: sfUrl,
        salesforce: {
          login_url: sfUrl,
          instance_url: sfUrl,
          api_persona: 'admin',
          connected_app: app,
          personas: [
            { name: 'admin', auth_method: 'jwt', username: 'admin@acme.sim', expected_profile: 'System Administrator' },
            { name: 'rep', auth_method: 'password_totp', username: 'rep@acme.sim', password: 'Rep-Pass-1!', totp_secret: 'JBSWY3DPEHPK3PXP', expected_profile: 'Standard User', expected_permission_sets: ['Sales_Ops'] },
            { name: 'viewer', auth_method: 'password', username: 'viewer@acme.sim', password: 'Viewer-Pass-1!', expected_profile: 'Read Only' },
            { name: 'rep_login_as', auth_method: 'login_as', username: 'rep@acme.sim', login_as_via: 'admin' },
            { name: 'viewer_api', auth_method: 'oauth_password', username: 'viewer@acme.sim', password: 'Viewer-Pass-1!', security_token: 'VWRTOKEN' },
            { name: 'admin_ui', auth_method: 'password_totp', username: 'admin@acme.sim', password: 'Admin-Pass-1!', totp_secret: 'KRSXG5CTMVRXEZLU' },
          ],
        },
      },
    });
    assert.equal(created.status, 201, created.text);
    agentId = created.data.id;

    for (const secret of ['Rep-Pass-1!', 'JBSWY3DPEHPK3PXP', 'VWRTOKEN', 'BEGIN PRIVATE KEY', app.client_secret]) {
      assert.ok(!created.text.includes(secret), `API response leaks ${secret}`);
    }
    const sf = created.data.config.salesforce;
    assert.equal(sf.personas[1].password, '••••••••');
    assert.equal(sf.connected_app.private_key, '••••••••');
    assert.equal(sf.connected_app.client_id, app.client_id);

    // Encrypted at rest
    const { default: getDatabaseClient } = await import('../../infra/db/client.js');
    const row = await getDatabaseClient().query('SELECT config FROM agents WHERE id = $1', [agentId]);
    const stored = JSON.stringify(row.rows[0].config);
    assert.ok(!stored.includes('Rep-Pass-1!') && !stored.includes('BEGIN PRIVATE KEY'));
    assert.match(row.rows[0].config.salesforce.personas[1].password, /^enc:v1:/);

    // Saving the redacted config back keeps the stored secrets
    const resave = await call('PUT', `/api/v1/agents/${agentId}`, { config: created.data.config });
    assert.equal(resave.status, 200, resave.text);

    // Validation
    const dup = await call('PUT', `/api/v1/agents/${agentId}`, {
      config: { ...created.data.config, salesforce: { ...sf, personas: [sf.personas[0], { ...sf.personas[0] }] } },
    });
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /Duplicate persona/);
    const badVia = await call('PUT', `/api/v1/agents/${agentId}`, {
      config: { ...created.data.config, salesforce: { ...sf, personas: [{ name: 'x', auth_method: 'login_as', username: 'a@b.c', login_as_via: 'nobody' }] } },
    });
    assert.equal(badVia.status, 400);
  });

  it('verifies each persona: who Salesforce says it is', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const verify = (name: string) => call('POST', `/api/v1/agents/${agentId}/salesforce/personas/${name}/verify`);

    const admin = await verify('admin');
    assert.equal(admin.data.ok, true, admin.text);
    assert.match(admin.data.message, /JWT bearer/);
    assert.equal(admin.data.identity.profile, 'System Administrator');

    const rep = await verify('rep');
    assert.equal(rep.data.ok, true, rep.text);
    assert.match(rep.data.message, /TOTP/);
    assert.deepEqual(rep.data.identity.permissionSets, ['Sales_Ops']);

    const viewer = await verify('viewer');
    assert.equal(viewer.data.ok, true, viewer.text);
    assert.equal(viewer.data.identity.profile, 'Read Only');

    const loginAs = await verify('rep_login_as');
    assert.equal(loginAs.data.ok, true, loginAs.text);
    assert.match(loginAs.data.message, /Log in as/);
    assert.equal(loginAs.data.identity.username, 'rep@acme.sim');
    assert.equal(loginAs.data.identity.via, 'admin');

    const viewerApi = await verify('viewer_api');
    assert.equal(viewerApi.data.ok, true, viewerApi.text);
    assert.match(viewerApi.data.message, /username-password/);

    // Administrators cannot use authenticator-app codes in the UI: the error says why
    const adminUi = await verify('admin_ui');
    assert.equal(adminUi.data.ok, false);
    assert.match(adminUi.data.error, /phishing-resistant/);
    assert.ok(!adminUi.text.includes('Admin-Pass-1!'));

    const unknown = await verify('nobody');
    assert.equal(unknown.status, 404);
  });

  it('runs one test as several personas with per-persona expectations', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const matrix = await call('POST', '/api/v1/testcases', {
      title: 'Opportunity security',
      module: 'Security',
      priority: 'Critical',
      data: { personas: ['admin', 'rep', 'viewer'] },
      steps: [
        { action: 'assert_profile', data: { by_persona: {
          admin: { profile: 'System Administrator' },
          rep: { profile: 'Standard User', permission_sets: ['Sales_Ops'] },
          viewer: { profile: 'Read Only', not_permission_sets: ['Sales_Ops'] },
        } } },
        { action: 'assert_object_access', target: 'Opportunity', data: { by_persona: {
          admin: { read: true, create: true, edit: true, delete: true },
          rep: { read: true, create: true, edit: true, delete: false },
          viewer: { read: true, create: false, edit: false, delete: false },
        } } },
        { action: 'assert_object_access', target: 'Employee__c', data: { by_persona: { admin: { read: true }, default: { read: false } } } },
        { action: 'assert_field_access', target: 'Account.AnnualRevenue', data: { by_persona: {
          admin: { read: true, edit: true }, rep: { read: true, edit: false }, viewer: { read: false },
        } } },
        { action: 'assert_record_access', target: '006SIM000000001AAA', data: { by_persona: {
          admin: { read: true, edit: true, delete: true }, rep: { read: true, edit: true, delete: false }, viewer: { read: false, edit: false },
        } } },
        { action: 'navigate', target: 'lightning/r/Opportunity/006SIM000000001AAA/view' },
        { action: 'assert_visible', target: 'button[name="Edit"]', data: { only_personas: ['admin', 'rep'] } },
        { action: 'assert_not_visible', target: 'button[name="Delete"]', data: { only_personas: ['rep'] } },
        { action: 'assert_access_denied', data: { only_personas: ['viewer'] } },
        { action: 'Verify access denied', target: 'lightning/setup/SetupOneHome/home', data: { skip_personas: ['admin'] } },
        { action: 'navigate', target: 'lightning/page/home' },
        { action: 'assert_text', target: '#profile-name', data: { by_persona: { admin: { value: 'System Administrator' }, rep: { value: 'Standard User' }, viewer: { value: 'Read Only' } } } },
      ],
      expectedResults: ['Each persona sees exactly what its profile and permission sets allow'],
    });
    assert.equal(matrix.status, 201, matrix.text);
    tests.matrix = matrix.data.id;

    const again = await call('POST', '/api/v1/testcases', {
      title: 'Rep sees own accounts', module: 'Security', priority: 'High',
      data: { personas: 'rep' },
      steps: [{ action: 'navigate', target: 'lightning/o/Account/list' }, { action: 'assert_text', data: { value: 'Acme Corp' } }],
      expectedResults: ['Account list'],
    });
    tests.reuse = again.data.id;

    const run = await runAndWait(agentId, [tests.matrix, tests.reuse]);
    const summary = run.results.map((r: any) => `${r.metadata.title}: ${r.status} ${r.error ?? ''}`).join('\n');
    assert.equal(run.status, 'completed', summary);
    assert.equal(run.results.length, 4, summary);
    assert.deepEqual(run.results.map((r: any) => r.metadata.persona).sort(), ['admin', 'rep', 'rep', 'viewer']);
    assert.ok(run.results.some((r: any) => r.metadata.title === 'Opportunity security [as viewer]'));
    assert.equal(run.totalTests, 4);
    assert.equal(run.passedTests, 4);

    const viewerResult = run.results.find((r: any) => r.metadata.persona === 'viewer');
    const skipped = viewerResult.metadata.steps.filter((s: any) => s.status === 'skipped').map((s: any) => s.message);
    assert.ok(skipped.every((m: string) => /Not for persona viewer/.test(m)));
    assert.equal(skipped.length, 2);

    // Second rep test reused the browser session (no second MFA)
    const reuse = run.results.find((r: any) => r.metadata.title === 'Rep sees own accounts [as rep]');
    assert.match(reuse.metadata.steps[0].message, /reused session/);

    const all = JSON.stringify(run.results);
    for (const secret of ['Rep-Pass-1!', 'Viewer-Pass-1!', 'JBSWY3DPEHPK3PXP']) assert.ok(!all.includes(secret));

    // The next run starts from the session saved (encrypted) by this one: no new login, no MFA
    const saved = await call('GET', `/api/v1/agents/${agentId}/auth/sessions`);
    assert.ok(saved.data.some((x: any) => x.kind === 'salesforce' && x.identity === 'rep' && !x.expired), saved.text);
    const next = await runAndWait(agentId, [tests.reuse]);
    assert.equal(next.results[0].status, 'passed', next.results[0].error);
    assert.match(next.results[0].metadata.steps[0].message, /reused session/);
  });

  it('"Log in as" personas are checked through the admin API', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const tc = await call('POST', '/api/v1/testcases', {
      title: 'Support impersonation', module: 'Security', priority: 'High',
      data: { personas: ['rep_login_as'] },
      steps: [
        { action: 'assert_visible', target: '#login-as-banner' },
        { action: 'assert_profile', target: 'Standard User', data: { permission_sets: 'Sales_Ops' } },
        { action: 'assert_object_access', target: 'Opportunity', data: { read: true, edit: true, delete: false } },
        { action: 'assert_field_access', target: 'Account.AnnualRevenue', data: { read: true, edit: false } },
        { action: 'assert_record_access', target: '006SIM000000002AAA', data: { read: false } },
        { action: 'salesforce_logout' },
        { action: 'assert_text', target: '.user-name', data: { value: 'Ada Admin' } },
      ],
      expectedResults: ['Impersonated session behaves like the rep'],
    });
    const run = await runAndWait(agentId, [tc.data.id]);
    const r = run.results[0];
    assert.equal(r.status, 'passed', `${r.error}\n${r.logs?.join('\n')}`);
    assert.match(r.metadata.steps.find((s: any) => s.action === 'assert_object_access').message, /checked via admin API/);
  });

  it('a wrong permission expectation fails with a readable reason', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const tc = await call('POST', '/api/v1/testcases', {
      title: 'Rep may delete opportunities (wrong on purpose)', module: 'Security', priority: 'Low',
      data: { personas: ['rep'] },
      steps: [{ action: 'assert_object_access', target: 'Opportunity', data: { delete: true } }],
      expectedResults: ['fails'],
    });
    const run = await runAndWait(agentId, [tc.data.id]);
    assert.equal(run.status, 'failed');
    assert.match(run.results[0].error, /Unexpected access to Opportunity for rep: delete is denied \(expected allowed\)/);
  });

  it('an unknown persona or misconfigured persona fails the test, not the run', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const tc = await call('POST', '/api/v1/testcases', {
      title: 'Ghost persona', module: 'Security', priority: 'Low',
      data: { personas: ['ghost'] },
      steps: [{ action: 'navigate', target: 'lightning/page/home' }],
      expectedResults: ['fails'],
    });
    const run = await runAndWait(agentId, [tc.data.id]);
    assert.equal(run.status, 'failed');
    assert.match(run.results[0].error, /Unknown Salesforce persona "ghost"/);
  });

  it('answers Salesforce\'s emailed "Verify your identity" code from a mailbox, then trusts the browser', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const mail = await startMailFixture();
    const { setSimulatorMailer } = await import('../../demo/salesforce-simulator.js');
    setSimulatorMailer((m) => mail.sendEmail(m.to, m.subject, m.text));
    try {
      const created = await call('POST', '/api/v1/agents', {
        name: 'Acme ops',
        config: {
          base_url: sfUrl,
          evidence: { trace: 'off', video: 'off' },
          code_sources: [emailSource(mail.imapPort, 'sf_inbox')],
          salesforce: { login_url: sfUrl, instance_url: sfUrl, personas: [
            { name: 'ops', auth_method: 'password', username: 'ops@acme.sim', password: 'Ops-Pass-1!', codes: { source: 'sf_inbox', to: 'ops@acme.sim' } },
          ] },
        },
      });
      assert.equal(created.status, 201, created.text);
      const agent = created.data.id;
      const tc = await call('POST', '/api/v1/testcases', {
        title: 'Ops sees the home page', module: 'Security', priority: 'High', data: { personas: 'ops' },
        steps: [{ action: 'navigate', target: 'lightning/page/home' }, { action: 'assert_text', target: '#profile-name', data: { value: 'Standard User' } }],
        expectedResults: ['home'],
      });
      const first = await runAndWait(agent, [tc.data.id]);
      assert.equal(first.results[0].status, 'passed', first.results[0].error);
      assert.match(first.results[0].metadata.steps[0].message, /username\/password \+ emailed verification code/);

      // Next run: the saved session (with the device cookie) is reused
      const second = await runAndWait(agent, [tc.data.id]);
      assert.equal(second.results[0].status, 'passed', second.results[0].error);
      assert.match(second.results[0].metadata.steps[0].message, /reused session/);

      // A fresh login from a new browser (persona check) is verified by email too
      const verify = await call('POST', `/api/v1/agents/${agent}/salesforce/personas/ops/verify`);
      assert.equal(verify.data.ok, true, verify.text);
      assert.match(verify.data.message, /emailed verification code/);
    } finally {
      setSimulatorMailer(() => undefined);
      await mail.close();
    }
  });
});

