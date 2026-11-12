/**
 * Recorder: record a login to the demo app by clicking on the streamed
 * screen, save it, replay it; and import a Playwright codegen script.
 */

import { test, expect, Page } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

test('a test is recorded in the remote browser and replays green', async ({ page, browser, request }) => {
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  // The page reconnects to a session that is still open: start from none
  for (const r of await (await request.get(`${API_URL}/recordings`)).json()) await request.delete(`${API_URL}/recordings/${r.id}`);

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Recorded'), config: { base_url: `${BACKEND}/demo/`, secrets: { DEMO_PW: 'demo123' } } },
  })).json();

  // A reference copy of the demo app at the recorder's viewport tells where to click on the picture
  const ref = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await ref.goto(`${BACKEND}/demo/login`);
  const clickOn = async (p: Page, selector: string) => {
    const box = (await ref.locator(selector).boundingBox())!;
    const img = p.getByTestId('recorder-screen');
    const shown = (await img.boundingBox())!;
    await img.click({ position: { x: ((box.x + box.width / 2) / 1280) * shown.width, y: ((box.y + box.height / 2) / 800) * shown.height } });
  };

  await page.goto(`/recorder?agentId=${agent.id}`);
  await page.getByLabel('Start page').fill('login');
  await page.getByRole('button', { name: '⏺ Start recording' }).click();
  await expect(page.getByTestId('recorder-screen')).toBeVisible();
  const steps = page.getByTestId('recorded-steps');
  await expect(steps).toContainText('navigate login');

  await clickOn(page, '#username');
  await expect(page.getByText('Type into')).toBeVisible();
  await page.getByLabel('Value').fill('demo');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(steps).toContainText('fill #username = “demo”');

  await clickOn(page, '#password');
  await expect(page.getByLabel('Use a secret')).toHaveValue('DEMO_PW');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(steps).toContainText('fill #password = “{{secrets.DEMO_PW}}”');

  await clickOn(page, '#login-btn');
  await expect(steps).toContainText('click #login-btn');

  await ref.fill('#username', 'demo');
  await ref.fill('#password', 'demo123');
  await ref.click('#login-btn');
  await page.getByRole('radio', { name: '✓ Text' }).click();
  await expect(page.getByTestId('recorder-screen')).toBeVisible();
  await clickOn(page, '#welcome');
  await expect(page.getByText('Expect text of')).toBeVisible();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(steps).toContainText('assert_text #welcome');

  const title = unique('Recorded login');
  await page.getByLabel('Test case title').fill(title);
  await page.getByRole('button', { name: 'Save test case' }).click();
  await expect(page.getByText(`Saved “${title}” with 5 step(s)`)).toBeVisible();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('button', { name: '⏺ Start recording' })).toBeVisible();
  await ref.close();

  const cases = await (await request.get(`${API_URL}/testcases`, { params: { q: title } })).json();
  const tc = cases.find((c: any) => c.title === title);
  const run = await (await request.post(`${API_URL}/runs`, { data: { agentId: agent.id, testIds: [tc.id], wait: true } })).json();
  expect(run.status).toBe('completed');

  // Import a codegen script
  await page.getByRole('tab', { name: '⇪ Import Playwright codegen' }).click();
  await page.getByLabel('Codegen script').fill(`await page.goto('${BACKEND}/demo/login');
await page.getByLabel('Username').fill('demo');
await page.getByLabel('Password').fill('demo123');
await page.getByRole('button', { name: 'Sign in' }).click();`);
  await page.getByRole('button', { name: 'Preview steps' }).click();
  const result = page.getByTestId('import-result');
  await expect(result).toContainText('navigate login');
  await expect(result).toContainText('{{secrets.PASSWORD}}');
  await expect(result).toContainText('add a secret named PASSWORD');
});
