/**
 * Auth-mode UI (runs only when the backend has AUTH_ENABLED=true).
 *   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD must match the backend's ADMIN_EMAIL / ADMIN_PASSWORD.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Adm1n-Passw0rd!';

test.beforeEach(async ({ request }) => {
  const config = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(!config.authEnabled, 'backend runs without authentication');
});

test('admin creates a user who must change the temporary password', async ({ page }) => {
  const email = `${unique('user').replace(/\s/g, '.')}@example.com`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: /Users/ }).click();
  await page.getByLabel('Email *').fill(email);
  await page.getByLabel('Add to project').selectOption('default');
  await page.getByLabel('Project role').selectOption('viewer');
  await page.getByRole('button', { name: 'Create user' }).click();
  const temp = (await page.getByTestId('temp-password').textContent())!.trim();
  expect(temp.length).toBeGreaterThan(12);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(temp);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account\?mustChange=1/);
  await expect(page.getByText('You must choose a new password')).toBeVisible();

  await page.getByLabel('Current password').fill(temp);
  await page.getByLabel('New password', { exact: true }).fill('weak');
  await page.getByLabel('Confirm new password').fill('weak');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText(/Password must have/)).toBeVisible();

  const strong = 'Viewer-Strong-Pass-2026!';
  await page.getByLabel('New password', { exact: true }).fill(strong);
  await page.getByLabel('Confirm new password').fill(strong);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Viewer: read-only UI
  await page.goto('/agents');
  await expect(page.getByRole('link', { name: '＋ New Agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Audit Log/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Users/ })).toHaveCount(0);
});
