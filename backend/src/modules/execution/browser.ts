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
export async function outlinePage(page: Page, maxItems = 150): Promise<string> {
  const items: string[] = await page.evaluate((max: number) => {
    const out: string[] = [];
    const esc = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
    const selectorFor = (el: Element): string => {
      const id = el.getAttribute('id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) return `[data-testid="${testId}"]`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const text = esc((el as HTMLElement).innerText || '');
      if (text && text.length < 40) return `text=${text}`;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return `[placeholder="${placeholder}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `[aria-label="${aria}"]`;
      return el.tagName.toLowerCase();
    };

    const title = document.title;
    if (title) out.push(`title: ${esc(title)}`);
    document.querySelectorAll('h1, h2').forEach((h) => {
      if (out.length < max) out.push(`${h.tagName.toLowerCase()}: ${esc((h as HTMLElement).innerText || '')}`);
    });

    const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], label');
    nodes.forEach((el) => {
      if (out.length >= max) return;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const text = esc((el as HTMLElement).innerText || (el as HTMLInputElement).value || '');
      const href = el.getAttribute('href');
      out.push(
        `${tag}${type ? `[type=${type}]` : ''} selector="${selectorFor(el)}"` +
        `${text ? ` text="${text}"` : ''}${href ? ` href="${href.slice(0, 80)}"` : ''}`,
      );
    });
    return out;
  }, maxItems);

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
