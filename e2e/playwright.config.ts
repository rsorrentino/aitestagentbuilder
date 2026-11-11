import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the AI Test Agent Builder UI.
 *
 * Start the stack first (backend on :3000, frontend on :4000), then:
 *   cd e2e && npm install && npx playwright install chromium && npm test
 *
 * BASE_URL (default http://localhost:4000) and API_URL (default
 * http://localhost:3000/api/v1) can be overridden.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/e2e-results.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4000',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
