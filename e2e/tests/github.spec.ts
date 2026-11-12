/**
 * GitHub integration: connect a repository in Settings → Integrations (against a fake
 * GitHub API started by this test) with a pull request trigger, see the webhook and the
 * Actions workflow in Setup, then a signed pull request webhook runs the tests, sets
 * the commit status and comments on the pull request; the run page shows where it came from.
 */

import http from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('connect GitHub, a pull request webhook runs the tests and reports back', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const statuses: any[] = [];
  const comments: any[] = [];
  const github = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status: number, data: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (p === '/user') return send(200, { login: 'qa-bot' });
    if (p === '/repos/acme/e2e-shop') return send(200, { full_name: 'acme/e2e-shop' });
    if (p.startsWith('/repos/acme/e2e-shop/statuses/')) { statuses.push(body); return send(201, {}); }
    if (p === '/repos/acme/e2e-shop/issues/5/comments') {
      if (req.method === 'GET') return send(200, comments);
      comments.push({ id: comments.length + 1, body: body.body, html_url: 'https://github.test/acme/e2e-shop/pull/5#c1' });
      return send(201, comments[comments.length - 1]);
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', () => r()));
  const app = http.createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<h1>Shop</h1><p id="total">42.00</p>'); });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const name = unique('Repo');
  const agentName = unique('PR checks');
  let integrationId = '';

  try {
    const agent = await (await request.post(`${API_URL}/agents`, {
      data: { name: agentName, config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, test_selection: { tags: [`pr-${agentName}`] } } },
    })).json();
    await request.post(`${API_URL}/testcases`, {
      data: { title: unique('Total'), module: 'Cart', priority: 'High', tags: [`pr-${agentName}`], expectedResults: ['42'], steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#total', data: { value: '42.00' } }] },
    });

    await page.goto('/settings/integrations');
    await page.getByRole('radio', { name: 'GitHub' }).click();
    const form = page.getByTestId('github-form');
    await form.getByLabel('Name *').fill(name);
    await form.getByLabel('Repository *').fill('acme/e2e-shop');
    await form.getByLabel(/^Token/).fill('ghp_e2e');
    await form.getByLabel('API URL').fill(`http://127.0.0.1:${(github.address() as AddressInfo).port}`);
    const secret = await form.getByLabel(/Webhook secret/).inputValue();
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    await form.getByRole('button', { name: '＋ Add trigger' }).click();
    const row = form.getByTestId('trigger-row');
    await row.getByLabel('Event').selectOption('pull_request');
    await row.getByLabel('Agent to run').selectOption({ label: agentName });
    await row.getByLabel('Target branches').fill('main');
    await form.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('GitHub connected.')).toBeVisible();

    const line = page.locator('tr', { hasText: name });
    await expect(line).toContainText('connected');
    await expect(line).toContainText('1 trigger · commit status · PR comment');
    await line.getByRole('button', { name: 'Setup' }).click();
    const setup = page.getByTestId('github-setup');
    await expect(setup.getByTestId('hook-url')).toContainText('/hooks/github/');
    integrationId = (await setup.getByTestId('hook-url').innerText()).split('/').pop()!;
    await setup.getByLabel('Agent').selectOption({ label: agentName });
    await expect(setup.getByTestId('workflow-yaml')).toContainText(`ATAB_AGENT: ${agent.id}`);

    // GitHub sends a pull request event
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/e2e-shop' }, sender: { login: 'dev' }, pull_request: { number: 5, title: 'Better cart', head: { sha: 'e2e5ha1', ref: 'cart' }, base: { ref: 'main' } } });
    const hook = await request.post(`${API_URL}/hooks/github/${integrationId}`, {
      data: payload,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': unique('d'), 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}` },
    });
    expect(hook.status()).toBe(202);
    const runId = (await hook.json()).runs[0].runId;
    await expect.poll(() => statuses.map((s) => s.state), { timeout: 60_000 }).toEqual(['pending', 'success']);
    await expect.poll(() => comments.length).toBe(1);
    expect(comments[0].body).toContain(`✅ AI tests passed: ${agentName}`);

    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId('run-git')).toContainText('Started by pull request #5 in acme/e2e-shop at e2e5ha1 — “Better cart”');
    await expect(page.getByTestId('run-integrations').filter({ hasText: name })).toContainText('commit status: success');
  } finally {
    github.close();
    app.close();
    if (integrationId) await request.delete(`${API_URL}/integrations/${integrationId}`);
  }
});
