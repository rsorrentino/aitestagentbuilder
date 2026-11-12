/**
 * Mock APIs and CI templates: a mock is created on the Mock APIs page, answers at its address and
 * lists the request; the agent page shows a Jenkinsfile for the agent.
 */

import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('a mock API is created, answers and records requests; the agent page shows CI templates', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');
  const name = unique('Shipping');
  await page.goto('/mocks');
  const form = page.getByTestId('mock-form');
  await form.getByLabel('Name *').fill(name);
  await form.getByRole('button', { name: '＋ Route' }).click();
  const route = form.getByTestId('route-row');
  await route.getByLabel('Method').selectOption('POST');
  await route.getByLabel('Path').fill('/quotes');
  await route.getByLabel('Status').fill('201');
  await route.getByLabel('Body (JSON)').fill('{"price": 9.5}');
  await form.getByRole('button', { name: 'Create mock' }).click();
  await expect(page.getByTestId('mock-notice')).toContainText(`Mock “${name}” answers at`);
  const row = page.getByTestId('mocks').locator('tr', { hasText: name });
  const address = await row.getByTestId('mock-address').innerText();

  const answer = await request.post(`${address}/quotes`, { data: { weight: 2 } });
  expect(answer.status()).toBe(201);
  expect(await answer.json()).toEqual({ price: 9.5 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('mock-requests')).toContainText('POST /quotes');
  await expect(page.getByTestId('mock-requests')).toContainText('{"weight":2}');

  const agent = await (await request.post(`${API_URL}/agents`, { data: { name: unique('CI'), config: { base_url: 'http://127.0.0.1:9' } } })).json();
  await page.goto(`/agents/${agent.id}`);
  const ci = page.getByRole('region', { name: 'Run from CI' });
  await expect(ci.getByTestId('ci-template')).toContainText('name: AI tests');
  await ci.getByRole('radio', { name: 'Jenkins' }).click();
  await expect(ci.getByTestId('ci-template')).toContainText(`ATAB_AGENT = '${agent.id}'`);
  await expect(ci).toContainText('Jenkinsfile');
});
