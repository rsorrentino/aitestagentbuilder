/**
 * App map: an application is explored from the UI, its screens are listed, and the proposed
 * tests are created.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { API_URL, unique } from './helpers';

test('an application is explored and tests are created from the map', async ({ page, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');
  const html = (h: string, body = '') => `<!doctype html><title>${h}</title><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/contact">Contact</a> <a href="/logout">Log out</a></nav><h1>${h}</h1>${body}`;
  const hits: string[] = [];
  const app = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/pricing') return res.end(html('Pricing', '<button>Start trial</button>'));
    if (req.url === '/contact') return res.end(html('Contact us', '<label>Message <textarea></textarea></label><button>Send</button>'));
    res.end(html('Welcome'));
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  try {
    const agentName = unique('Site');
    // Its own test selection: "tested" means visited by this agent's tests (none yet)
    await request.post(`${API_URL}/agents`, { data: { name: agentName, config: { base_url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, test_selection: { tags: [unique('map')] }, evidence: { trace: 'off', video: 'off' } } } });
    await page.goto('/discovery');
    const form = page.getByTestId('discover-form');
    await form.getByLabel('Agent').selectOption({ label: agentName });
    await form.getByLabel('Screens at most').fill('10');
    await form.getByRole('button', { name: 'Explore' }).click();
    const d = page.getByTestId('discovery');
    await expect(d.getByTestId('discovery-summary')).toContainText('3 screen(s)', { timeout: 60_000 });
    await expect(d.getByTestId('screens')).toContainText('/pricing');
    await expect(d.getByTestId('screens')).toContainText('Contact us');
    expect(hits).not.toContain('/logout');
    await expect(d.getByTestId('proposals')).toContainText('Pricing screen shows its main parts');
    await expect(d.getByTestId('proposals')).toContainText('Contact us screen shows its main parts');
    await d.getByRole('button', { name: 'Create 3 test(s)' }).click();
    await expect(page.getByText('Created 3 test(s) (tag “discovered”)')).toBeVisible();
  } finally {
    app.close();
  }
});
