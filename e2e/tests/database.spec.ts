/**
 * Databases on the agent page: a PostgreSQL database is added (password stored, never shown),
 * and a test checks it with assert_db.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

const PG = new URL(process.env.E2E_DB_URL || 'postgresql://postgres:postgres@localhost:5432/postgres');

test('a database is added to an agent and checked by a test', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');
  const agent = await (await request.post(`${API_URL}/agents`, { data: { name: unique('With DB'), config: { base_url: 'http://127.0.0.1:9', unattended: { preflight: false }, evidence: { trace: 'off', video: 'off' } } } })).json();

  await page.goto(`/agents/${agent.id}`);
  const card = page.getByRole('form', { name: 'Databases' });
  await card.getByRole('button', { name: '＋ Database' }).click();
  const row = card.getByTestId('db-row');
  await row.getByLabel('Database name').fill('main');
  await row.getByLabel('Host').fill(PG.hostname);
  await row.getByLabel('Port').fill(PG.port || '5432');
  await row.getByLabel('Database', { exact: true }).fill(PG.pathname.slice(1));
  await row.getByLabel('User').fill(decodeURIComponent(PG.username));
  await row.getByLabel('Password').fill(decodeURIComponent(PG.password));
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved 1 database(s).')).toBeVisible();
  const saved = (await (await request.get(`${API_URL}/agents/${agent.id}`)).json()).config.databases[0];
  expect(saved).toMatchObject({ name: 'main', type: 'postgres', password: '••••••••', read_only: true });
  await page.reload();
  await expect(page.getByRole('form', { name: 'Databases' }).getByLabel('Password')).toHaveAttribute('placeholder', 'stored (leave empty to keep)');

  const tc = await (await request.post(`${API_URL}/testcases`, {
    data: { title: unique('DB is up'), module: 'DB', priority: 'High', expectedResults: ['1'], steps: [{ action: 'assert_db', target: 'main', data: { sql: 'SELECT ? AS answer', params: ['42'], equals: { answer: '42' } } }] },
  })).json();
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  const full = await (await request.get(`${API_URL}/runs/${run.id}`)).json();
  expect(full.results[0].error ?? null).toBeNull();
  expect(full.status).toBe('completed');
});
