/**
 * E2E tests for the AI Test Agent Builder Dashboard
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows the main dashboard heading', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AI Test Agent Builder');
  });

  test('shows stats cards', async ({ page }) => {
    await expect(page.getByText('Total Agents')).toBeVisible();
    await expect(page.getByText('Recent Runs')).toBeVisible();
  });

  test('shows the Salesforce Wizard quick-action button', async ({ page }) => {
    const wizardBtn = page.getByRole('link', { name: /Salesforce Wizard/i });
    await expect(wizardBtn).toBeVisible();
  });

  test('shows the AI Providers settings link', async ({ page }) => {
    const settingsLink = page.getByRole('link', { name: /AI Providers/i });
    await expect(settingsLink).toBeVisible();
  });

  test('opens the AI assistant chat panel', async ({ page }) => {
    await page.getByRole('button', { name: /AI Assistant/i }).click();
    await expect(page.getByText('AI Test Authoring Assistant')).toBeVisible();
  });

  test('shows Recent Test Runs table', async ({ page }) => {
    await expect(page.locator('table')).toBeVisible();
    const headers = page.locator('thead th');
    await expect(headers).toHaveCount(7);
  });

  test('navigates to live view when clicking Live link', async ({ page }) => {
    // Mock: if no runs, just verify nav works when a link exists
    const liveLinks = page.locator('a.live-link');
    const count = await liveLinks.count();
    if (count > 0) {
      await liveLinks.first().click();
      await expect(page).toHaveURL(/\/live/);
    } else {
      test.skip();
    }
  });
});
