/**
 * Browser helpers built on Playwright.
 */

import type { Browser, Page } from 'playwright';
import '../../infra/config/env.js';

export async function launchBrowser(): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run: cd backend && npm install && npx playwright install chromium');
  }

  const browserName = (process.env.PLAYWRIGHT_BROWSER || 'chromium') as 'chromium' | 'firefox' | 'webkit';
  const headless = (process.env.PLAYWRIGHT_HEADLESS ?? 'true').toLowerCase() !== 'false';
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;

  try {
    return await playwright[browserName].launch({ headless, executablePath });
  } catch (error: any) {
    if (/Executable doesn't exist|browserType.launch/i.test(error.message)) {
      throw new Error(`Could not start ${browserName}. Install the browser with: cd backend && npx playwright install ${browserName}`);
    }
    throw error;
  }
}

/**
 * Compact outline of the interactive elements on a page, with a suggested
 * selector for each. Used to give the LLM real selectors to work with.
 */
/**
 * Runs inside the page. Kept as plain JavaScript text: a compiled function would
 * be rewritten by the TypeScript toolchain (e.g. tsx adds a __name() helper to
 * nested functions) and fail in the browser, where that helper does not exist.
 */
const OUTLINE_SCRIPT = `(max) => {
  const out = [];
  const esc = (s) => s.replace(/\\s+/g, ' ').trim().slice(0, 80);
  const selectorFor = (el) => {
    const id = el.getAttribute('id');
    if (id && /^[A-Za-z][\\w-]*$/.test(id)) return '#' + id;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) return '[data-testid="' + testId + '"]';
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const text = esc(el.innerText || '');
    if (text && text.length < 40) return 'text=' + text;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return '[placeholder="' + placeholder + '"]';
    const aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + aria + '"]';
    return el.tagName.toLowerCase();
  };
  if (document.title) out.push('title: ' + esc(document.title));
  document.querySelectorAll('h1, h2').forEach((h) => {
    if (out.length < max) out.push(h.tagName.toLowerCase() + ': ' + esc(h.innerText || ''));
  });
  const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], label');
  nodes.forEach((el) => {
    if (out.length >= max) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const type = el.getAttribute('type');
    const text = esc(el.innerText || el.value || '');
    const href = el.getAttribute('href');
    const options = el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 15).map((o) => esc(o.text)).join('|') : '';
    const checked = (type === 'checkbox' || type === 'radio') ? (el.checked ? ' checked' : ' unchecked') : '';
    out.push(el.tagName.toLowerCase() + (type ? '[type=' + type + ']' : '') + ' selector="' + selectorFor(el) + '"'
      + (text && !options ? ' text="' + text + '"' : '') + (options ? ' options="' + options + '"' : '') + checked
      + (href ? ' href="' + href.slice(0, 80) + '"' : ''));
  });
  return out;
}`;

/** Compact text outline of a page's headings and interactive elements, for the AI. */
export async function outlinePage(page: Page, maxItems = 150): Promise<string> {
  const max = Math.max(1, Math.floor(Number(maxItems) || 150));
  const items = (await page.evaluate(`(${OUTLINE_SCRIPT})(${max})`)) as string[];
  return `url: ${page.url()}\n${items.join('\n')}`;
}

export async function capturePageOutline(url: string): Promise<string> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    return await outlinePage(page);
  } finally {
    await browser.close();
  }
}
