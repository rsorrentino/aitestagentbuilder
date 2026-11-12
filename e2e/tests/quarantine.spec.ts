/**
 * Quarantining a flaky test from the test case list, and releasing it.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('a test can be quarantined and released from the test case list', async ({ page, request }) => {
  const title = unique('Flaky checkout');
  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: { title, module: 'Quarantine', priority: 'Medium', steps: [{ action: 'navigate', target: '/' }], expectedResults: ['ok'] },
  })).json();

  await page.goto('/testcases');
  const row = page.locator('tr', { hasText: title });
  page.once('dialog', (dialog) => dialog.accept('Depends on a third-party sandbox'));
  await row.getByRole('button', { name: 'Quarantine' }).click();
  await expect(row.getByText(/quarantined: runs, but its failures do not fail the run/)).toBeVisible();

  const list = await (await request.get(`${API_URL}/quarantine`)).json();
  expect(list.find((q: any) => q.testCaseId === tc.id)?.reason).toBe('Depends on a third-party sandbox');

  await row.getByRole('button', { name: 'Release' }).click();
  await expect(row.getByText(/quarantined/)).toHaveCount(0);
});
