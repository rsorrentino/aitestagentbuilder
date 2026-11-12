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

test('a person signs in once in the server browser and the session is saved', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Sign in once'), config: { base_url: `${BACKEND}/demo/`, auth: { profiles: [{ name: 'shopper', login_url: 'login', username: 'demo', password: 'demo123' }] } } },
  })).json();

  await page.goto(`/agents/${agent.id}`);
  const row = page.getByRole('table', { name: 'Login profiles' }).locator('tr', { hasText: 'shopper' });
  await row.getByRole('button', { name: 'Sign in once…' }).click();
  const panel = page.getByRole('region', { name: 'Sign in as shopper' });
  await expect(panel.getByTestId('signin-screen')).toBeVisible();

  // Saving before signing in is refused, with the option to save anyway
  await panel.getByRole('button', { name: /I'm signed in/ }).click();
  await expect(panel.getByRole('alert')).toContainText('does not look signed in');
  await expect(panel.getByRole('button', { name: 'Save anyway' })).toBeVisible();

  await panel.getByRole('button', { name: 'Type user name' }).click();
  await panel.getByRole('button', { name: 'Type password' }).click();
  await panel.getByRole('button', { name: '⌨ Enter' }).click();
  await expect(panel).toContainText('/demo/dashboard');
  await panel.getByRole('button', { name: /I'm signed in/ }).click();
  await expect(page.getByText('Session of shopper saved')).toBeVisible();
  await expect(page.getByTestId('session-shopper')).toContainText('h left');

  const sessions = await (await request.get(`${API_URL}/agents/${agent.id}/auth/sessions`)).json();
  expect(sessions[0]).toMatchObject({ identity: 'shopper', capturedBy: 'interactive' });
});

test('an authenticator key is read from a QR code screenshot and checked against the live code', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');
  const QRCode = (await import('qrcode')).default;
  const link = 'otpauth://totp/ACME:qa%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME';
  const png = await QRCode.toBuffer(link, { width: 300, margin: 4 });

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('QR key'), config: { base_url: `${BACKEND}/demo/` } },
  })).json();
  await page.goto(`/agents/${agent.id}`);
  await page.getByRole('button', { name: '＋ Add login profile' }).click();
  const form = page.getByRole('form', { name: 'Login profile' });
  await form.getByLabel('Name', { exact: true }).fill('qa');
  await form.getByLabel('User name / email').fill('demo');
  await form.getByLabel('QR code image').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await expect(form.getByText('Key read from the QR code')).toBeVisible();
  await expect(form.getByLabel('Authenticator key (optional)')).toHaveValue(link);
  const live = form.getByTestId('totp-live');
  await expect(live).toContainText('ACME · qa@example.com');
  await expect(live).toContainText(/Code now: \d{3} \d{3}/);
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Login profile “qa” saved')).toBeVisible();

  // The saved key is never sent back, but its current code can be shown to compare with the phone
  const row = page.getByRole('table', { name: 'Login profiles' }).locator('tr', { hasText: 'qa' });
  await expect(row).toContainText('🔑 authenticator key');
  await row.getByRole('button', { name: 'Edit' }).click();
  await form.getByRole('button', { name: 'Show the current code of the saved key' }).click();
  await expect(form.getByTestId('totp-helper')).toContainText(/\d{3} \d{3}/);
});
