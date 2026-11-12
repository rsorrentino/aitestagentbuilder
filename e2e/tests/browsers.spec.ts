/**
 * Browsers & devices: choose an emulated phone next to Chromium on the agent page, then a
 * Playwright server as the grid (started by this test, as a cloud grid would be); every test
 * runs once per browser and the run page lists the results per browser.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { chromium, test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('tests run per browser and emulated device, locally and on a grid', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const app = http.createServer((_q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end('<!doctype html><meta name="viewport" content="width=device-width"><h1>Shop</h1><p id="screen"></p><script>screen_ = document.getElementById("screen"); screen_.textContent = innerWidth < 600 ? "phone" : "desktop";</script>');
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const grid = await chromium.launchServer({ headless: true });
  try {
    const tag = unique('xb');
    const agent = await (await request.post(`${API_URL}/agents`, {
      data: { name: unique('Everywhere'), config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, test_selection: { tags: [tag] }, evidence: { trace: 'off', video: 'off' } } },
    })).json();
    await request.post(`${API_URL}/testcases`, {
      data: { title: 'Screen size', module: 'Layout', priority: 'High', tags: [tag], expectedResults: ['x'], steps: [{ action: 'navigate', target: '/' }, { action: 'assert_text', target: 'h1', data: { value: 'Shop' } }] },
    });

    await page.goto(`/agents/${agent.id}`);
    const card = page.getByRole('form', { name: 'Browsers and devices' });
    await expect(card).toContainText('each test runs 1× per run');
    await card.getByRole('checkbox', { name: 'Pixel 7' }).click();
    await card.getByRole('checkbox', { name: 'iPhone 15', exact: true }).click();
    await card.getByRole('checkbox', { name: 'iPhone 15', exact: true }).click();
    await expect(card).toContainText('each test runs 2× per run');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('Saved: every test runs 2 times')).toBeVisible();
    expect((await (await request.get(`${API_URL}/agents/${agent.id}`)).json()).config.browsers).toEqual(['chromium', 'Pixel 7']);

    const local = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, wait: true } })).json();
    expect(local.status).toBe('completed');
    await page.goto(`/runs/${local.id}`);
    await expect(page.getByText('Screen size [chromium]')).toBeVisible();
    await expect(page.getByText('Screen size [Pixel 7]')).toBeVisible();

    // On a grid
    await page.goto(`/agents/${agent.id}`);
    await card.getByLabel('Run on').selectOption('playwright');
    await card.getByLabel('Server address *').fill(grid.wsEndpoint());
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('Saved: every test runs 2 times on Playwright server')).toBeVisible();
    const remote = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, wait: true } })).json();
    expect(remote.status).toBe('completed');
    const saved = (await (await request.get(`${API_URL}/agents/${agent.id}`)).json()).config.grid;
    expect(saved).toEqual({ provider: 'playwright', ws_endpoint: grid.wsEndpoint() });

    // BrowserStack: the access key is stored and never shown again
    await card.getByLabel('Run on').selectOption('browserstack');
    await card.getByLabel('Username').fill('qa-bot');
    await card.getByLabel('Access key').fill('bs-secret-key');
    await card.getByLabel('Endpoint (override)').fill('');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('on BrowserStack')).toBeVisible();
    const bs = (await (await request.get(`${API_URL}/agents/${agent.id}`)).json()).config.grid;
    expect(bs).toMatchObject({ provider: 'browserstack', username: 'qa-bot', access_key: '••••••••' });
    await page.reload();
    await expect(card.getByLabel('Access key')).toHaveAttribute('placeholder', 'stored (leave empty to keep)');
  } finally {
    await grid.close();
    app.close();
  }
});
