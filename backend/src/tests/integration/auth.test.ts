/**
 * Sign-in & MFA for any application (integration, real PostgreSQL + headless
 * Chromium): login profiles, automatic sign-in forms (identifier-first with an
 * authenticator code, "don't ask again on this device", "stay signed in?"),
 * the encrypted session vault reused across runs, and persona matrices.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { totp } from '../../modules/salesforce/totp.js';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-auth-'));
const TOTP_KEY = 'JBSWY3DPEHPK3PXP';

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '4000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

// ---- a small identity provider and two applications ----
const USERS: Record<string, string> = { 'alice@example.com': 'alice-pw', 'carol@example.com': 'carol-pw', 'erin@example.com': 'erin-pw', bob: 'bob-pw' };
const sessions = new Map<string, string>();
const devices = new Set<string>();
const counts = { passwords: 0, mfaPrompts: 0, codesAccepted: 0 };
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const cookiesOf = (req: http.IncomingMessage) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
const body = (req: http.IncomingMessage) => new Promise<URLSearchParams>((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => resolve(new URLSearchParams(raw)));
});
const newSession = (user: string) => {
  const id = `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  sessions.set(id, user);
  return id;
};
const validCode = (code: string) => [-30_000, 0, 30_000].some((d) => totp(TOTP_KEY, Date.now() + d) === code);

async function idp(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const send = (status: number, page: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html', ...headers });
    res.end(page);
  };
  const redirect = (to: string, cookies: string[] = []) => {
    res.writeHead(302, { Location: to, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    res.end();
  };
  const c = cookiesOf(req);
  const user = sessions.get(c.sid ?? '');
  switch (`${req.method} ${url.pathname}`) {
    // Identifier first, then password, then (on a new device) an authenticator code, then "Stay signed in?"
    case 'GET /idp/login':
      return send(200, html('Sign in', `<h1>Sign in</h1><form method="post" action="/idp/login">
        <label for="u">Email or user name</label><input id="u" name="loginfmt" type="email" autocomplete="username">
        <button type="submit">Next</button></form>`));
    case 'POST /idp/login': {
      const b = await body(req);
      return send(200, html('Password', `<h1>Enter password</h1><form method="post" action="/idp/password">
        <input type="hidden" name="user" value="${b.get('loginfmt')}"><p>${b.get('loginfmt')}</p>
        <label for="p">Password</label><input id="p" name="passwd" type="password"><button type="submit">Sign in</button></form>`));
    }
    case 'POST /idp/password': {
      const b = await body(req);
      counts.passwords++;
      const u = String(b.get('user'));
      if (USERS[u] !== b.get('passwd')) return send(200, html('Password', '<h1>Enter password</h1><p class="error">Your account or password is incorrect.</p><input type="password" name="passwd">'));
      if (devices.has(c.device ?? '')) return send(200, kmsi(u));
      counts.mfaPrompts++;
      return send(200, html('Verify', `<h1>Enter code</h1><p>Enter the code displayed in your authenticator app</p>
        <form method="post" action="/idp/mfa"><input type="hidden" name="user" value="${u}">
        <input name="otc" autocomplete="one-time-code" inputmode="numeric" maxlength="6">
        <label><input type="checkbox" name="remember" value="1"> Don't ask again on this device</label>
        <button type="submit">Verify</button></form>`));
    }
    case 'POST /idp/mfa': {
      const b = await body(req);
      if (!validCode(String(b.get('otc')))) return send(200, html('Verify', '<p>That code is incorrect.</p><input name="otc" autocomplete="one-time-code">'));
      counts.codesAccepted++;
      const cookies: string[] = [];
      if (b.get('remember')) {
        const d = `d-${Math.random().toString(36).slice(2)}`;
        devices.add(d);
        cookies.push(`device=${d}; Path=/; Max-Age=31536000; HttpOnly`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
      return void res.end(kmsi(String(b.get('user'))));
    }
    case 'POST /idp/kmsi': {
      const b = await body(req);
      return redirect('/idp/home', [`sid=${newSession(String(b.get('user')))}; Path=/; HttpOnly`]);
    }
    case 'GET /idp/home':
      return user ? send(200, html('Home', `<h1>Welcome ${user}</h1><p id="who">${user}</p>`)) : redirect('/idp/login');
    // A plain one-page sign-in form
    case 'GET /simple/login':
      return send(200, html('Login', `<form method="post" action="/simple/login"><input name="username" placeholder="User">
        <input name="password" type="password" placeholder="Password"><input type="submit" value="Log in"></form>`));
    case 'POST /simple/login': {
      const b = await body(req);
      counts.passwords++;
      const u = String(b.get('username'));
      if (USERS[u] !== b.get('password')) return send(200, html('Login', '<p>Invalid username or password</p><input name="password" type="password">'));
      return redirect('/simple/home', [`sid=${newSession(u)}; Path=/; HttpOnly`]);
    }
    case 'GET /simple/home':
      return user ? send(200, html('Home', `<h1>Welcome ${user}</h1>`)) : redirect('/simple/login');
    default:
      return send(404, 'not found');
  }
}
const kmsi = (u: string) => html('Stay signed in?', `<h1>Stay signed in?</h1><form method="post" action="/idp/kmsi">
  <input type="hidden" name="user" value="${u}"><label><input type="checkbox" name="dontshow"> Don't show this again</label>
  <input type="submit" value="Yes"> <input type="button" value="No"></form>`);

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
async function newTest(title: string, steps: any[], data?: any): Promise<string> {
  const r = await call('POST', '/testcases', { title, module: 'Auth', priority: 'High', steps, expectedResults: ['ok'], ...(data ? { data } : {}) });
  assert.equal(r.status, 201, r.text);
  return r.data.id;
}
async function run(agentId: string, testIds: string[]): Promise<any> {
  const r = await call('POST', '/runs', { agentId, testIds, wait: true, timeoutSeconds: 120 });
  assert.ok([200, 202].includes(r.status), r.text);
  return (await call('GET', `/runs/${r.data.id}`)).data;
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
  fixture = http.createServer((req, res) => void idp(req, res, new URL(req.url || '/', 'http://x')));
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

describe('sign-in & MFA for any application (integration)', () => {
  it('signs in automatically with MFA, keeps the session across runs and remembers the device', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const created = await call('POST', '/agents', {
      name: 'Any SaaS',
      config: {
        base_url: base,
        evidence: { trace: 'off', video: 'off' },
        auth: {
          default_profile: 'alice',
          profiles: [
            { name: 'alice', login_url: '/idp/login', username: 'alice@example.com', password: 'alice-pw', totp_secret: TOTP_KEY, landing_path: '/idp/home' },
            { name: 'bob', login_url: '/simple/login', username: 'bob', password: 'bob-pw', landing_path: '/simple/home' },
            { name: 'carol', login_url: '/idp/login', username: 'carol@example.com', password: 'carol-pw', landing_path: '/idp/home' },
            { name: 'dave', login_url: '/simple/login', username: 'bob', password: 'wrong', landing_path: '/simple/home' },
          ],
        },
      },
    });
    assert.equal(created.status, 201, created.text);
    const agent = created.data.id;
    assert.equal(created.data.config.auth.profiles[0].password, '••••••••', 'secrets are never returned');
    assert.equal(created.data.config.auth.profiles[0].totp_secret, '••••••••');

    const home = await newTest('Home greets the user', [{ action: 'navigate', target: '/idp/home' }, { action: 'assert_text', target: 'h1', data: { value: 'Welcome alice@example.com' } }]);
    const again = await newTest('Home still greets the user', [{ action: 'navigate', target: '/idp/home' }, { action: 'assert_text', target: '#who', data: { value: 'alice@example.com' } }]);

    // Run 1: full sign-in (user name → password → authenticator code → stay signed in), then the saved session
    const r1 = await run(agent, [home, again]);
    for (const r of r1.results) assert.equal(r.status, 'passed', r.error);
    assert.equal(counts.passwords, 1, 'the second test reuses the session');
    assert.equal(counts.codesAccepted, 1);
    assert.match(r1.results[0].metadata.steps[0].message, /Signed in as alice \(alice@example.com\) with an authenticator code/);
    assert.match(r1.results[1].metadata.steps[0].message, /saved session/);

    // Run 2: no sign-in at all
    const r2 = await run(agent, [home]);
    assert.equal(r2.results[0].status, 'passed', r2.results[0].error);
    assert.equal(counts.passwords, 1);

    // The application ends the session: sign in again, but the device is remembered, so no MFA
    sessions.clear();
    const r3 = await run(agent, [home]);
    assert.equal(r3.results[0].status, 'passed', r3.results[0].error);
    assert.equal(counts.passwords, 2);
    assert.equal(counts.mfaPrompts, 1, 'no second verification code: "don\'t ask again on this device" was ticked');

    // Persona matrix across profiles, sentence form of the login step
    const matrix = await newTest('Everyone sees a greeting', [{ action: 'assert_text', target: 'h1', data: { value: 'Welcome' } }], { personas: ['alice', 'bob'] });
    const sentence = await newTest('Explicit login step', [{ action: 'Log in as bob' }, { action: 'assert_text', target: 'h1', data: { value: 'Welcome bob' } }], { login_as: false });
    const r4 = await run(agent, [matrix, sentence]);
    assert.deepEqual(r4.results.map((r: any) => [r.metadata.title, r.status]), [
      ['Everyone sees a greeting [as alice]', 'passed'], ['Everyone sees a greeting [as bob]', 'passed'], ['Explicit login step', 'passed'],
    ], JSON.stringify(r4.results.map((r: any) => r.error)));

    // No authenticator key on a new device; wrong password: clear errors, triaged as environment
    const noKey = await newTest('Carol needs MFA', [{ action: 'assert_text', target: 'h1', data: { value: 'Welcome' } }], { login_as: 'carol' });
    const wrong = await newTest('Dave has a wrong password', [{ action: 'assert_text', target: 'h1', data: { value: 'Welcome' } }], { login_as: 'dave' });
    const r5 = await run(agent, [noKey, wrong]);
    const byTitle = (title: string) => r5.results.find((r: any) => r.metadata.title === title);
    assert.match(byTitle('Carol needs MFA').error, /asked carol for a verification code\. Set the profile's authenticator \(TOTP\) key/);
    assert.match(byTitle('Dave has a wrong password').error, /Sign-in as dave failed: Invalid username or password/);
    assert.ok(r5.metadata.triage.groups.every((g: any) => g.category === 'environment'), JSON.stringify(r5.metadata.triage.groups));

    // Saved sessions, a manual check of a profile, forgetting
    const list = await call('GET', `/agents/${agent}/auth/sessions`);
    assert.deepEqual(list.data.map((s: any) => s.identity).sort(), ['alice', 'bob']);
    assert.ok(list.data.every((s: any) => !('state' in s)), 'the session contents never leave the server');
    const verify = await call('POST', `/agents/${agent}/auth/profiles/bob/verify`, { fresh: true });
    assert.equal(verify.data.ok, true, verify.text);
    assert.equal(verify.data.reused, false);
    assert.equal(verify.data.session.identity, 'bob');
    const bad = await call('POST', `/agents/${agent}/auth/profiles/carol/verify`, {});
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.error, /verification code/);

    // Changing a profile's user name forgets its session; other sessions stay
    const profiles = created.data.config.auth.profiles.map((p: any) => (p.name === 'bob' ? { ...p, username: 'bob2' } : p));
    const upd = await call('PUT', `/agents/${agent}`, { config: { auth: { default_profile: 'alice', profiles } } });
    assert.equal(upd.status, 200, upd.text);
    assert.deepEqual((await call('GET', `/agents/${agent}/auth/sessions`)).data.map((s: any) => s.identity), ['alice']);
    const forgot = await call('DELETE', `/agents/${agent}/auth/sessions?identity=alice`);
    assert.equal(forgot.data.forgotten, 1);

    const invalid = await call('PUT', `/agents/${agent}`, { config: { auth: { default_profile: 'zed', profiles } } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /default_profile "zed" is not a login profile/);
  });

  it('lets a person sign in once in the server browser (any MFA), then runs reuse that session', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    // Erin has no authenticator key stored: MFA can only be answered by a person (here: a code read from the phone)
    const created = await call('POST', '/agents', {
      name: 'Sign in once',
      config: { base_url: base, evidence: { trace: 'off', video: 'off' }, auth: { profiles: [
        { name: 'erin', login_url: '/idp/login', username: 'erin@example.com', password: 'erin-pw', landing_path: '/idp/home' },
      ] } },
    });
    const agent = created.data.id;
    const start = await call('POST', `/agents/${agent}/auth/interactive`, { kind: 'app', identity: 'erin' });
    assert.equal(start.status, 201, start.text);
    const sid = start.data.id;
    assert.deepEqual(start.data.canFill, { username: true, password: true, code: false });
    const input = async (body: any, status = 200) => {
      const r = await call('POST', `/auth/interactive/${sid}/input`, body);
      assert.equal(r.status, status, r.text);
      return r.data;
    };
    const shot = await fetch(`${apiUrl}/api/v1/auth/interactive/${sid}/screenshot`);
    assert.equal(shot.headers.get('content-type'), 'image/jpeg');

    // Saving before signing in is refused (unless forced)
    assert.equal((await call('POST', `/auth/interactive/${sid}/finish`, {})).status, 409);

    await input({ type: 'fill', what: 'username' });
    await input({ type: 'key', key: 'Enter' });
    await input({ type: 'fill', what: 'password' });
    await input({ type: 'key', key: 'Enter' });
    const mfa = await input({ type: 'fill', what: 'code' }, 400);
    assert.match(mfa.error, /no stored authenticator key/);
    // The person types the code from their phone
    await input({ type: 'key', key: 'Tab' });
    await input({ type: 'text', text: totp(TOTP_KEY) });
    await input({ type: 'key', key: 'Enter' });
    const kmsiPage = await input({ type: 'key', key: 'Tab' });
    assert.equal(kmsiPage.title, 'Stay signed in?');
    await input({ type: 'key', key: 'Tab' });
    await input({ type: 'key', key: 'Enter' });
    assert.equal((await call('POST', `/auth/interactive/${sid}/input`, { type: 'navigate', url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await call('POST', `/auth/interactive/${sid}/input`, { type: 'key', key: 'Control+W' })).status, 400);

    const done = await call('POST', `/auth/interactive/${sid}/finish`, {});
    assert.equal(done.status, 200, done.text);
    assert.equal(done.data.signedIn, true);
    assert.equal(done.data.session.capturedBy, 'interactive');
    assert.equal((await call('GET', `/auth/interactive/${sid}`)).status, 404, 'the browser is closed after saving');

    // Runs use the session: no automated sign-in (which would fail: erin has no authenticator key)
    const before = counts.passwords;
    const tc = await newTest('Erin sees her home', [{ action: 'assert_text', target: 'h1', data: { value: 'Welcome erin@example.com' } }], { login_as: 'erin' });
    const r = await run(agent, [tc]);
    assert.equal(r.results[0].status, 'passed', r.results[0].error);
    assert.match(r.results[0].metadata.steps[0].message, /saved session/);
    assert.equal(counts.passwords, before);

    // Closing without saving
    const other = await call('POST', `/agents/${agent}/auth/interactive`, { kind: 'app', identity: 'erin' });
    assert.equal((await call('DELETE', `/auth/interactive/${other.data.id}`)).status, 204);
    assert.equal((await call('POST', `/agents/${agent}/auth/interactive`, { kind: 'salesforce', identity: 'x' })).status, 400);
  });
});

