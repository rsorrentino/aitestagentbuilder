/**
 * Where tests run: which browsers (and emulated devices), locally or on a cloud grid.
 *
 *   browsers: ["chromium", "firefox", "webkit", "iPhone 15", "Pixel 7"]
 *     every test runs once per entry; a device name (Playwright's device list) emulates that
 *     device (viewport, user agent, touch) in its browser engine.
 *   grid: { provider: browserstack | lambdatest | saucelabs | playwright, username, access_key, … }
 *     the browsers are started on the provider instead of this server: real Windows / macOS
 *     machines and browser versions this server does not have. "playwright" is any Playwright
 *     server (npx playwright run-server, Moon, Browserless, …) at ws_endpoint.
 */

import type { Browser, BrowserContextOptions } from 'playwright';
import { createRequire } from 'module';

export type Engine = 'chromium' | 'firefox' | 'webkit';
export const GRID_PROVIDERS = ['browserstack', 'lambdatest', 'saucelabs', 'playwright'] as const;
export type GridProvider = typeof GRID_PROVIDERS[number];

export interface Target {
  /** As written in the config: "firefox", "iPhone 15" */
  name: string;
  engine: Engine;
  /** Playwright device descriptor name, for emulated devices */
  device?: string;
}

export interface GridConfig {
  provider: GridProvider;
  username?: string;
  access_key?: string;
  /** Override (or, for provider "playwright", the address of) the endpoint */
  ws_endpoint?: string;
  /** Operating system: "Windows" / "OS X" (BrowserStack), "Windows 11" / "MacOS Ventura" (LambdaTest, Sauce Labs) */
  os?: string;
  os_version?: string;
  browser_version?: string;
  /** Sauce Labs data center: us-west-1 (default), eu-central-1, us-east-4 */
  region?: string;
  /** Extra provider capabilities, merged as given */
  capabilities?: Record<string, any>;
}

const ALIASES: Record<string, Engine> = { chromium: 'chromium', chrome: 'chromium', firefox: 'firefox', webkit: 'webkit', safari: 'webkit' };

const require_ = createRequire(import.meta.url);
let deviceList: Record<string, any> | null = null;
/** Playwright's device descriptors (loaded lazily: playwright is a large module). */
export function playwrightDevices(): Record<string, any> {
  if (!deviceList) deviceList = (require_('playwright') as typeof import('playwright')).devices;
  return deviceList!;
}

export const defaultEngine = (): Engine => ALIASES[String(process.env.PLAYWRIGHT_BROWSER || 'chromium').toLowerCase()] ?? 'chromium';

/** The targets of an agent: config.browsers, or the server's default browser. */
export function resolveTargets(config: any): Target[] {
  const list: any[] = Array.isArray(config?.browsers) && config.browsers.length ? config.browsers : [defaultEngine()];
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const raw of list) {
    const name = String(raw).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const engine = ALIASES[name.toLowerCase()];
    if (engine) out.push({ name: name.toLowerCase() === 'chrome' || name.toLowerCase() === 'safari' ? name.toLowerCase() : engine, engine });
    else {
      const d = playwrightDevices()[name];
      if (!d) throw new Error(`Unknown browser or device "${name}"`);
      out.push({ name, engine: d.defaultBrowserType as Engine, device: name });
    }
  }
  return out;
}

/** Tests run at the same time per browser: agent setting parallel (1–16), capped by MAX_PARALLEL_TESTS (default 8). */
export function parallelism(config: any): number {
  const cap = Math.min(Math.max(parseInt(process.env.MAX_PARALLEL_TESTS || '8', 10) || 8, 1), 32);
  const wanted = Math.floor(Number(config?.parallel ?? 1)) || 1;
  return Math.min(Math.max(wanted, 1), cap);
}

