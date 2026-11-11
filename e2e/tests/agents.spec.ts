import { test, expect } from '@playwright/test';
import { unique } from './helpers';

test('create an agent with filters and see its empty plan', async ({ page }) => {
  const name = unique('E2E Agent');
  await page.goto('/agents/new');

  await page.getByLabel('Agent Name *').fill(name);
  await page.getByLabel('Base URL *').fill('http://localhost:3000/demo/');
  await page.getByLabel('Modules (comma separated)').fill('Nothing Matches This Module');
  await page.getByRole('checkbox', { name: 'High' }).click();
  await page.getByLabel('Preferred AI provider').selectOption('copilot');
  await page.getByRole('button', { name: '✓ Create Agent' }).click();

  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('modules: Nothing Matches This Module · priority: High')).toBeVisible();
  await expect(page.getByText('No matching test cases')).toBeVisible();
  await expect(page.getByRole('button', { name: '▶ Start Run' })).toBeDisabled();

  // Listed on the agents page, then deleted
  await page.goto('/agents');
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toContainText('copilot');
  page.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('tbody tr', { hasText: name })).toHaveCount(0);
});

test('duplicate agent names are rejected with a clear message', async ({ page }) => {
  const name = unique('Dup Agent');
  for (let i = 0; i < 2; i++) {
    await page.goto('/agents/new');
    await page.getByLabel('Agent Name *').fill(name);
    await page.getByLabel('Base URL *').fill('https://example.com');
    await page.getByRole('button', { name: '✓ Create Agent' }).click();
  }
  await expect(page.getByText(`An agent named "${name}" already exists`)).toBeVisible();
});
