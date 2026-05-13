/**
 * E2E tests for the AI Providers Settings page
 */

import { test, expect } from '@playwright/test';

test.describe('AI Providers Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings/ai-providers');
  });

  test('shows the page heading', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AI Provider Settings');
  });

  test('shows the refresh button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Refresh/i })).toBeVisible();
  });

  test('shows the routing table', async ({ page }) => {
    await expect(page.getByText('Task-based Routing')).toBeVisible();
    await expect(page.getByText('Test Extraction')).toBeVisible();
    await expect(page.getByText('Code Generation')).toBeVisible();
    await expect(page.getByText('Self-Healing Selectors')).toBeVisible();
  });

  test('shows back link to dashboard', async ({ page }) => {
    const backLink = page.getByRole('link', { name: /Dashboard/i });
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL('/');
  });
});
