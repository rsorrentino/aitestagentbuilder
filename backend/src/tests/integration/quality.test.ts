/**
 * Quality extensions (integration, real PostgreSQL + headless Chromium):
 * accessibility checks, trace/video evidence with secret redaction, visual
 * regression with baselines and approval, and keeping AI-healed selectors.
 * The AI is a local fake of the GitHub Copilot CLI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import JSZip from 'jszip';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-quality-'));
const ARTIFACTS = join(workDir, 'artifacts');

// Fake Copilot CLI: answers selector-healing prompts with "#new-id" and counts its calls.
const isWindows = process.platform === 'win32';
const callsFile = join(workDir, 'copilot-calls.txt');
const fakeScript = isWindows ? join(workDir, 'node_modules', 'fake-copilot', 'index.js') : join(workDir, 'copilot');
const fakeCli = isWindows ? join(workDir, 'copilot.cmd') : fakeScript;
mkdirSync(dirname(fakeScript), { recursive: true });
writeFileSync(fakeScript, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, 'call\\n');
const prompt = process.argv[process.argv.indexOf('-p') + 1] || '';
if (prompt.includes('fix broken UI test selectors')) console.log('[{"selector": "#new-id"}]');
else console.log('[]');
`);
chmodSync(fakeScript, 0o755);
if (isWindows) writeFileSync(fakeCli, '@ECHO off\r\nSETLOCAL\r\nendLocal & "node" "%dp0%\\node_modules\\fake-copilot\\index.js" %*\r\n');
const copilotCalls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'false',
  ARTIFACTS_PATH: ARTIFACTS,
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '2500',
  COPILOT_MODE: 'cli',
  COPILOT_CLI_PATH: fakeCli,
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) {
  delete process.env[k];
}

// ---- application under test ----
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:0}main{padding:20px}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const PAGES: Record<string, (q: URLSearchParams) => string> = {
  '/good': () => page('Accessible page', '<p>Everything here has a name.</p><button type="button">Save</button>'),
  // Images without alt text, an unnamed button and an unlabeled input: serious/critical axe violations
  '/bad': () => `<!doctype html><html><head><title>Bad</title></head><body>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button></button><input type="text"></body></html>`,
  '/box': (q) => page('Box', `<div id="box" style="width:300px;height:120px;background:${q.get('color') === 'red' ? '#d00' : '#00d'}"></div>`),
  '/login': () => page('Login', '<label for="pw">Password</label><input id="pw" type="password"><button type="button">Go</button>'),
  // The button was "renamed": tests still use #old-id
  '/heal': () => page('Heal', '<button id="new-id" type="button" onclick="document.getElementById(\'out\').textContent=\'clicked\'">Continue</button><p id="out"></p>'),
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
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

async function newAgent(name: string, config: Record<string, any> = {}): Promise<string> {
  const res = await call('POST', '/api/v1/agents', { name, config: { base_url: fixtureUrl, ...config } });
  assert.equal(res.status, 201, res.text);
  return res.data.id;
}

async function newTest(title: string, steps: any[]): Promise<string> {
  const res = await call('POST', '/api/v1/testcases', { title, module: 'Quality', priority: 'High', steps, expectedResults: ['ok'] });
  assert.equal(res.status, 201, res.text);
  return res.data.id;
}

async function run(agentId: string, testIds: string[]): Promise<any> {
  const res = await call('POST', '/api/v1/runs', { agentId, testIds, wait: true, timeoutSeconds: 120 });
  assert.ok([200, 202].includes(res.status), res.text);
  return (await call('GET', `/api/v1/runs/${res.data.id}`)).data;
}

const artifact = (signedPath: string) => join(ARTIFACTS, ...signedPath.split('?')[0].split('/'));

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
    const url = new URL(req.url || '/', 'http://x');
    const render = PAGES[url.pathname];
    res.writeHead(render ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(render ? render(url.searchParams) : 'not found');
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
});

describe('quality extensions (integration)', () => {
  it('checks accessibility with axe-core, as a step and as an agent-wide scan', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('A11y', { evidence: { trace: 'off', video: 'off' } });
    const good = await newTest('Accessible page passes', [{ action: 'navigate', target: '/good' }, { action: 'assert_accessible' }]);
    const bad = await newTest('Inaccessible page fails', [{ action: 'navigate', target: '/bad' }, { action: 'Verify the page is accessible (WCAG)' }]);
    const ignored = await newTest('Known issues ignored', [
      { action: 'navigate', target: '/bad' },
      { action: 'assert_accessible', data: { ignore: ['image-alt', 'button-name', 'label', 'html-has-lang', 'document-title', 'landmark-one-main', 'page-has-heading-one', 'region'] } },
    ]);
    const r = await run(agent, [good, bad, ignored]);
    const by = (title: string) => r.results.find((x: any) => x.metadata.title === title);

    assert.equal(by('Accessible page passes').status, 'passed', by('Accessible page passes').error);
    const failed = by('Inaccessible page fails');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /accessibility violation\(s\) at serious\+ \(WCAG21AA\)/);
    const ids = failed.metadata.accessibility[0].violations.map((v: any) => v.id);
    for (const id of ['image-alt', 'button-name', 'label']) assert.ok(ids.includes(id), `expected ${id} in ${ids}`);
    assert.equal(by('Known issues ignored').status, 'passed', by('Known issues ignored').error);

    // Agent-wide scan of the last page of every test
    const strict = await newAgent('A11y strict', { checks: { accessibility: 'fail' }, evidence: { trace: 'off', video: 'off' } });
    const onlyNav = await newTest('Just open the bad page', [{ action: 'navigate', target: '/bad' }]);
    const r2 = await run(strict, [onlyNav]);
    assert.equal(r2.results[0].status, 'failed');
    assert.match(r2.results[0].error, /image-alt/);
  });

  it('keeps a redacted trace and a video of failed tests', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const secret = 'Sup3r-Secret-Value-42';
    const agent = await newAgent('Evidence', { secrets: { PASSWORD: secret } });
    const failing = await newTest('Fails after typing a secret', [
      { action: 'navigate', target: '/login' },
      { action: 'fill', target: '#pw', data: { value: '{{secrets.PASSWORD}}' } },
      { action: 'assert_text', data: { value: 'Welcome back' } },
    ]);
    const passing = await newTest('Passes without evidence', [{ action: 'navigate', target: '/good' }]);
    const r = await run(agent, [failing, passing]);
    const bad = r.results.find((x: any) => x.testCaseId === failing);
    const good = r.results.find((x: any) => x.testCaseId === passing);
    assert.equal(bad.status, 'failed');
    assert.match(bad.evidence.trace, /-trace\.zip\?exp=\d+&sig=/);
    assert.match(bad.evidence.video, /-video\.webm\?exp=\d+&sig=/);
    assert.ok(existsSync(artifact(bad.evidence.video)), 'video file stored');
    assert.equal(good.evidence.trace, undefined, 'no trace for passing tests by default');
    assert.equal(good.evidence.video, undefined);

    // The trace is a valid Playwright trace and the secret is masked everywhere in it
    const zip = await JSZip.loadAsync(readFileSync(artifact(bad.evidence.trace)));
    const names = Object.keys(zip.files);
    assert.ok(names.some((n) => n.endsWith('.trace')), `trace entries: ${names.join(', ')}`);
    let all = '';
    for (const n of names) if (!zip.files[n].dir) all += await zip.files[n].async('string');
    assert.ok(!all.includes(secret), 'secret must not appear in the trace');
    assert.ok(all.includes('••••'), 'masked value present');
    assert.ok(bad.metadata.traceRedactions >= 1);

    // The trace is served
    const served = await fetch(`${apiUrl}/artifacts/${bad.evidence.trace}`);
    assert.equal(served.status, 200);

    // "always" keeps evidence for passing tests too
    const always = await newAgent('Evidence always', { evidence: { trace: 'always', video: 'off' } });
    const r2 = await run(always, [passing]);
    assert.ok(r2.results[0].evidence.trace);
    assert.equal(r2.results[0].evidence.video, undefined);
  });

  it('compares screenshots with baselines and lets a reviewer approve a change', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Visual', { evidence: { trace: 'off', video: 'off' } });
    const blue = await newTest('Box is blue', [{ action: 'navigate', target: '/box?color=blue' }, { action: 'assert_screenshot', target: '#box', data: { name: 'box' } }]);
    const red = await newTest('Box turned red', [{ action: 'navigate', target: '/box?color=red' }, { action: 'Verify the box looks the same visually', target: '#box', data: { name: 'box' } }]);

    const first = await run(agent, [blue]);
    assert.equal(first.results[0].status, 'passed', first.results[0].error);
    assert.equal(first.results[0].metadata.visual[0].status, 'created');

    const second = await run(agent, [blue]);
    assert.equal(second.results[0].metadata.visual[0].status, 'passed');

    const changed = await run(agent, [red]);
    const res = changed.results[0];
    assert.equal(res.status, 'failed');
    assert.match(res.error, /differs from the baseline: \d+(\.\d+)?% of pixels/);
    const entry = res.metadata.visual[0];
    for (const key of ['baseline', 'actual', 'diff']) {
      assert.match(entry[key], /\.png\?exp=\d+&sig=/, key);
      assert.equal((await fetch(`${apiUrl}/artifacts/${entry[key]}`)).status, 200, `${key} image served`);
    }

    const list = await call('GET', `/api/v1/visual/baselines?agentId=${agent}`);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].name, 'box');
    assert.equal(list.data[0].viewport, '1280x800');

    // Only failed comparisons can be approved
    const wrong = await call('POST', `/api/v1/runs/${second.id}/results/${second.results[0].id}/visual/approve`, { name: 'box' });
    assert.equal(wrong.status, 400);
    const approved = await call('POST', `/api/v1/runs/${changed.id}/results/${res.id}/visual/approve`, { name: 'box' });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.data.sourceRunId, changed.id);

    const after = await run(agent, [red]);
    assert.equal(after.results[0].status, 'passed', after.results[0].error);
    assert.equal(after.results[0].metadata.visual[0].status, 'passed');
    const reloaded = (await call('GET', `/api/v1/runs/${changed.id}`)).data;
    assert.equal(reloaded.results[0].metadata.visual[0].approved, true);
  });

  it('reuses healed selectors within a run and writes them back to the test case', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    const agent = await newAgent('Healing', { ai: { self_healing: true, provider: 'copilot' }, evidence: { trace: 'off', video: 'off' } });
    const steps = [{ action: 'navigate', target: '/heal' }, { action: 'click', target: '#old-id' }, { action: 'assert_text', target: '#out', data: { value: 'clicked' } }];
    const one = await newTest('Heal me once', steps);
    const two = await newTest('Heal me twice', steps);

    const before = copilotCalls();
    const r = await run(agent, [one, two]);
    for (const res of r.results) assert.equal(res.status, 'passed', `${res.error}\n${(res.logs ?? []).join('\n')}\ncalls=${copilotCalls() - before}`);
    assert.equal(copilotCalls() - before, 1, 'the second test reuses the healed selector without calling the AI');
    const second = r.results.find((x: any) => x.testCaseId === two);
    assert.match(second.metadata.steps[1].message, /healed selector reused/);
    assert.deepEqual(second.metadata.healing.steps, [{ stepId: 2, from: '#old-id', to: '#new-id' }]);
    assert.equal(second.metadata.healing.applied, false);

    // Apply on request
    const firstResult = r.results.find((x: any) => x.testCaseId === one);
    const applied = await call('POST', `/api/v1/runs/${r.id}/results/${firstResult.id}/apply-healing`, {});
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(applied.data.applied, [{ stepId: 2, from: '#old-id', to: '#new-id' }]);
    assert.equal((await call('GET', `/api/v1/testcases/${one}`)).data.steps[1].target, '#new-id');
    const again = await call('POST', `/api/v1/runs/${r.id}/results/${firstResult.id}/apply-healing`, {});
    assert.equal(again.data.applied.length, 0, 'already applied: the step no longer has the broken selector');

    // Automatic write-back
    const auto = await newAgent('Healing auto', { ai: { self_healing: true, provider: 'copilot', auto_apply_healing: true }, evidence: { trace: 'off', video: 'off' } });
    const three = await newTest('Heal me automatically', steps);
    const r2 = await run(auto, [three]);
    assert.equal(r2.results[0].status, 'passed', r2.results[0].error);
    assert.equal(r2.results[0].metadata.healing.applied, true);
    assert.equal((await call('GET', `/api/v1/testcases/${three}`)).data.steps[1].target, '#new-id');
  });
});
