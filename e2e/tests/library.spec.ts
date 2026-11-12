/**
 * Library: an element and a block with a parameter are created on the Library page, a test
 * uses the block and saves another target as an element (★), the run page shows the block's steps.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('blocks and elements are created in the library and used by a test', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const app = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
    res.end(`<!doctype html><title>Search</title><input data-testid="search" aria-label="Search"><button onclick="location.href='/?q=' + document.querySelector('input').value">Go</button><h1 data-testid="results">Results for ${q}</h1>`);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const tag = unique('lib');
  const el = `Search${Date.now() % 100000}.Box`;
  const blockName = unique('Search for');
  try {
    await page.goto('/library');
    await page.getByRole('tab', { name: /Elements/ }).click();
    await page.getByRole('button', { name: '＋ New element' }).click();
    const ef = page.getByTestId('element-form');
    await ef.getByLabel('Name *').fill(el);
    await ef.getByLabel('Locator *').fill('[data-testid="search"]');
    await ef.getByRole('button', { name: 'Create element' }).click();
    await expect(page.getByText(`Element ${el} created`)).toBeVisible();

    await page.getByRole('tab', { name: /Blocks/ }).click();
    await page.getByRole('button', { name: '＋ New block' }).click();
    const bf = page.getByTestId('block-form');
    await bf.getByLabel('Name *').fill(blockName);
    await bf.getByRole('button', { name: '＋ Parameter' }).click();
    await bf.getByLabel('Parameter 1 name').fill('term');
    await bf.getByLabel('Step 1 action').fill('navigate');
    await bf.getByLabel('Step 1 target').fill('/');
    await bf.getByRole('button', { name: '＋ Add step' }).click();
    await bf.getByLabel('Step 2 action').fill('fill');
    await bf.getByLabel('Step 2 target').fill(`{{el.${el}}}`);
    await bf.getByLabel('Step 2 value').fill('{{param.term}}');
    await bf.getByRole('button', { name: '＋ Add step' }).click();
    await bf.getByLabel('Step 3 action').fill('click');
    await bf.getByLabel('Step 3 target').fill('text=Go');
    await bf.getByRole('button', { name: 'Create block' }).click();
    await expect(page.getByText(`Block “${blockName}” created.`)).toBeVisible();
    await expect(page.getByTestId('blocks').locator('tr', { hasText: blockName })).toContainText('term');

    // A test uses the block; ★ turns a step's target into an element
    const title = unique('Search lamps');
    await page.goto('/testcases');
    await page.getByRole('button', { name: '＋ New Test Case' }).click();
    await page.getByLabel('Title *').fill(title);
    await page.getByLabel('Module *').fill('Search');
    await page.getByLabel('Tags').fill(tag);
    await page.getByLabel('Step 1 action').fill('use_block');
    await page.getByLabel('Step 1 target').fill(blockName);
    await page.getByLabel('Step 1 term').fill('lamps');
    await page.getByRole('button', { name: '＋ Add step' }).click();
    await page.getByLabel('Step 2 action').fill('assert_text');
    await page.getByLabel('Step 2 target').fill('[data-testid="results"]');
    await page.getByLabel('Step 2 value').fill('Results for lamps');
    const resultsEl = `Results${Date.now() % 100000}.Title`;
    page.once('dialog', (d) => d.accept(resultsEl));
    await page.getByLabel('Save step 2 target as element').click();
    await expect(page.getByLabel('Step 2 target', { exact: true })).toHaveValue(`{{el.${resultsEl}}}`);
    await page.getByRole('button', { name: '✓ Save' }).click();
    await expect(page.locator('tbody tr', { hasText: title })).toBeVisible();

    const agent = await (await request.post(`${API_URL}/agents`, { data: { name: unique('Search'), config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, test_selection: { tags: [tag] }, evidence: { trace: 'off', video: 'off' } } } })).json();
    const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, wait: true } })).json();
    expect(run.status).toBe('completed');
    await page.goto(`/runs/${run.id}`);
    await page.getByText(title).click();
    await expect(page.getByText(`🧩 ${blockName}`).first()).toBeVisible();
    await expect(page.locator('td', { hasText: /^1\.2🧩/ }).first()).toBeVisible();
  } finally {
    app.close();
  }
});
