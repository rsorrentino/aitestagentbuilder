/**
 * API testing: generate tests from an OpenAPI description on the agent page,
 * and run an API test case.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('API tests are generated from OpenAPI and API steps run', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Own API'), config: { base_url: `${BACKEND}/demo/`, api_base_url: `${API_URL}/` } },
  })).json();

  // Generate from this application's own OpenAPI description
  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByLabel('API base URL')).toHaveValue(`${API_URL}/`);
  await page.getByLabel('Description URL').fill(`${API_URL}/openapi.json`);
  await page.getByRole('button', { name: 'Generate API tests' }).click();
  await expect(page.getByText(/Created \d+ test case\(s\) from \d+ operation\(s\)/)).toBeVisible({ timeout: 30_000 });
  const result = page.getByTestId('api-generation-result');
  await expect(result).toContainText('GET /agents');
  await expect(result).toContainText('Skipped:');

  // An API test case runs
  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: {
      title: unique('Health is ready'), module: 'API', priority: 'High', expectedResults: ['ready'],
      steps: [
        { action: `GET ${BACKEND}/health/ready` },
        { action: 'Verify the status code is 200' },
        { action: 'assert_json', data: { path: '$.ready', equals: true } },
        { action: 'assert_header', target: 'content-type', data: { value: 'application/json' } },
      ],
    },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  expect(run.status).toBe('completed');
});
