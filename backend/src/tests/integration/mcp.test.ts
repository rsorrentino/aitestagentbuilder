/**
 * MCP server (integration): the real MCP server process, driven by the
 * official MCP client over stdio, against the real API with login enabled.
 * Checks that it authenticates with a project API key, runs tests in a
 * browser, waits for the verdict and returns failure evidence.
 *
 * Skipped when the database or the MCP server's dependencies are missing
 * (npm --prefix mcp-server ci).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test';
const ADMIN = { email: 'admin@example.com', password: 'Mcp-Admin-Passw0rd!' };
const MCP_DIR = resolve(process.cwd(), '..', 'mcp-server');
const SDK = join(MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'client');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB_URL,
  AUTH_ENABLED: 'true',
  ADMIN_EMAIL: ADMIN.email,
  ADMIN_PASSWORD: ADMIN.password,
  JWT_SECRET: 'mcp-test-jwt-secret',
  ARTIFACTS_PATH: join(mkdtempSync(join(tmpdir(), 'atab-mcp-')), 'artifacts'),
  LOG_TO_FILE: 'false',
  STEP_TIMEOUT_MS: '3000',
});
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER']) {
  delete process.env[k];
}

let api: Server;
let apiUrl = '';
let ready = false;
let skipReason = '';
let token = '';
let closeAll: () => Promise<void> = async () => undefined;

async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

/** Start the MCP server as its own process and connect the official client to it. */
async function connectMcp(env: Record<string, string>) {
  const { Client } = await import(pathToFileURL(join(SDK, 'index.js')).href);
  const { StdioClientTransport, getDefaultEnvironment } = await import(pathToFileURL(join(SDK, 'stdio.js')).href);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(MCP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(MCP_DIR, 'src', 'index.ts')],
    // The SDK's safe defaults (PATH, and SystemRoot etc. on Windows) plus ours; nothing else is inherited
    env: { ...getDefaultEnvironment(), ...env },
  });
  const client = new Client({ name: 'atab-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
  };
  return { client, tool };
}

before(async () => {
  if (!existsSync(join(SDK, 'index.js')) || !existsSync(join(MCP_DIR, 'node_modules', 'tsx'))) {
    skipReason = 'MCP server dependencies not installed (npm --prefix mcp-server ci)';
    return;
  }
  const pg = (await import('pg')).default;
  const probe = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
    await probe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } catch {
    skipReason = 'database not available';
    return;
  } finally {
    await probe.end().catch(() => undefined);
  }

  const { runMigrations } = await import('../../infra/db/migrate.js');
  const { createApp } = await import('../../app.js');
  const { seedAdminUser } = await import('../../api/controllers/auth.controller.js');
  const { default: getDatabaseClient } = await import('../../infra/db/client.js');
  await runMigrations();
  await seedAdminUser();
  api = http.createServer(createApp());
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  ready = true;

  const { OrchestratorService } = await import('../../modules/orchestration/services/orchestrator.service.js');
  closeAll = async () => {
    await OrchestratorService.get().shutdown();
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
    await getDatabaseClient().close();
  };
});

after(async () => {
  await closeAll();
});

describe('MCP server (integration, login enabled)', () => {
  it('authenticates with an API key, runs tests and returns failure evidence', async (t) => {
    if (!ready) return t.skip(skipReason);
    const login = await call('POST', '/api/v1/auth/login', ADMIN);
    assert.equal(login.status, 200, login.text);
    token = login.data.accessToken;
    const seeded = await call('POST', '/api/v1/demo/seed', {});
    assert.equal(seeded.status, 200, seeded.text);
    const key = await call('POST', '/api/v1/auth/api-keys', { name: 'mcp', projectId: 'default', role: 'editor' });
    assert.equal(key.status, 201, key.text);

    // Without a key the MCP server explains what to configure
    const anonymous = await connectMcp({ ATAB_API_URL: `${apiUrl}/api/v1` });
    try {
      const denied = await anonymous.tool('list_agents');
      assert.equal(denied.isError, true);
      assert.match(denied.data.error, /ATAB_API_KEY/);
    } finally {
      await anonymous.client.close();
    }

    const mcp = await connectMcp({ ATAB_API_URL: `${apiUrl}/api/v1`, ATAB_API_KEY: key.data.apiKey });
    try {
      const { tools } = await mcp.client.listTools();
      const names = tools.map((x: any) => x.name);
      for (const name of ['list_agents', 'create_test_case', 'run_tests', 'get_failures', 'apply_healing']) assert.ok(names.includes(name), name);
      assert.ok(!names.includes('run_ui_step'), 'the stub that only pretended to run a step is gone');

      const agents = await mcp.tool('list_agents');
      assert.equal(agents.isError, false, JSON.stringify(agents.data));
      const demo = agents.data.find((a: any) => a.id === seeded.data.agentId);
      assert.ok(demo, 'demo agent listed');

      const created = await mcp.tool('create_test_case', {
        title: 'Login shows a wrong greeting (written by an agent)',
        module: 'MCP',
        priority: 'High',
        steps: [
          { action: 'navigate', target: 'login' },
          { action: 'fill', target: '#username', data: { value: 'demo' } },
          { action: 'fill', target: '#password', data: { value: 'demo123' } },
          { action: 'click', target: 'Sign in button' },
          { action: 'assert_text', target: '#welcome', data: { value: 'Welcome back, admin' } },
        ],
      });
      assert.equal(created.isError, false, JSON.stringify(created.data));

      const plan = await mcp.tool('plan_tests', { agentId: demo.id });
      const passingId = plan.data.testCases[0].id;

      const run = await mcp.tool('run_tests', { agentId: demo.id, testIds: [passingId, created.data.id] });
      assert.equal(run.isError, false, JSON.stringify(run.data));
      assert.equal(run.data.passed, false);
      assert.equal(run.data.totals.tests, 2);
      assert.equal(run.data.failures.length, 1);
      const failure = run.data.failures[0];
      assert.equal(failure.title, 'Login shows a wrong greeting (written by an agent)');
      assert.equal(failure.failedStep.stepId, 5);
      assert.match(failure.error, /Welcome back, admin/);
      assert.match(failure.evidence.screenshots[0], new RegExp(`^${apiUrl}/artifacts/.+\\.png\\?exp=\\d+&sig=`));
      assert.match(failure.evidence.trace, /-trace\.zip\?exp=/);
      // Signed links work without a login (they are meant for the agent / browser)
      assert.equal((await fetch(failure.evidence.screenshots[0])).status, 200);

      const status = await mcp.tool('get_run_status', { runId: run.data.runId });
      assert.equal(status.data.status, 'failed');
      assert.deepEqual(status.data.failedTests, ['Login shows a wrong greeting (written by an agent)']);
      const failures = await mcp.tool('get_failures', { runId: run.data.runId });
      assert.equal(failures.data.failures[0].resultId, failure.resultId);
    } finally {
      await mcp.client.close();
    }
  });
});
