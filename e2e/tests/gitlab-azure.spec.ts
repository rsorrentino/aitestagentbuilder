/**
 * GitLab and Azure DevOps: connect each in Settings → Integrations (against fake APIs
 * started by this test). A GitLab merge request webhook runs the tests, sets the commit
 * status and writes the merge request note; Azure DevOps shows its service hook setup
 * and the Azure Pipelines template.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const serve = async (handler: http.RequestListener) => {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const send = (res: http.ServerResponse, status: number, data: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const body = async (req: http.IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return c.length ? JSON.parse(Buffer.concat(c).toString()) : undefined; };

test('GitLab merge requests are tested and reported; Azure DevOps is connected', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const statuses: any[] = [];
  const notes: any[] = [];
  const gitlab = await serve(async (req, res) => {
    const b = await body(req);
    const p = (req.url ?? '').split('?')[0].replace('/api/v4/projects/acme%2Fe2e', '/P');
    if (p === '/api/v4/user') return send(res, 200, { username: 'qa-bot' });
    if (p === '/P') return send(res, 200, { id: 9, path_with_namespace: 'acme/e2e' });
    if (p.startsWith('/P/statuses/')) { statuses.push(b); return send(res, 201, {}); }
    if (p === '/P/merge_requests/4/notes') {
      if (req.method === 'GET') return send(res, 200, notes);
      notes.push({ id: notes.length + 1, body: b.body });
      return send(res, 201, notes[notes.length - 1]);
    }
    send(res, 404, { message: '404 Not found' });
  });
  const azure = await serve(async (req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p === '/acme/_apis/projects/Shop') return send(res, 200, { name: 'Shop' });
    if (p === '/acme/_apis/connectionData') return send(res, 200, { authenticatedUser: { providerDisplayName: 'QA Bot' } });
    if (p === '/acme/Shop/_apis/git/repositories/shop-web') return send(res, 200, { name: 'shop-web' });
    send(res, 404, { message: 'not found' });
  });
  const app = await serve((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<h1>Shop</h1><p id="total">42.00</p>'); });
  const created: string[] = [];

  try {
    const agentName = unique('MR checks');
    await request.post(`${API_URL}/agents`, { data: { name: agentName, config: { base_url: app.url, test_selection: { tags: [`mr-${agentName}`] } } } });
    await request.post(`${API_URL}/testcases`, {
      data: { title: unique('Total'), module: 'Cart', priority: 'High', tags: [`mr-${agentName}`], expectedResults: ['42'], steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: '#total', data: { value: '42.00' } }] },
    });

    // GitLab
    const glName = unique('GitLab');
    await page.goto('/settings/integrations');
    await page.getByRole('radio', { name: 'GitLab' }).click();
    const gl = page.getByTestId('gitlab-form');
    await gl.getByLabel('Name *').fill(glName);
    await gl.getByLabel('Project *').fill('acme/e2e');
    await gl.getByLabel(/^Token/).fill('glpat-e2e');
    await gl.getByLabel('GitLab URL').fill(gitlab.url);
    const secret = await gl.getByLabel(/Webhook secret/).inputValue();
    await gl.getByRole('button', { name: '＋ Add trigger' }).click();
    await gl.getByTestId('trigger-row').getByLabel('Event').selectOption({ label: 'Merge request opened / new commits' });
    await gl.getByTestId('trigger-row').getByLabel('Agent to run').selectOption({ label: agentName });
    await gl.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('GitLab connected.')).toBeVisible();
    const glRow = page.locator('tr', { hasText: glName });
    await expect(glRow).toContainText('acme/e2e');
    await expect(glRow).toContainText('connected');
    await glRow.getByRole('button', { name: 'Setup' }).click();
    const setup = page.getByTestId('codehost-setup');
    await expect(setup).toContainText('Push events, Merge request events, Deployment events');
    const hookUrl = await setup.getByTestId('hook-url').innerText();
    created.push(hookUrl.split('/').pop()!);
    expect(hookUrl).toContain('/hooks/gitlab/');
    await setup.getByLabel('Agent').selectOption({ label: agentName });
    await expect(setup.getByTestId('workflow-yaml')).toContainText('reports:');
    await expect(setup).toContainText('.gitlab-ci.yml');

    const hook = await request.post(hookUrl.replace(/^.*\/api\/v1/, API_URL), {
      headers: { 'X-Gitlab-Event': 'Merge Request Hook', 'X-Gitlab-Token': secret },
      data: { object_kind: 'merge_request', project: { id: 9, path_with_namespace: 'acme/e2e' }, object_attributes: { iid: 4, action: 'open', state: 'opened', title: 'Faster cart', source_branch: 'cart', target_branch: 'main', last_commit: { id: 'e2e9a1' } } },
    });
    expect(hook.status()).toBe(202);
    const runId = (await hook.json()).runs[0].runId;
    await expect.poll(() => statuses.map((s) => s.state), { timeout: 60_000 }).toEqual(['running', 'success']);
    await expect.poll(() => notes.length).toBe(1);
    expect(notes[0].body).toContain(`✅ AI tests passed: ${agentName}`);
    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId('run-git')).toContainText('Started by merge request !4 in acme/e2e at e2e9a1');
    await expect(page.getByTestId('run-integrations').filter({ hasText: glName })).toContainText('merge request note');

    // Azure DevOps
    const azName = unique('Azure');
    await page.goto('/settings/integrations');
    await page.getByRole('radio', { name: 'Azure DevOps' }).click();
    const az = page.getByTestId('azure_devops-form');
    await az.getByLabel('Name *').fill(azName);
    await az.getByLabel('Organization URL *').fill(`${azure.url}/acme`);
    await az.getByLabel('Project *').fill('Shop');
    await az.getByLabel('Repository').fill('shop-web');
    await az.getByLabel(/^Personal access token/).fill('pat-e2e');
    await az.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Azure DevOps connected.')).toBeVisible();
    const azRow = page.locator('tr', { hasText: azName });
    await expect(azRow).toContainText('QA Bot');
    await azRow.getByRole('button', { name: 'Setup' }).click();
    const azSetup = page.getByTestId('codehost-setup');
    await expect(azSetup).toContainText('X-ATAB-Token:<webhook secret>');
    created.push((await azSetup.getByTestId('hook-url').innerText()).split('/').pop()!);
    await expect(azSetup.getByTestId('workflow-yaml')).toContainText('PublishTestResults@2');
  } finally {
    for (const s of [gitlab.server, azure.server, app.server]) s.close();
    for (const id of created) await request.delete(`${API_URL}/integrations/${id}`);
  }
});
