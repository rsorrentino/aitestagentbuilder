import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('create, edit, filter and delete a test case', async ({ page }) => {
  const title = unique('E2E manual test');
  await page.goto('/testcases');
  await page.getByRole('button', { name: '＋ New Test Case' }).click();

  await page.getByLabel('Title *').fill(title);
  await page.getByLabel('Module *').fill('E2E Module');
  await page.getByLabel('Priority', { exact: true }).selectOption('High');
  await page.getByLabel('Step 1 target').fill('/login');
  await page.getByRole('button', { name: '＋ Add step' }).click();
  await page.getByLabel('Step 2 action').fill('assert_visible');
  await page.getByLabel('Step 2 target').fill('#login-btn');
  await page.getByLabel('Expected results (one per line)').fill('Login form is shown');
  await page.getByRole('button', { name: '✓ Save' }).click();

  const row = page.locator('tbody tr', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('E2E Module');
  await expect(row).toContainText('High');

  // Expand to see steps
  await row.getByText(title).click();
  await expect(page.getByText('assert_visible')).toBeVisible();

  // Edit
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Priority', { exact: true }).selectOption('Low');
  await page.getByRole('button', { name: '✓ Save' }).click();
  await expect(page.locator('tbody tr', { hasText: title })).toContainText('Low');

  // Filter by search
  await page.getByLabel('Search test cases').fill(title);
  await expect(page.locator('tbody tr', { hasText: title })).toBeVisible();

  // Delete
  page.once('dialog', (d) => d.accept());
  await page.locator('tbody tr', { hasText: title }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('tbody tr', { hasText: title })).toHaveCount(0);
});

test('API rejects incomplete test cases', async ({ request }) => {
  const res = await request.post(`${API_URL}/testcases`, { data: { name: 'no title' } });
  expect(res.status()).toBe(400);
});
