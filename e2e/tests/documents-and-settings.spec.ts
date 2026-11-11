import { test, expect } from '@playwright/test';
import { unique } from './helpers';

test('upload a markdown test spec', async ({ page }) => {
  const name = `${unique('spec').replace(' ', '-')}.md`;
  await page.goto('/documents');
  await page.getByTestId('file-input').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Login\n\n1. Open /login\n2. Sign in as demo/demo123\n3. Dashboard greets the user\n'),
  });
  await expect(page.getByText(`“${name}” uploaded`)).toBeVisible();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('uploaded');
});

test('AI providers page lists all providers and Copilot transports', async ({ page }) => {
  await page.goto('/settings/ai-providers');
  for (const p of ['anthropic', 'copilot', 'openai', 'azure']) {
    await expect(page.getByTestId(`provider-${p}`)).toBeVisible();
  }
  await expect(page.getByTestId('provider-copilot')).toContainText('Transport');
  await expect(page.getByText('COPILOT_MODE=sdk')).toBeVisible();
  await expect(page.getByText('COPILOT_MODE=cli')).toBeVisible();
});

test('Salesforce wizard creates an agent', async ({ page }) => {
  const name = unique('SF Agent');
  await page.goto('/wizard/salesforce');
  await page.getByPlaceholder('SalesforceCRMTester').fill(name);
  await page.getByPlaceholder('https://your-org.my.salesforce.com').fill('https://example.my.salesforce.com');
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByText('Step 2 — Select CRM Modules')).toBeVisible();
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByText('Step 3 — AI Configuration')).toBeVisible();
  await page.getByRole('button', { name: 'Create Agent →' }).click();
  await expect(page.getByText('Agent Created Successfully!')).toBeVisible();
  await page.getByRole('link', { name: 'View Agent →' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});
