/**
 * Enterprise UI: projects & isolation, agent secrets, schedules,
 * notifications, analytics, audit log. (Local mode: the user is admin.)
 */

import { test, expect, Page } from '@playwright/test';
import { API_URL, unique } from './helpers';

async function selectProject(page: Page, name: string) {
  await page.getByLabel('Current project').selectOption({ label: name });
  await page.waitForLoadState('networkidle');
  await expect(page.getByLabel('Current project')).toHaveValue(/.+/);
}

test('projects isolate data; secrets, schedules, notifications, analytics and audit work', async ({ page, request }) => {
  const projectName = unique('E2E Project');

  // Create a project and switch to it
  await page.goto('/projects');
  await page.getByLabel('New project name').fill(projectName);
  await page.getByRole('button', { name: '＋ Create' }).click();
  await expect(page.getByText(`Project “${projectName}” created`)).toBeVisible();
  await page.locator('tbody tr', { hasText: projectName }).getByRole('button', { name: 'Switch' }).click();
  await expect(page.getByLabel('Current project').locator('option:checked')).toHaveText(projectName);

  // The new project starts empty (isolation)
  await page.goto('/agents');
  await expect(page.getByText('No agents yet')).toBeVisible();

  // Seed the demo inside this project and open its agent
  await page.goto('/');
  await page.getByRole('button', { name: /Try the demo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Demo Shop' })).toBeVisible();

  // Secrets: add one, value never shown back
  await page.getByLabel('Secret name').fill('demo_password');
  await page.getByLabel('Secret value').fill('demo123');
  await page.getByRole('button', { name: 'Add secret' }).click();
  await expect(page.locator('.chip', { hasText: 'DEMO_PASSWORD' })).toBeVisible();
  await expect(page.getByText('demo123')).toHaveCount(0);

  // Schedule it
  await page.goto('/schedules');
  await page.getByLabel('Name', { exact: true }).fill('Nightly demo');
  await page.getByLabel('When').selectOption({ label: 'Every day at 02:00' });
  await page.getByLabel('Timezone').fill('Europe/Rome');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByText('Schedule created')).toBeVisible();
  const row = page.locator('tbody tr', { hasText: 'Nightly demo' });
  await expect(row).toContainText('0 2 * * *');
  await expect(row).toContainText('Europe/Rome');

  // "Run now" from the schedule produces a run
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('“Nightly demo” started')).toBeVisible();

  // Notifications: create a Slack channel; its URL is never displayed back
  await page.goto('/settings/notifications');
  await page.getByLabel('Name *').fill('QA Slack');
  await page.getByLabel('URL *').fill('https://hooks.slack.com/services/T000/B000/SECRETTOKEN');
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByText('Channel created')).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: 'QA Slack' })).toContainText('webhook URL stored (hidden)');
  await expect(page.getByText('SECRETTOKEN')).toHaveCount(0);

  // Wait for the scheduled run to finish, then check analytics
  const projectId = await page.evaluate(() => localStorage.getItem('atab_project'));
  await expect.poll(async () => {
    const res = await request.get(`${API_URL}/runs`, { headers: { 'X-Project-Id': projectId! } });
    const runs = await res.json();
    return runs[0]?.status;
  }, { timeout: 90_000 }).toBe('completed');

  await page.goto('/analytics');
  await expect(page.getByText('Pass rate per day')).toBeVisible();
  await expect(page.locator('.stat-card', { hasText: 'Pass rate' }).locator('.stat-value')).toHaveText('100%');
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.getByRole('button', { name: /Show chart data as a table/ }).click();
  await expect(page.getByRole('cell', { name: '100%' }).first()).toBeVisible();

  // Audit log shows what we did, scoped to this project
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
  for (const action of ['notification.create', 'schedule.create', 'agent.update', 'demo.seed']) {
    await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
  }

  // Other projects do not see this project's agents
  await page.goto('/agents');
  await selectProject(page, 'Default');
  await page.goto('/agents');
  await expect(page.getByRole('link', { name: 'Demo Shop' }).first()).toBeVisible(); // Default has its own demo from other tests
  const defaultAgents = await (await request.get(`${API_URL}/agents`, { headers: { 'X-Project-Id': 'default' } })).json();
  const projectAgents = await (await request.get(`${API_URL}/agents`, { headers: { 'X-Project-Id': projectId! } })).json();
  expect(projectAgents).toHaveLength(1);
  expect(defaultAgents.map((a: any) => a.id)).not.toContain(projectAgents[0].id);
});

test('API docs are served', async ({ request }) => {
  const spec = await request.get(`${API_URL}/openapi.json`);
  expect(spec.ok()).toBeTruthy();
  expect((await spec.json()).paths['/schedules']).toBeTruthy();
});
