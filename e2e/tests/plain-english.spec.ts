/**
 * Plain-English steps in the test case editor: sentences are converted to steps (shown with how
 * each line was understood), added to the test, saved and run.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('a test written in plain English is converted, saved and passes', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');
  const app = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Newsletter</title><label>Email <input name="email"></label><button onclick="document.querySelector(\'h1\').textContent = \'Thanks \' + document.querySelector(\'input\').value">Subscribe</button><h1>Join us</h1>');
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  try {
    const title = unique('Subscribe');
    const tag = unique('pe');
    await page.goto('/testcases');
    await page.getByRole('button', { name: '＋ New Test Case' }).click();
    await page.getByLabel('Title *').fill(title);
    await page.getByLabel('Module *').fill('Newsletter');
    await page.getByLabel('Tags').fill(tag);
    await page.getByRole('button', { name: '✍ Write in plain English' }).click();
    const pe = page.getByTestId('plain-english');
    await pe.getByLabel(/Steps in plain English/).fill('Go to /\nType "ann@example.com" into the Email field, then click Subscribe\nVerify the page shows "Thanks ann@example.com"\nDo a little dance');
    await pe.getByRole('button', { name: 'Convert to steps' }).click();
    const result = pe.getByTestId('english-result');
    await expect(result.locator('tr', { hasText: 'click Subscribe' })).toContainText('understood');
    await expect(result.locator('tr', { hasText: 'Do a little dance' })).toContainText('not understood');
    await pe.getByRole('button', { name: 'Replace all steps' }).click();
    await expect(page.getByLabel('Step 2 action')).toHaveValue('fill');
    await expect(page.getByLabel('Step 2 target', { exact: true })).toHaveValue('Email');
    await expect(page.getByLabel('Step 4 value')).toHaveValue('Thanks ann@example.com');
    await page.getByRole('button', { name: '✓ Save' }).click();
    await expect(page.locator('tbody tr', { hasText: title })).toBeVisible();

    const agent = await (await request.post(`${API_URL}/agents`, { data: { name: unique('News'), config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, test_selection: { tags: [tag] }, evidence: { trace: 'off', video: 'off' } } } })).json();
    const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, wait: true } })).json();
    expect(run.status).toBe('completed');
  } finally {
    app.close();
  }
});
