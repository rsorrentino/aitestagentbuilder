/**
 * Test data: generate a data set on the Test Data page, and run a data-driven
 * test that also types generated (fake) values.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('data sets are generated and drive tests, one run per row', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  // Generate with Faker on the Test Data page and save
  const setName = unique('e2e people');
  await page.goto('/testdata');
  await page.getByLabel('Locale').selectOption('it');
  await page.getByLabel('Rows').fill('4');
  await page.getByLabel('Seed (optional)').fill('7');
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByTestId('testdata-preview');
  await expect(preview).toContainText('4 row(s) · Faker');
  await expect(preview.locator('tbody tr')).toHaveCount(4);
  await expect(preview).toContainText('@example.');
  await page.getByLabel('Data set name').fill(setName);
  await page.getByRole('button', { name: 'Save data set' }).click();
  await expect(page.getByText(`Data set “${setName}” saved`)).toBeVisible();
  const row = page.locator('tr', { hasText: setName });
  await expect(row).toContainText('4');
  await row.getByRole('button', { name: 'View / edit' }).click();
  await expect(page.getByLabel(`JSON of ${setName}`)).toContainText('"rows"');
  // Fake data kinds are documented with examples
  await expect(page.getByRole('cell', { name: '{{fake.testCard}}' })).toBeVisible();

  // A data-driven login test: one execution per row, each typing a generated value too
  const logins = unique('logins');
  await request.post(`${API_URL}/testdata`, { data: { name: logins, data: [
    { _label: 'first visit', user: 'demo', password: 'demo123' },
    { _label: 'second visit', user: 'demo', password: 'demo123' },
  ] } });
  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Data driven'), config: { base_url: `${BACKEND}/demo/`, test_data: { locale: 'it' } } },
  })).json();
  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: {
      title: unique('Login per row'), module: 'Data', priority: 'High', expectedResults: ['welcome'],
      data: { dataset: logins },
      steps: [
        { action: 'navigate', target: 'login' },
        { action: 'fill', target: '#username', data: { value: '{{fake.fullName:probe}}' } },
        { action: 'fill', target: '#username', data: { value: '{{data.user}}' } },
        { action: 'fill', target: '#password', data: { value: '{{data.password}}' } },
        { action: 'click', target: 'Sign in button' },
        { action: 'assert_text', target: '#welcome', data: { value: 'Welcome' } },
      ],
    },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  expect(run.status).toBe('completed');

  await page.goto(`/runs/${run.id}`);
  await expect(page.getByText(`${tc.title} [first visit]`).first()).toBeVisible();
  await page.getByText(`${tc.title} [second visit]`).first().click();
  const data = page.getByRole('region', { name: 'Test data' });
  await expect(data).toContainText('Data set row “second visit”');
  await expect(data).toContainText('user=demo');
  await expect(data).toContainText('{{fake.fullName:probe}}=');
});
