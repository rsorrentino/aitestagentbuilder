/**
 * Jira integration: connect it in Settings → Integrations (against a fake Jira
 * Cloud API started by this test), link a test to a story in the test case
 * editor, a scheduled run files a bug, shown on the run page, the integrations
 * page and the requirements page.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('connect Jira, link a test to a story, bugs filed by a night run', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const story = `E2E-${Date.now() % 100000}`;
  const created: any[] = [];
  const links: any[] = [];
  const jira = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const p = new URL(req.url ?? '/', 'http://x').pathname.replace('/rest/api/3', '');
    const send = (status: number, data?: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (p === '/myself') return send(200, { displayName: 'QA Bot' });
    if (p === '/project/E2E') return send(200, { key: 'E2E', name: 'E2E shop' });
    if (p === '/issue' && req.method === 'POST') { created.push(body); return send(201, { key: `E2E-9${created.length}` }); }
    if (p === `/issue/${story}`) return send(200, { key: story, fields: { summary: 'Shopper sees the order total', status: { name: 'In Progress' }, issuetype: { name: 'Story' } } });
    if (p.endsWith('/remotelink')) { links.push(body); return send(201, {}); }
    if (p.endsWith('/attachments')) return send(200, []);
    send(404, { errorMessages: ['not found'] });
  });
  await new Promise<void>((r) => jira.listen(0, '127.0.0.1', () => r()));
  const jiraUrl = `http://127.0.0.1:${(jira.address() as AddressInfo).port}`;

  try {
    // Connect Jira
    const name = unique('Jira');
    await page.goto('/settings/integrations');
    const form = page.getByTestId('jira-form');
    await form.getByLabel('Name *').fill(name);
    await form.getByLabel('Jira URL *').fill(jiraUrl);
    await form.getByLabel('Deployment').selectOption('cloud');
    await form.getByLabel(/Account email/).fill('qa-bot@example.com');
    await form.getByLabel(/API token/).fill('token-1');
    await form.getByLabel('Project key').fill('E2E');
    await form.getByLabel('File bugs automatically').check();
    await form.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Jira connected.')).toBeVisible();
    const row = page.locator('tr', { hasText: name });
    await expect(row).toContainText('connected');
    await expect(row).toContainText('QA Bot');
    await expect(row).toContainText('filed for app_bug');

    // A test linked to the story in the editor
    const title = unique('Order total');
    const tc = await (await request.post(`${API_URL}/testcases`, {
      data: { title, module: 'Cart', priority: 'High', expectedResults: ['total'], steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: 'body', data: { value: 'no such total 4242' } }] },
    })).json();
    await page.goto('/testcases');
    await page.getByLabel('Search test cases').fill(title);
    await page.locator('tbody tr', { hasText: title }).getByRole('button', { name: 'Edit' }).click();
    const linksBox = page.getByTestId('issue-links');
    const choose = linksBox.getByLabel('Integration');
    if (await choose.count()) await choose.selectOption({ label: name });
    await linksBox.getByLabel('Issue key').fill(story);
    await linksBox.getByRole('button', { name: '＋ Link' }).click();
    await expect(linksBox).toContainText('Shopper sees the order total');

    // A night run fails: a bug is filed, the story shows the result
    const app = http.createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<h1>Cart</h1><p>Total NaN</p>'); });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    try {
      const agent = await (await request.post(`${API_URL}/agents`, {
        data: { name: unique('Shop'), config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, unattended: { rerun_failed: false }, evidence: { trace: 'off', video: 'off' } } },
      })).json();
      const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true, metadata: { triggeredBy: 'schedule' } } })).json();
      expect(run.status).toBe('failed');
      expect(created).toHaveLength(1);
      expect(links.some((l) => l.globalId === `atab-test-${tc.id}` && l.object.title.startsWith('❌'))).toBe(true);

      await page.goto(`/runs/${run.id}`);
      await expect(page.getByTestId('run-integrations').filter({ hasText: name })).toContainText(`${name}: filed E2E-91`);
      await page.goto('/settings/integrations');
      await expect(page.getByTestId('defects').locator('tr', { hasText: 'E2E-91' })).toContainText('open');
      await page.goto('/requirements');
      await page.getByLabel('Search requirements').fill(story);
      const req = page.getByTestId('coverage').locator('tr', { hasText: story });
      await expect(req).toContainText('Failing');
      await expect(req).toContainText(title);
    } finally {
      app.close();
    }
  } finally {
    jira.close();
    // Remove this test's integration (its fake Jira is gone)
    for (const i of await (await request.get(`${API_URL}/integrations`)).json()) if (i.config?.base_url === jiraUrl) await request.delete(`${API_URL}/integrations/${i.id}`);
  }
});
