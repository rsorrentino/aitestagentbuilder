/**
 * Page speed: a test measures the demo app's login page, the run page shows the
 * metrics, and the agent page shows the trend and saves the agent-wide check.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('page speed is measured, shown per result and trended per agent', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Speed'), config: { base_url: `${BACKEND}/demo/` } },
  })).json();
  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: {
      title: unique('Login page is fast'), module: 'Speed', priority: 'High', expectedResults: ['fast'],
      steps: [
        { action: 'assert_performance', target: 'login', data: { lcp: 10000, load: 15000 } },
        { action: 'Verify the page loads in under 15 seconds' },
      ],
    },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  expect(run.status).toBe('completed');

  await page.goto(`/runs/${run.id}`);
  await page.getByText(tc.title).first().click();
  const speed = page.getByRole('region', { name: 'Page speed' });
  await expect(speed).toContainText('/demo/login');
  await expect(speed).toContainText('within budget');
  await expect(speed.getByRole('cell', { name: 'LCP' }).first()).toBeVisible();

  await page.goto(`/agents/${agent.id}`);
  const trend = page.getByRole('table', { name: 'Page speed trend' });
  await expect(trend).toContainText('/demo/login');
  await expect(trend.locator('tbody tr').first().locator('td').nth(1)).toHaveText('2');

  await page.getByLabel('Measure every test\'s last page').selectOption('report');
  await page.getByLabel('LCP budget (ms)').fill('3000');
  await page.getByLabel('Network').selectOption('slow4g');
  await page.getByRole('form', { name: 'Page speed settings' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Page speed settings saved')).toBeVisible();
  const saved = await (await request.get(`${API_URL}/agents/${agent.id}`)).json();
  expect(saved.config.checks).toMatchObject({ performance: 'report', performance_budgets: { lcp: 3000 }, performance_options: { throttle: 'slow4g' } });
});
