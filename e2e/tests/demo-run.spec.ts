/**
 * The core MVP journey: load the demo → run its tests in a real browser →
 * watch live → inspect results → open the report.
 */

import { test, expect } from '@playwright/test';
import { API_URL } from './helpers';

test('demo: seed, run, watch live, inspect results and report', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // One click loads the demo agent and navigates to it
  await page.getByRole('button', { name: /Try the demo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Demo Shop' })).toBeVisible();
  await expect(page.getByText(/Tests in the next run \(3\)/)).toBeVisible();
  await expect(page.getByText('Valid login opens the dashboard')).toBeVisible();

  // Start the run → live view
  await page.getByRole('button', { name: '▶ Start Run' }).click();
  await expect(page).toHaveURL(/\/live\?runId=/);
  await expect(page.getByRole('heading', { name: 'Live Execution' })).toBeVisible();
  await expect(page.getByAltText('Live browser')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('✓ 3 passed')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Run completed: 3 passed, 0 failed/)).toBeVisible();

  // Run details with step logs and screenshots
  const runId = new URL(page.url()).searchParams.get('runId')!;
  await page.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}`));
  await expect(page.locator('.stat-card', { hasText: 'Passed' }).locator('.stat-value')).toHaveText('3');
  await page.getByText('Add an item to the shopping list').click();
  await expect(page.getByText('Found text "Coffee beans"')).toBeVisible();
  await expect(page.getByAltText('Screenshot').first()).toBeVisible();

  // Reports render
  const html = await request.get(`${API_URL}/runs/${runId}/report?format=html`);
  expect(html.ok()).toBeTruthy();
  expect(await html.text()).toContain('Wrong password shows an error');
  const junit = await request.get(`${API_URL}/runs/${runId}/report?format=junit`);
  expect(await junit.text()).toMatch(/tests="3" failures="0"/);

  // The run is listed on the Runs page
  await page.getByRole('link', { name: /Runs/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Test Runs' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('Demo Shop');
});