export function validateTargets(config: any): string[] {
  const errors: string[] = [];
  if (config?.parallel !== undefined && (!Number.isInteger(config.parallel) || config.parallel < 1 || config.parallel > 16)) {
    errors.push('config.parallel must be a whole number of tests to run at the same time, 1–16');
  }
  if (config?.browsers !== undefined) {
    if (!Array.isArray(config.browsers) || config.browsers.some((b: any) => typeof b !== 'string' || !b.trim())) errors.push('config.browsers must be a list such as ["chromium", "firefox", "webkit", "iPhone 15"]');
    else {
      const devices = playwrightDevices();
      const unknown = config.browsers.filter((b: string) => !ALIASES[b.trim().toLowerCase()] && !devices[b.trim()]);
      if (unknown.length) errors.push(`config.browsers: unknown ${unknown.map((u: string) => `"${u}"`).join(', ')} (use chromium, firefox, webkit, or a Playwright device name such as "iPhone 15", "Pixel 7", "iPad Pro 11")`);
      if (config.browsers.length > 10) errors.push('config.browsers: at most 10');
    }
  }
  const g = config?.grid;
  if (g !== undefined && g !== null) {
    if (typeof g !== 'object' || Array.isArray(g)) return [...errors, 'config.grid must be an object'];
    if (!GRID_PROVIDERS.includes(g.provider)) errors.push(`config.grid.provider must be one of ${GRID_PROVIDERS.join(', ')}`);
    if (g.provider === 'playwright' && !/^wss?:\/\//.test(String(g.ws_endpoint ?? ''))) errors.push('config.grid.ws_endpoint must be the ws:// or wss:// address of the Playwright server');
    if (g.ws_endpoint && !/^(wss?|https?):\/\//.test(String(g.ws_endpoint))) errors.push('config.grid.ws_endpoint must be a ws(s):// or http(s):// address');
    if (g.capabilities !== undefined && (typeof g.capabilities !== 'object' || Array.isArray(g.capabilities))) errors.push('config.grid.capabilities must be an object');
    if (g.provider === 'saucelabs') {
      const engines = (() => { try { return resolveTargets(config).map((t) => t.engine); } catch { return []; } })();
      if (engines.some((e) => e !== 'chromium')) errors.push('config.grid: Sauce Labs runs Playwright through its Selenium Grid, which supports Chrome / Chromium only (use BrowserStack or LambdaTest for Firefox and WebKit)');
    }
  }
  return errors;
}

/** Credentials: the agent's, else the provider's usual environment variables. */
export function gridCredentials(g: GridConfig): { username: string; accessKey: string } {
  const env = process.env;
  const [u, k] = g.provider === 'browserstack' ? ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY']
    : g.provider === 'lambdatest' ? ['LT_USERNAME', 'LT_ACCESS_KEY']
      : g.provider === 'saucelabs' ? ['SAUCE_USERNAME', 'SAUCE_ACCESS_KEY'] : ['', ''];
  return { username: g.username || (u ? env[u] ?? '' : ''), accessKey: g.access_key || (k ? env[k] ?? '' : '') };
}

export type GridConnection =
  | { kind: 'connect'; engine: Engine; wsEndpoint: string }
  | { kind: 'selenium'; url: string; capabilities: Record<string, any> };

/** How to reach a target on a grid (pure: unit-tested). */
export function gridConnection(g: GridConfig, target: Target, meta: { name: string; build: string; playwrightVersion: string }): GridConnection {
  const { username, accessKey } = gridCredentials(g);
  const extra = g.capabilities ?? {};
  const mac = target.engine === 'webkit';
  if (g.provider === 'browserstack') {
    const caps = {
      browser: target.engine === 'chromium' ? (target.name === 'chromium' ? 'playwright-chromium' : 'chrome') : `playwright-${target.engine}`,
      browser_version: g.browser_version ?? 'latest',
      os: g.os ?? (mac ? 'OS X' : 'Windows'),
      os_version: g.os_version ?? (mac ? 'Sonoma' : '11'),
      name: meta.name, build: meta.build,
      'browserstack.username': username, 'browserstack.accessKey': accessKey,
      'client.playwrightVersion': meta.playwrightVersion,
      ...extra,
    };
    // BrowserStack picks the browser from the capabilities: connect with the chromium client for all of them
    return { kind: 'connect', engine: 'chromium', wsEndpoint: `${g.ws_endpoint || 'wss://cdp.browserstack.com/playwright'}?caps=${encodeURIComponent(JSON.stringify(caps))}` };
  }
  if (g.provider === 'lambdatest') {
    const { 'LT:Options': ltExtra, ...rest } = extra as any;
    const caps = {
      browserName: target.engine === 'chromium' ? (target.name === 'chromium' ? 'pw-chromium' : 'Chrome') : `pw-${target.engine}`,
      browserVersion: g.browser_version ?? 'latest',
      'LT:Options': {
        platform: g.os ?? (mac ? 'MacOS Sonoma' : 'Windows 11'),
        build: meta.build, name: meta.name, user: username, accessKey,
        playwrightClientVersion: meta.playwrightVersion,
        ...(ltExtra ?? {}),
      },
      ...rest,
    };
    return { kind: 'connect', engine: 'chromium', wsEndpoint: `${g.ws_endpoint || 'wss://cdp.lambdatest.com/playwright'}?capabilities=${encodeURIComponent(JSON.stringify(caps))}` };
  }
  if (g.provider === 'saucelabs') {
    const { 'sauce:options': sauceExtra, ...rest } = extra as any;
    return {
      kind: 'selenium',
      url: g.ws_endpoint || `https://ondemand.${g.region || 'us-west-1'}.saucelabs.com/wd/hub`,
      capabilities: {
        browserName: 'chrome', browserVersion: g.browser_version ?? 'latest', platformName: g.os ?? 'Windows 11',
        'sauce:options': { username, accessKey, name: meta.name, build: meta.build, ...(sauceExtra ?? {}) },
        ...rest,
      },
    };
  }
  // Any Playwright server: it starts the browser type the client asks for
  return { kind: 'connect', engine: target.engine, wsEndpoint: String(g.ws_endpoint) };
}

/** Context options of an emulated device (viewport, user agent, touch, scale). */
export function deviceOptions(target: Target): BrowserContextOptions {
  if (!target.device) return {};
  const { defaultBrowserType: _b, ...d } = playwrightDevices()[target.device];
  return d;
}

/** Selenium Grid settings are read from the environment by Playwright at launch: one launch at a time. */
let seleniumLock: Promise<unknown> = Promise.resolve();

/** Start a target's browser: on this server, or on the agent's grid. */
export async function launchTarget(target: Target, grid: GridConfig | undefined, meta: { name: string; build: string }): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run: cd backend && npm install && npx playwright install chromium');
  }
  if (!grid) {
    const headless = (process.env.PLAYWRIGHT_HEADLESS ?? 'true').toLowerCase() !== 'false';
    // A custom executable only applies to the default engine
    const executablePath = target.engine === defaultEngine() ? process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined : undefined;
    try {
      return await playwright[target.engine].launch({ headless, executablePath, ...(target.name === 'chrome' ? { channel: 'chrome' } : {}) });
    } catch (error: any) {
      if (/Executable doesn't exist|browserType.launch|is not found|Chromium distribution/i.test(error.message)) {
        throw new Error(`Could not start ${target.name} on this server. Install it with: cd backend && npx playwright install ${target.name === 'chrome' ? 'chrome' : target.engine} — or run on a cloud grid (agent setting grid)`);
      }
      throw error;
    }
  }
  const version = createRequire(import.meta.url)('playwright/package.json').version as string;
  const conn = gridConnection(grid, target, { ...meta, playwrightVersion: version });
  if (conn.kind === 'connect') {
    try {
      return await playwright[conn.engine].connect(conn.wsEndpoint, { timeout: 120_000 });
    } catch (error: any) {
      throw new Error(`Could not start ${target.name} on ${grid.provider}: ${String(error.message).split('\n')[0].replace(/(accessKey|access_key|caps|capabilities)=[^\s&"]+/gi, '$1=…')}`);
    }
  }
  const run = seleniumLock.then(async () => {
    const before = { url: process.env.SELENIUM_REMOTE_URL, caps: process.env.SELENIUM_REMOTE_CAPABILITIES };
    process.env.SELENIUM_REMOTE_URL = conn.url;
    process.env.SELENIUM_REMOTE_CAPABILITIES = JSON.stringify(conn.capabilities);
    try {
      return await playwright.chromium.launch({ timeout: 180_000 });
    } catch (error: any) {
      throw new Error(`Could not start ${target.name} on ${grid.provider}: ${String(error.message).split('\n')[0]}`);
    } finally {
      for (const [k, v] of [['SELENIUM_REMOTE_URL', before.url], ['SELENIUM_REMOTE_CAPABILITIES', before.caps]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  seleniumLock = run.catch(() => undefined);
  return run;
}

/** Mark the provider's session passed / failed so its dashboard matches (BrowserStack, LambdaTest). */
export async function markGridSession(browser: Browser, grid: GridConfig | undefined, passed: boolean, reason: string): Promise<void> {
  if (!grid || !['browserstack', 'lambdatest'].includes(grid.provider)) return;
  const command = grid.provider === 'browserstack'
    ? `browserstack_executor: ${JSON.stringify({ action: 'setSessionStatus', arguments: { status: passed ? 'passed' : 'failed', reason: reason.slice(0, 250) } })}`
    : `lambdatest_action: ${JSON.stringify({ action: 'setTestStatus', arguments: { status: passed ? 'passed' : 'failed', remark: reason.slice(0, 250) } })}`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.evaluate(() => undefined, command);
  } finally {
    await context.close().catch(() => undefined);
  }
}
