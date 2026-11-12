/**
 * Browsers, emulated devices and cloud grids (no browser started).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOptions, gridConnection, gridCredentials, resolveTargets, validateTargets } from '../modules/execution/targets.js';

const meta = { name: 'Shop — firefox', build: 'Shop · RUN-1', playwrightVersion: '1.63.0' };
const capsOf = (url: string, param: string) => JSON.parse(decodeURIComponent(new URL(url).searchParams.get(param)!));

describe('browsers and grids', () => {
  it('resolves browsers, aliases and devices', () => {
    delete process.env.PLAYWRIGHT_BROWSER;
    assert.deepEqual(resolveTargets({}), [{ name: 'chromium', engine: 'chromium' }]);
    assert.deepEqual(resolveTargets({ browsers: ['firefox', 'Safari', 'chrome', 'iPhone 15', 'Pixel 7', 'firefox'] }), [
      { name: 'firefox', engine: 'firefox' },
      { name: 'safari', engine: 'webkit' },
      { name: 'chrome', engine: 'chromium' },
      { name: 'iPhone 15', engine: 'webkit', device: 'iPhone 15' },
      { name: 'Pixel 7', engine: 'chromium', device: 'Pixel 7' },
    ]);
    assert.equal((deviceOptions({ name: 'iPhone 15', engine: 'webkit', device: 'iPhone 15' }) as any).isMobile, true);
    assert.equal((deviceOptions({ name: 'iPhone 15', engine: 'webkit', device: 'iPhone 15' }) as any).defaultBrowserType, undefined);
    assert.deepEqual(deviceOptions({ name: 'firefox', engine: 'firefox' }), {});
    process.env.PLAYWRIGHT_BROWSER = 'webkit';
    assert.deepEqual(resolveTargets({}), [{ name: 'webkit', engine: 'webkit' }]);
    delete process.env.PLAYWRIGHT_BROWSER;
  });

  it('validates browsers and grids', () => {
    assert.deepEqual(validateTargets({ browsers: ['chromium', 'iPad Pro 11'] }), []);
    assert.match(validateTargets({ browsers: ['ie6'] })[0], /unknown "ie6"/);
    assert.match(validateTargets({ browsers: 'firefox' })[0], /must be a list/);
    assert.match(validateTargets({ grid: { provider: 'selenoid' } })[0], /provider must be one of browserstack, lambdatest, saucelabs, playwright/);
    assert.match(validateTargets({ grid: { provider: 'playwright' } })[0], /ws:\/\/ or wss:\/\/ address of the Playwright server/);
    assert.match(validateTargets({ browsers: ['webkit'], grid: { provider: 'saucelabs' } })[0], /Chrome \/ Chromium only/);
    assert.deepEqual(validateTargets({ browsers: ['chrome'], grid: { provider: 'saucelabs' } }), []);
  });

  it('builds the BrowserStack endpoint', () => {
    const c = gridConnection({ provider: 'browserstack', username: 'qa', access_key: 'k1' }, { name: 'firefox', engine: 'firefox' }, meta);
    assert.equal(c.kind, 'connect');
    if (c.kind !== 'connect') return;
    assert.equal(c.engine, 'chromium', 'BrowserStack picks the browser from the capabilities');
    assert.ok(c.wsEndpoint.startsWith('wss://cdp.browserstack.com/playwright?caps='));
    assert.deepEqual(capsOf(c.wsEndpoint, 'caps'), {
      browser: 'playwright-firefox', browser_version: 'latest', os: 'Windows', os_version: '11', name: meta.name, build: meta.build,
      'browserstack.username': 'qa', 'browserstack.accessKey': 'k1', 'client.playwrightVersion': '1.63.0',
    });
    const mac = gridConnection({ provider: 'browserstack', username: 'qa', access_key: 'k1', capabilities: { 'browserstack.local': true } }, { name: 'iPhone 15', engine: 'webkit', device: 'iPhone 15' }, meta);
    const caps = capsOf((mac as any).wsEndpoint, 'caps');
    assert.deepEqual([caps.browser, caps.os, caps['browserstack.local']], ['playwright-webkit', 'OS X', true]);
    assert.equal(capsOf((gridConnection({ provider: 'browserstack' }, { name: 'chrome', engine: 'chromium' }, meta) as any).wsEndpoint, 'caps').browser, 'chrome');
  });

  it('builds the LambdaTest endpoint', () => {
    const c = gridConnection({ provider: 'lambdatest', username: 'qa', access_key: 'k2', os: 'Windows 10', capabilities: { 'LT:Options': { tunnel: true } } }, { name: 'webkit', engine: 'webkit' }, meta) as any;
    assert.ok(c.wsEndpoint.startsWith('wss://cdp.lambdatest.com/playwright?capabilities='));
    assert.deepEqual(capsOf(c.wsEndpoint, 'capabilities'), {
      browserName: 'pw-webkit', browserVersion: 'latest',
      'LT:Options': { platform: 'Windows 10', build: meta.build, name: meta.name, user: 'qa', accessKey: 'k2', playwrightClientVersion: '1.63.0', tunnel: true },
    });
  });

  it('builds the Sauce Labs Selenium Grid connection and a custom Playwright server', () => {
    const c = gridConnection({ provider: 'saucelabs', username: 'qa', access_key: 'k3', region: 'eu-central-1' }, { name: 'chromium', engine: 'chromium' }, meta);
    assert.deepEqual(c, {
      kind: 'selenium', url: 'https://ondemand.eu-central-1.saucelabs.com/wd/hub',
      capabilities: { browserName: 'chrome', browserVersion: 'latest', platformName: 'Windows 11', 'sauce:options': { username: 'qa', accessKey: 'k3', name: meta.name, build: meta.build } },
    });
    assert.deepEqual(gridConnection({ provider: 'playwright', ws_endpoint: 'ws://grid:3000/' }, { name: 'firefox', engine: 'firefox' }, meta), { kind: 'connect', engine: 'firefox', wsEndpoint: 'ws://grid:3000/' });
  });

  it('takes grid credentials from the environment when the agent has none', () => {
    process.env.LT_USERNAME = 'env-user';
    process.env.LT_ACCESS_KEY = 'env-key';
    assert.deepEqual(gridCredentials({ provider: 'lambdatest' }), { username: 'env-user', accessKey: 'env-key' });
    assert.deepEqual(gridCredentials({ provider: 'lambdatest', username: 'mine', access_key: 'k' }), { username: 'mine', accessKey: 'k' });
    delete process.env.LT_USERNAME;
    delete process.env.LT_ACCESS_KEY;
  });
});
