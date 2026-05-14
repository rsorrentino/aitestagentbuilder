/**
 * E2E tests for the Salesforce CRM Quick-Start Wizard
 */

import { test, expect } from '@playwright/test';

test.describe('Salesforce CRM Wizard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/wizard/salesforce');
  });

  test('renders step 1 heading', async ({ page }) => {
    await expect(page.getByText('Step 1 — Salesforce Org Details')).toBeVisible();
  });

  test('shows all step indicator dots', async ({ page }) => {
    const dots = page.locator('.step-dot');
    await expect(dots).toHaveCount(4);
  });

  test('step 1 Next button is disabled with empty org URL', async ({ page }) => {
    const nextBtn = page.getByRole('button', { name: /Next/i });
    await expect(nextBtn).toBeDisabled();
  });

  test('step 1 Next button enables after entering org URL', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    const nextBtn = page.getByRole('button', { name: /Next/i });
    await expect(nextBtn).toBeEnabled();
  });

  test('advances to step 2 after filling org URL', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    await page.getByRole('button', { name: /Next/i }).click();
    await expect(page.getByText('Step 2 — Select CRM Modules')).toBeVisible();
  });

  test('step 2 shows all SF modules', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    await page.getByRole('button', { name: /Next/i }).click();

    const modules = ['Authentication', 'Leads', 'Contacts', 'Opportunities', 'Cases', 'Reports'];
    for (const mod of modules) {
      await expect(page.getByText(mod, { exact: true })).toBeVisible();
    }
  });

  test('step 2 allows toggling modules', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    await page.getByRole('button', { name: /Next/i }).click();

    // Accounts is not selected by default
    const accountsChip = page.locator('.module-chip', { hasText: 'Accounts' });
    await accountsChip.click();
    await expect(accountsChip).toHaveClass(/selected/);
  });

  test('advances through all steps to step 3', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    await page.getByRole('button', { name: /Next/i }).click();
    await page.getByRole('button', { name: /Next/i }).click();
    await expect(page.getByText('Step 3 — AI Configuration')).toBeVisible();
  });

  test('step 3 shows AI provider options', async ({ page }) => {
    await page.fill('input[placeholder*="salesforce.com"]', 'https://test.my.salesforce.com');
    await page.getByRole('button', { name: /Next/i }).click();
    await page.getByRole('button', { name: /Next/i }).click();

    await expect(page.locator('select')).toBeVisible();
    await expect(page.getByText('Enable AI Self-Healing')).toBeVisible();
  });
});
