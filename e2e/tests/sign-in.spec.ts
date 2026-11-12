/**
 * Sign-in & MFA: a login profile is added on the agent page, checked with
 * "Test sign-in", and tests then start signed in.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('a login profile signs tests in', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Signed in'), config: { base_url: `${BACKEND}/demo/` } },
  })).json();

  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('button', { name: '＋ Add login profile' }).click();
  const form = page.getByRole('form', { name: 'Login profile' });
  await form.getByLabel('Name', { exact: true }).fill('shopper');
  await form.getByLabel('Sign-in page').fill('login');
  await form.getByLabel('User name / email').fill('demo');
  await form.getByLabel('Password', { exact: true }).fill('demo123');
  await form.getByLabel('Page after sign-in (optional)').fill('dashboard');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Login profile “shopper” saved')).toBeVisible();

  const row = page.getByRole('table', { name: 'Login profiles' }).locator('tr', { hasText: 'shopper' });
  await row.getByRole('button', { name: 'Test sign-in' }).click();
  await expect(row).toContainText('✓ Signed in as shopper (demo)');
  await expect(page.getByTestId('session-shopper')).toContainText('h left');

  await page.getByLabel('Tests start signed in as').selectOption('shopper');
  await expect(page.getByLabel('Tests start signed in as')).toHaveValue('shopper');

  const saved = await (await request.get(`${API_URL}/agents/${agent.id}`)).json();
  expect(saved.config.auth.profiles[0].password).toBe('••••••••');
  expect(saved.config.auth.default_profile).toBe('shopper');

  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: {
      title: unique('Dashboard greets the shopper'), module: 'Sign-in', priority: 'High', expectedResults: ['greeting'],
      steps: [{ action: 'assert_text', target: '#welcome', data: { value: 'Welcome, demo!' } }],
    },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  expect(run.status).toBe('completed');

  await row.getByRole('button', { name: 'Forget session' }).click();
  await expect(page.getByText('Saved session of shopper forgotten')).toBeVisible();
  await expect(page.getByTestId('session-shopper')).toContainText('none yet');
});
