/**
 * Unattended runs: settings on the agent page, the pre-flight result on the
 * run page, and a daily digest channel.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('unattended settings, pre-flight on the run page, daily digest channel', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  // An application that is down: the run fails once, without running tests
  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Night'), config: { base_url: 'http://127.0.0.1:9/', unattended: { preflight_retries: 0 } } },
  })).json();
  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: { title: unique('Night test'), module: 'Night', priority: 'High', expectedResults: ['x'], steps: [{ action: 'navigate', target: '/' }] },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true, metadata: { triggeredBy: 'schedule' } } })).json();
  expect(run.status).toBe('failed');
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByTestId('preflight')).toContainText('Pre-flight failed');
  await expect(page.getByTestId('preflight')).toContainText('application ✗');

  await page.goto(`/agents/${agent.id}`);
  const card = page.getByRole('form', { name: 'Unattended runs' });
  await card.getByLabel('Pre-flight retries').fill('5');
  await card.getByLabel('Re-run failed tests at the end').selectOption('always');
  await card.getByLabel('Stop a run after (minutes)').fill('90');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Unattended run settings saved')).toBeVisible();
  const saved = await (await request.get(`${API_URL}/agents/${agent.id}`)).json();
  expect(saved.config.unattended).toMatchObject({ preflight: true, preflight_retries: 5, rerun_failed: true, max_run_minutes: 90 });

  await page.goto('/settings/notifications');
  const name = unique('Morning digest');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Type').selectOption('webhook');
  await page.getByLabel('URL *').fill(`${BACKEND}/hooks-not-used`);
  await page.getByRole('checkbox', { name: 'Run failed' }).click();
  await page.getByRole('checkbox', { name: /Daily digest/ }).click();
  await page.getByLabel('Digest time').fill('07:30');
  await page.getByLabel('Time zone').fill('Europe/Rome');
  await page.getByRole('button', { name: 'Create channel' }).click();
  const row = page.locator('tr', { hasText: name });
  await expect(row).toContainText('digest at 07:30 Europe/Rome');
  await expect(row.getByRole('button', { name: 'Send digest now' })).toBeVisible();
});
