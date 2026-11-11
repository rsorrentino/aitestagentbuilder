/**
 * Salesforce personas UI against the built-in simulator: configure personas
 * of different privilege levels, verify who each one is, then run one test
 * as all of them with per-persona expectations.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('personas with high and low privileges are verified and tested as a matrix', async ({ page, request }) => {
  test.setTimeout(180_000);
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agentName = unique('Acme Salesforce');
  const created = await request.post(`${API_URL}/agents`, {
    data: { name: agentName, config: { base_url: `${BACKEND}/demo/salesforce` } },
  });
  expect(created.ok()).toBeTruthy();
  const agent = await created.json();

  // Configure the simulator with admin (JWT), rep (password + TOTP) and viewer (password)
  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('button', { name: 'Use the Salesforce simulator' }).click();
  await expect(page.getByText('Salesforce simulator configured with personas admin, rep and viewer')).toBeVisible();
  await expect(page.getByText('Rep-Pass-1!')).toHaveCount(0);

  // Add a "Log in as" persona through the form
  await page.getByRole('button', { name: '＋ Add persona' }).click();
  await page.getByLabel('Persona name *').fill('rep_support');
  await page.getByLabel('Login method *').selectOption('login_as');
  await page.getByLabel('Salesforce username *').fill('rep@acme.sim');
  await page.getByLabel('Administrator persona *').selectOption('admin');
  await page.getByLabel('Expected profile').fill('Standard User');
  await page.getByRole('button', { name: 'Save persona' }).click();
  await expect(page.getByText('Persona “rep_support” saved')).toBeVisible();

  // Verify: Salesforce reports the right profile for each persona
  for (const [name, profile] of [['admin', 'System Administrator'], ['rep', 'Standard User'], ['viewer', 'Read Only'], ['rep_support', 'Standard User']]) {
    await page.getByRole('button', { name: `Verify persona ${name}`, exact: true }).click();
    const result = page.getByTestId(`verify-${name}`);
    await expect(result).toContainText('✓', { timeout: 30_000 });
    await expect(result).toContainText(`profile ${profile}`);
  }

  // A test case that runs as every persona, with per-persona expectations
  const tc = await request.post(`${API_URL}/testcases`, {
    data: {
      title: unique('Opportunity access'),
      module: 'Security',
      priority: 'Critical',
      data: { personas: ['admin', 'rep', 'viewer'] },
      steps: [
        { action: 'assert_object_access', target: 'Opportunity', data: { by_persona: { admin: { delete: true }, rep: { edit: true, delete: false }, viewer: { read: true, edit: false } } } },
        { action: 'navigate', target: 'lightning/r/Opportunity/006SIM000000001AAA/view' },
        { action: 'assert_access_denied', data: { only_personas: ['viewer'] } },
        { action: 'assert_not_visible', target: 'button[name="Delete"]', data: { only_personas: ['rep'] } },
      ],
      expectedResults: ['Each persona gets what its profile allows'],
    },
  });
  expect(tc.ok()).toBeTruthy();
  const testCase = await tc.json();

  await page.goto('/testcases');
  await expect(page.locator('tr', { hasText: testCase.title }).getByText('👤 viewer')).toBeVisible();

  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [testCase.id], wait: true, timeoutSeconds: 120 } })).json();
  expect(run.status).toBe('completed');

  await page.goto(`/runs/${run.id}`);
  for (const persona of ['admin', 'rep', 'viewer']) {
    await expect(page.getByText(`${testCase.title} [as ${persona}]`).first()).toBeVisible();
  }
});
