/**
 * Quality checks in the UI: visual baseline approval, accessibility findings,
 * trace/video evidence of failures, and the agent's quality settings.
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import { API_URL, unique } from './helpers';

const BACKEND = API_URL.replace(/\/api\/v\d+\/?$/, '');

async function runAndWait(request: APIRequestContext, agentId: string, testIds: string[]) {
  const res = await request.post(`${API_URL}/runs`, { data: { agentId, testIds, wait: true, timeoutSeconds: 120 } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test('visual differences can be approved, accessibility and evidence are shown', async ({ page, request }) => {
  test.setTimeout(180_000);
  const auth = await (await request.get(`${API_URL}/auth/config`)).json();
  test.skip(auth.authEnabled, 'runs in local mode (no login)');

  const agent = await (await request.post(`${API_URL}/agents`, {
    data: { name: unique('Quality'), config: { base_url: `${BACKEND}/demo/` } },
  })).json();
  const createTest = async (title: string, steps: any[]) =>
    (await (await request.post(`${API_URL}/testcases`, { data: { title, module: 'Quality', priority: 'High', steps, expectedResults: ['ok'] } })).json()).id;

  const home = await createTest(unique('Home looks right'), [
    { action: 'navigate', target: './' },
    { action: 'assert_screenshot', data: { name: 'main-page' } },
    { action: 'assert_accessible', data: { min_impact: 'minor', report_only: true } },
  ]);
  const login = await createTest(unique('Login page compared with the home baseline'), [
    { action: 'navigate', target: './login' },
    { action: 'assert_screenshot', data: { name: 'main-page' } },
  ]);
  const broken = await createTest(unique('Broken expectation'), [
    { action: 'navigate', target: './login' },
    { action: 'assert_text', data: { value: 'This text is not on the page' } },
  ]);

  await runAndWait(request, agent.id, [home]); // records the baseline
  const run = await runAndWait(request, agent.id, [login, broken]);
  expect(run.status).toBe('failed');

  // Run page: the visual difference, approved as the new baseline
  await page.goto(`/runs/${run.id}`);
  await page.getByText('Login page compared with the home baseline').first().click();
  const visual = page.getByTestId('visual-main-page');
  await expect(visual).toContainText('of pixels changed');
  for (const label of ['Baseline', 'This run', 'Difference']) {
    await expect(visual.getByRole('img', { name: `${label} of main-page` })).toBeVisible();
  }
  await visual.getByRole('button', { name: '✓ Approve as new baseline' }).click();
  await expect(page.getByText('New baseline saved for “main-page”')).toBeVisible();
  await expect(visual.getByText('approved as new baseline')).toBeVisible();

  // The failed test has a video and a downloadable, redacted trace
  await page.getByText('Broken expectation').first().click();
  const evidence = page.getByRole('region', { name: 'Evidence' });
  await expect(evidence.locator('video')).toBeVisible();
  await expect(evidence.getByRole('link', { name: '⬇ Download Playwright trace' })).toHaveAttribute('href', /-trace\.zip\?exp=/);

  // The approved baseline passes now
  const again = await runAndWait(request, agent.id, [login]);
  expect(again.status).toBe('completed');

  // Accessibility findings of the first run are listed
  const runs = await (await request.get(`${API_URL}/runs`)).json();
  const first = runs.find((r: any) => r.agentId === agent.id && r.totalTests === 1 && r.status === 'completed' && r.id !== again.id);
  await page.goto(`/runs/${first.id}`);
  await page.getByText('Home looks right').first().click();
  await expect(page.getByRole('region', { name: 'Accessibility' })).toContainText('WCAG21AA');

  // Agent page: baselines and quality settings
  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByTestId('baseline-main-page')).toBeVisible();
  await page.getByLabel('Accessibility scan after every test').selectOption('report');
  await page.getByLabel('Keep Playwright trace').selectOption('always');
  await page.getByRole('button', { name: 'Save quality settings' }).click();
  await expect(page.getByText('Quality settings saved')).toBeVisible();
  const saved = await (await request.get(`${API_URL}/agents/${agent.id}`)).json();
  expect(saved.config.checks.accessibility).toBe('report');
  expect(saved.config.evidence.trace).toBe('always');
});
