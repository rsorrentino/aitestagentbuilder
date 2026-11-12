/**
 * GitLab and Azure DevOps integrations (integration, real PostgreSQL + headless Chromium,
 * fake GitLab v4 and Azure DevOps 7.1 REST APIs): webhooks / service hooks start runs for
 * merge / pull requests and deployments, commit statuses, one merge request note / pull
 * request thread per agent, bugs filed (screenshot uploaded) and resolved as GitLab issues
 * and Azure work items, results on linked work items, CI templates.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const workDir = mkdtempSync(join(tmpdir(), 'atab-gitlab-azure-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, AUTH_ENABLED: 'false', ARTIFACTS_PATH: join(workDir, 'artifacts'), LOG_TO_FILE: 'false', STEP_TIMEOUT_MS: '2500',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_MODE', 'LLM_PROVIDER', 'EVIDENCE_TRACE', 'EVIDENCE_VIDEO']) delete process.env[k];

const SECRET = 'hook-secret-0123456789abc';
let cartBroken = true;
const shop = (broken: () => boolean) => http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Shop</title><h1>Cart</h1><p id="total">${broken() ? 'NaN' : '42.00'}</p>`);
});

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
const json = (res: http.ServerResponse, status: number, body?: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

// ---- fake GitLab (project acme/shop, id 42) ----
const gl = {
  statuses: [] as any[], issues: new Map<number, any>(), notes: [] as Array<{ id: number; kind: string; iid: number; body: string }>, uploads: 0, next: 100,
};
async function fakeGitLab(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers['private-token'] !== 'glpat-fake') return json(res, 401, { message: '401 Unauthorized' });
  const raw = await readBody(req);
  const body = (req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw.toString()) : undefined;
  const p = (req.url ?? '').split('?')[0].replace('/api/v4', '').replace('/projects/acme%2Fshop', '/P');
  let m: RegExpMatchArray | null;
  if (p === '/user') return json(res, 200, { username: 'qa-bot' });
  if (p === '/P') return json(res, 200, { id: 42, path_with_namespace: 'acme/shop' });
  if ((m = p.match(/^\/P\/statuses\/(\w+)$/))) { gl.statuses.push({ sha: m[1], ...body }); return json(res, 201, {}); }
  if (p === '/P/uploads') { gl.uploads++; return json(res, 201, { markdown: `![failure](/uploads/x/failure.png)`, size: raw.length }); }
  if (p === '/P/issues' && req.method === 'POST') {
    const iid = gl.next++;
    gl.issues.set(iid, { iid, ...body, state: 'opened', web_url: `https://gitlab.test/acme/shop/-/issues/${iid}` });
    return json(res, 201, gl.issues.get(iid));
  }
  if ((m = p.match(/^\/P\/issues\/(\d+)$/))) {
    const issue = gl.issues.get(Number(m[1]));
    if (!issue) return json(res, 404, { message: '404 Not found' });
    if (req.method === 'PUT' && body.state_event === 'close') issue.state = 'closed';
    return json(res, 200, issue);
  }
  if ((m = p.match(/^\/P\/(issues|merge_requests)\/(\d+)\/notes$/))) {
    const [kind, iid] = [m[1], Number(m[2])];
    if (req.method === 'GET') return json(res, 200, gl.notes.filter((n) => n.kind === kind && n.iid === iid));
    const note = { id: gl.next++, kind, iid, body: body.body };
    gl.notes.push(note);
    return json(res, 201, note);
  }
  if ((m = p.match(/^\/P\/(issues|merge_requests)\/(\d+)\/notes\/(\d+)$/))) {
    const note = gl.notes.find((n) => n.id === Number(m![3]))!;
    note.body = body.body;
    return json(res, 200, note);
  }
  json(res, 404, { message: `No route ${req.method} ${p}` });
}

// ---- fake Azure DevOps (organization acme, project Shop, repository shop-web) ----
const az = {
  statuses: [] as any[], items: new Map<number, any>(), comments: [] as Array<{ id: number; item: number; text: string }>,
  threads: [] as Array<{ id: number; pr: number; comments: Array<{ id: number; content: string }> }>, attachments: 0, next: 500,
};
az.items.set(7, { id: 7, fields: { 'System.Title': 'Cart shows the order total', 'System.State': 'Active', 'System.WorkItemType': 'User Story', 'System.Description': '<div>As a shopper</div>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>total is 42.00</li></ul>' } });
async function fakeAzure(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.authorization !== `Basic ${Buffer.from(':azpat-fake').toString('base64')}`) { res.writeHead(302, { Location: '/_signin' }); return res.end(); }
  const raw = await readBody(req);
  const body = (req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw.toString()) : undefined;
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  if (p === '/acme/_apis/projects/Shop') return json(res, 200, { name: 'Shop' });
  if (p === '/acme/_apis/connectionData') return json(res, 200, { authenticatedUser: { providerDisplayName: 'QA Bot' } });
  if (p === '/acme/Shop/_apis/git/repositories/shop-web') return json(res, 200, { name: 'shop-web' });
  if ((m = p.match(/^\/acme\/Shop\/_apis\/git\/repositories\/shop-web\/commits\/(\w+)\/statuses$/))) { az.statuses.push({ sha: m[1], ...body }); return json(res, 201, {}); }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/git\/repositories\/shop-web\/pullRequests\/(\d+)\/threads$/))) {
    const pr = Number(m[1]);
    if (req.method === 'GET') return json(res, 200, { value: az.threads.filter((t) => t.pr === pr) });
    const t = { id: az.next++, pr, comments: [{ id: 1, content: body.comments[0].content }] };
    az.threads.push(t);
    return json(res, 200, t);
  }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/git\/repositories\/shop-web\/pullRequests\/\d+\/threads\/(\d+)\/comments\/1$/))) {
    az.threads.find((t) => t.id === Number(m![1]))!.comments[0].content = body.content;
    return json(res, 200, {});
  }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/wit\/workitems\/\$(\w+)$/))) {
    assert.equal(req.headers['content-type'], 'application/json-patch+json');
    const id = az.next++;
    const fields: any = { 'System.WorkItemType': m[1], 'System.State': 'New' };
    for (const op of body) fields[op.path.replace('/fields/', '')] = op.value;
    az.items.set(id, { id, fields, relations: [] });
    return json(res, 200, az.items.get(id));
  }
  if (p === '/acme/Shop/_apis/wit/workitems' && url.searchParams.get('ids')) {
    return json(res, 200, { value: url.searchParams.get('ids')!.split(',').map((id) => az.items.get(Number(id))).filter(Boolean) });
  }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/wit\/workitems\/(\d+)$/))) {
    const item = az.items.get(Number(m[1]));
    if (!item) return json(res, 404, { message: 'TF401232: Work item does not exist' });
    if (req.method === 'PATCH') {
      for (const op of body) {
        if (op.path === '/fields/System.State') {
          if (!['Resolved', 'Closed'].includes(op.value)) return json(res, 400, { message: `State ${op.value} is not allowed` });
          item.fields['System.State'] = op.value;
        } else if (op.path === '/relations/-') item.relations.push(op.value);
      }
    }
    return json(res, 200, item);
  }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/wit\/workItems\/(\d+)\/comments$/))) {
    const item = Number(m[1]);
    if (req.method === 'GET') return json(res, 200, { comments: az.comments.filter((c) => c.item === item) });
    const c = { id: az.next++, item, text: body.text };
    az.comments.push(c);
    return json(res, 200, c);
  }
  if ((m = p.match(/^\/acme\/Shop\/_apis\/wit\/workItems\/\d+\/comments\/(\d+)$/))) {
    az.comments.find((c) => c.id === Number(m![1]))!.text = body.text;
    return json(res, 200, {});
  }
  if (p === '/acme/Shop/_apis/wit/attachments') { az.attachments++; return json(res, 201, { url: 'https://dev.azure.test/acme/_apis/wit/attachments/abc' }); }
  if (p === '/acme/Shop/_apis/wit/wiql') {
    const words = String(body.query).match(/CONTAINS '([^']*)'/)?.[1] ?? '';
    return json(res, 200, { workItems: [...az.items.values()].filter((i) => i.fields['System.Title'].toLowerCase().includes(words.toLowerCase())).map((i) => ({ id: i.id })) });
  }
  json(res, 404, { message: `No route ${req.method} ${p}` });
}

let servers: Server[] = [];
let base = '';
let previewUrl = '';
let glUrl = '';
let azUrl = '';
let apiUrl = '';
let dbAvailable = false;
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, data?: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${apiUrl}/api/v1${path}`, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data !== undefined ? JSON.stringify(data) : undefined });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text };
}
async function finished(runId: string): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const run = (await call('GET', `/runs/${runId}`)).data;
    if (!['pending', 'running'].includes(run.status) && run.metadata?.integrations) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Run ${runId} did not finish`);
}
const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); servers.push(s); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

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
  base = await listen(shop(() => cartBroken));
  previewUrl = await listen(shop(() => false));
  glUrl = await listen(http.createServer((q, s) => void fakeGitLab(q, s)));
  azUrl = await listen(http.createServer((q, s) => void fakeAzure(q, s)));
  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { createApp } = await import('../../app.js');
  const { initializeWebSocket } = await import('../../infra/websocket/server.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  await runMigrations();
  const api = http.createServer(createApp());
  const ws = initializeWebSocket(api);
  apiUrl = await listen(api);
  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    await ws.close();
    for (const s of servers) s.closeAllConnections();
    for (const s of servers) await new Promise((r) => s.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('GitLab and Azure DevOps integrations (integration)', () => {
  let agentId = '';
  let testId = '';

  it('GitLab: merge requests and review apps are tested; statuses, one note, issues with screenshots', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    agentId = (await call('POST', '/agents', { name: 'Shop', config: { base_url: base, evidence: { trace: 'off', video: 'off' }, unattended: { rerun_failed: false } } })).data.id;
    testId = (await call('POST', '/testcases', {
      title: 'Cart shows the order total', module: 'Cart', priority: 'High', expectedResults: ['42.00'],
      steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#total', data: { value: '42.00' } }],
    })).data.id;
    const created = await call('POST', '/integrations', {
      type: 'gitlab', name: 'Shop on GitLab',
      config: {
        project: 'acme/shop', token: 'glpat-fake', base_url: glUrl, webhook_secret: SECRET, defects: { enabled: true },
        triggers: [{ event: 'pull_request', agent_id: agentId, branches: ['main'] }, { event: 'deployment_status', agent_id: agentId, environments: ['review/*'], use_deployment_url: true }],
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.config.token, '••••••••');
    const id = created.data.id;
    assert.deepEqual((await call('POST', `/integrations/${id}/check`)).data, { ok: true, account: 'qa-bot', details: 'project acme/shop' });

    const hook = (event: string, payload: any, token = SECRET) => call('POST', `/hooks/gitlab/${id}`, payload, { 'X-Gitlab-Event': event, 'X-Gitlab-Token': token, 'X-Gitlab-Event-UUID': `u-${Math.random()}` });
    const project = { id: 42, path_with_namespace: 'acme/shop' };
    const mr = (action: string, sha: string, extra: any = {}) => ({
      object_kind: 'merge_request', project, user: { username: 'dev' },
      object_attributes: { iid: 3, action, state: 'opened', title: 'Fix cart', source_branch: 'fix-cart', target_branch: 'main', last_commit: { id: sha }, ...extra },
    });
    assert.equal((await hook('Merge Request Hook', mr('open', 'g1'), 'wrong-secret-0123456789')).status, 401);
    assert.match((await hook('Merge Request Hook', mr('update', 'g1'))).data.ignored, /Nothing to test for Merge Request Hook \(update\)/, 'title edits do not run tests');
    assert.equal((await call('POST', `/hooks/github/${id}`, {}, { 'X-GitHub-Event': 'ping' })).status, 404, 'a GitLab integration is not a GitHub webhook');

    const opened = await hook('Merge Request Hook', mr('open', 'aaa111'));
    assert.equal(opened.status, 202, opened.text);
    const run1 = await finished(opened.data.runs[0].runId);
    assert.equal(run1.status, 'failed');
    assert.deepEqual([run1.metadata.git.provider, run1.metadata.git.pr], ['gitlab', 3]);
    assert.deepEqual(gl.statuses.filter((s) => s.sha === 'aaa111').map((s) => [s.state, s.name]), [['running', 'AI tests / Shop'], ['failed', 'AI tests / Shop']]);
    const mrNotes = () => gl.notes.filter((n) => n.kind === 'merge_requests' && n.iid === 3);
    assert.equal(mrNotes().length, 1);
    assert.match(mrNotes()[0].body, /### ❌ AI tests failed: Shop/);
    assert.match(run1.metadata.integrations[0].comment, /\/acme\/shop\/-\/merge_requests\/3#note_\d+$/);
    const bug = gl.issues.get(100);
    assert.match(bug.title, /^\[Automated test\] Shop: Expected #total/);
    assert.match(bug.labels, /^atab,atab-[0-9a-f]{10}$/);
    assert.equal(gl.uploads, 1);
    assert.ok(gl.notes.some((n) => n.kind === 'issues' && n.iid === 100 && n.body.includes('![failure](/uploads/x/failure.png)')));

    cartBroken = false;
    const pushed = await hook('Merge Request Hook', mr('update', 'bbb222', { oldrev: 'aaa111' }));
    const run2 = await finished(pushed.data.runs[0].runId);
    assert.equal(run2.status, 'completed');
    assert.deepEqual(gl.statuses.filter((s) => s.sha === 'bbb222').map((s) => s.state), ['running', 'success']);
    assert.equal(mrNotes().length, 1, 'edited, not added');
    assert.match(mrNotes()[0].body, /### ✅ AI tests passed: Shop/);
    assert.equal(bug.state, 'closed');
    assert.ok(gl.notes.some((n) => n.iid === 100 && /Passing again/.test(n.body)));

    const deployed = await hook('Deployment Hook', { object_kind: 'deployment', project, status: 'success', sha: 'ccc333', ref: 'fix-cart', environment: 'review/fix-cart', environment_external_url: previewUrl });
    const run3 = await finished(deployed.data.runs[0].runId);
    assert.equal(run3.metadata.baseUrl, previewUrl);
    assert.deepEqual(gl.statuses.filter((s) => s.sha === 'ccc333').map((s) => s.state), ['running', 'success']);

    const ci = await call('GET', `/integrations/${id}/workflow?agentId=${agentId}&apiUrl=https://atab.example.com/api/v1`);
    assert.equal(ci.data.path, '.gitlab-ci.yml');
    const YAML = (await import('yaml')).default;
    const job = YAML.parse(ci.data.yaml)['ai-tests'];
    assert.equal(job.variables.ATAB_AGENT, agentId);
    assert.equal(job.artifacts.reports.junit, 'ai-tests-junit.xml');
    assert.match(job.script[0], /PR="\$\{CI_MERGE_REQUEST_IID:-\}"/);

    // Hand over to Azure DevOps for the next test
    await call('PUT', `/integrations/${id}`, { enabled: false });
  });

  it('Azure DevOps: pull requests are tested; statuses, one thread, work items resolved, results on stories', async (t) => {
    if (!dbAvailable) return t.skip('database not available');
    cartBroken = true;
    const config = {
      organization_url: `${azUrl}/acme`, project: 'Shop', pat: 'azpat-fake', repository: 'shop-web', webhook_secret: SECRET,
      triggers: [{ event: 'pull_request', agent_id: agentId, branches: ['main'] }], defects: { enabled: true },
    };
    const bad = await call('POST', '/integrations', { type: 'azure_devops', name: 'Azure', config: { ...config, repository: '', triggers: [{ event: 'deployment_status', agent_id: agentId }] } });
    assert.match(bad.data.error, /repository \(the Azure Repos repository\) is required for triggers; .*supports push and pull_request triggers/);
    const created = await call('POST', '/integrations', { type: 'azure_devops', name: 'Shop on Azure', config });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.data.config.pat, '••••••••');
    const id = created.data.id;
    assert.deepEqual((await call('POST', `/integrations/${id}/check`)).data, { ok: true, account: 'QA Bot', details: 'project Shop, repository shop-web' });

    const hook = (payload: any, headers: Record<string, string> = { 'X-ATAB-Token': SECRET }) => call('POST', `/hooks/azure/${id}`, payload, headers);
    const pr = (eventType: string, sha: string, message = '') => ({
      id: `n-${Math.random()}`, eventType, message: { text: message },
      resource: { pullRequestId: 21, status: 'active', title: 'Fix cart', sourceRefName: 'refs/heads/fix-cart', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: sha }, repository: { id: 'r-1', name: 'shop-web' } },
    });
    assert.equal((await hook(pr('git.pullrequest.created', 'x'), { 'X-ATAB-Token': 'nope-nope-nope-nope' })).status, 401);
    assert.match((await hook(pr('git.pullrequest.updated', 'x', 'Dev approved pull request 21'))).data.ignored, /Nothing to test/);
    assert.match((await hook({ ...pr('git.pullrequest.created', 'x'), resource: { ...pr('', 'x').resource, repository: { name: 'Fabrikam-Fiber-Git' } } })).data.ignored, /for Fabrikam-Fiber-Git/, 'the service hook "Test" sample');

    const basic = `Basic ${Buffer.from(`atab:${SECRET}`).toString('base64')}`;
    const opened = await hook(pr('git.pullrequest.created', 'az1'), { Authorization: basic });
    assert.equal(opened.status, 202, opened.text);
    const run1 = await finished(opened.data.runs[0].runId);
    assert.equal(run1.status, 'failed');
    assert.deepEqual(az.statuses.filter((s) => s.sha === 'az1').map((s) => [s.state, s.context.genre, s.context.name]), [['pending', 'AI tests', 'Shop'], ['failed', 'AI tests', 'Shop']]);
    assert.equal(az.threads.length, 1);
    assert.match(az.threads[0].comments[0].content, /### ❌ AI tests failed: Shop/);
    const bugId = run1.metadata.integrations[0].filed[0].key.slice(1);
    const bug = az.items.get(Number(bugId));
    assert.equal(bug.fields['System.WorkItemType'], 'Bug');
    assert.match(bug.fields['Microsoft.VSTS.TCM.ReproSteps'], /^<p>Found by AI Test Agent Builder in run .*<a href="http:\/\/localhost:4000\/runs\//);
    assert.match(bug.fields['System.Tags'], /^atab; atab-[0-9a-f]{10}$/);
    assert.equal(az.attachments, 1);
    assert.equal(bug.relations[0].rel, 'AttachedFile');

    cartBroken = false;
    const updated = await hook(pr('git.pullrequest.updated', 'az2', 'Dev updated the source branch of pull request 21'));
    const run2 = await finished(updated.data.runs[0].runId);
    assert.equal(run2.status, 'completed');
    assert.deepEqual(az.statuses.filter((s) => s.sha === 'az2').map((s) => s.state), ['pending', 'succeeded']);
    assert.equal(az.threads.length, 1, 'edited, not added');
    assert.match(az.threads[0].comments[0].content, /### ✅ AI tests passed: Shop/);
    assert.equal(bug.fields['System.State'], 'Resolved');
    assert.ok(az.comments.some((c) => c.item === Number(bugId) && /Passing again in run/.test(c.text)));

    // User stories: search, link, results comment after a CI run
    const found = await call('GET', `/integrations/${id}/issues?q=cart`);
    assert.deepEqual(found.data.map((i: any) => [i.key, i.type]), [['#7', 'User Story']]);
    assert.match(found.data[0].description, /As a shopper\n*Acceptance criteria:\n*- total is 42\.00/);
    assert.equal((await call('POST', `/testcases/${testId}/links`, { integrationId: id, key: '#7' })).status, 201);
    const ci = await call('POST', '/runs', { agentId, wait: true, metadata: { triggeredBy: 'ci', git: { provider: 'azure_devops', repository: 'shop-web', sha: 'az3', pr: 21 } } });
    await finished(ci.data.id);
    assert.deepEqual(az.statuses.filter((s) => s.sha === 'az3').map((s) => s.state), ['pending', 'succeeded']);
    const results = az.comments.filter((c) => c.item === 7);
    assert.equal(results.length, 1);
    assert.match(results[0].text, /<b>Automated test results \(atab\)<\/b>.*<li><a href="[^"]+\/runs\/[^"]+">✅ Test “Cart shows the order total”: passed/);

    const pipeline = await call('GET', `/integrations/${id}/workflow?agentId=${agentId}&apiUrl=https://atab.example.com/api/v1&branch=develop`);
    assert.equal(pipeline.data.path, 'azure-pipelines.yml');
    const YAML = (await import('yaml')).default;
    const p = YAML.parse(pipeline.data.yaml);
    assert.deepEqual(p.trigger.branches.include, ['develop']);
    assert.equal(p.steps[1].env.ATAB_API_KEY, '$(ATAB_API_KEY)');
    assert.equal(p.steps[2].task, 'PublishTestResults@2');
  });
});
