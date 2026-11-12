/**
 * Signs a browser page in as a login profile of any web application, with
 * multi-factor authentication, and keeps the session for later tests and runs.
 *
 * The sign-in form is found by itself: username / email, password, "Next" for
 * two-step forms (Microsoft, Okta, Google, Auth0, Keycloak, …), a verification
 * code page answered with the authenticator code, "Stay signed in? / Trust this
 * device" prompts accepted. Selectors in the profile override what is found.
 */

import { KeyedLock } from './keyed-lock.js';
import type { Page } from 'playwright';
import { freshTotp } from '../salesforce/totp.js';
import { AuthSettings, findProfile, LoginProfile } from './profiles.js';
import { applyState, captureState, SessionVault } from './session-vault.js';
import type { CodeFetcher } from './code-sources.js';

export const USERNAME_SELECTORS = [
  'input[autocomplete="username"]', 'input[type="email"]', 'input[name="loginfmt"]', 'input[name="identifier"]', 'input[name="username" i]',
  'input[id*="user" i]:not([type="hidden"]):not([type="checkbox"])', 'input[name*="user" i]:not([type="hidden"]):not([type="checkbox"])',
  'input[name*="email" i]:not([type="hidden"])', 'input[name="login"]', 'input[id="login"]',
];
export const PASSWORD_SELECTORS = ['input[type="password"]'];
export const CODE_SELECTORS = [
  'input[autocomplete="one-time-code"]', 'input[name="otc"]', 'input[name="credentials.passcode"]', 'input[name*="totp" i]', 'input[name*="otp" i]',
  'input[id*="otp" i]', 'input[name*="mfa" i]:not([type="checkbox"])', 'input[name*="verification" i]', 'input[id*="verification" i]',
  'input[name="code"]', 'input[id="code"]', 'input[name*="passcode" i]', 'input[name="tc"]', 'input[name="emc"]', 'input[name="smc"]',
  'input[inputmode="numeric"][maxlength="6"]', 'input[maxlength="6"][type="tel"]',
];
const SUBMIT_NAME = /^\s*(next|continue|sign ?in|log ?in|login|submit|verify|confirm|weiter|anmelden|accedi|avanti|continuer|connexion|suivant|siguiente|iniciar sesi[oó]n|entrar)\s*$/i;
const REMEMBER_LABEL = /remember|trust|don'?t ask|do not ask|keep me signed in|stay signed in|ricorda|merken/i;
const STAY_SIGNED_IN_TEXT = /stay signed in\?|trust this (device|browser)\?|remember this (device|browser)\?/i;
const ERROR_TEXT = /(incorrect|invalid|wrong|not recognized|doesn'?t match|failed|locked|try again)[^.\n]{0,80}(password|user ?name|credentials|email|code|account)|(password|user ?name|credentials|code)[^.\n]{0,40}(incorrect|invalid|wrong|not correct)/i;

export type CodeSource = (profile: LoginProfile, page: Page, since: Date) => Promise<string | null>;

export interface AppLoginResult {
  profile: LoginProfile;
  reused: boolean;
  usedMfa: boolean;
  message: string;
}

const visible = async (page: Page, selectors: string[]): Promise<string | null> => {
  for (const s of selectors) {
    if (await page.locator(s).first().isVisible().catch(() => false)) return s;
  }
  return null;
};

function absolute(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

/** The authenticator-app code source, waiting out codes about to expire. */
export const totpCode: CodeSource = async (profile, page) => {
  if (!profile.totp_secret) return null;
  return freshTotp(profile.totp_secret, (ms) => page.waitForTimeout(ms));
};

export class AppSessions {
  constructor(
    readonly settings: AuthSettings,
    private baseUrl: string,
    private opts: { agentId?: string; vault?: SessionVault; codeSources?: CodeSource[]; codes?: CodeFetcher } = {},
  ) {}

  profile(name?: string): LoginProfile {
    return findProfile(this.settings, name);
  }

  private loginUrl(p: LoginProfile): string {
    return absolute(this.baseUrl, p.login_url || 'login');
  }

  /** Signed in: the profile's success check, or else no password / code field on screen and not on the login URL. */
  async isSignedIn(page: Page, p: LoginProfile): Promise<boolean> {
    if (p.success.selector) return page.locator(p.success.selector).first().isVisible().catch(() => false);
    if (p.success.url_contains) return page.url().includes(p.success.url_contains);
    if (await visible(page, [p.selectors.password ?? '', ...PASSWORD_SELECTORS].filter(Boolean))) return false;
    if (await visible(page, [p.selectors.code ?? '', ...CODE_SELECTORS].filter(Boolean))) return false;
    const login = new URL(this.loginUrl(p));
    const here = new URL(page.url());
    return !(here.origin === login.origin && here.pathname.replace(/\/+$/, '') === login.pathname.replace(/\/+$/, ''));
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  /** Click the form's submit control near a field, or press Enter in it. */
  private async submit(page: Page, field: string, override?: string): Promise<void> {
    if (override && (await page.locator(override).first().isVisible().catch(() => false))) {
      await page.locator(override).first().click({ timeout: 10_000 });
    } else {
      const button = page.getByRole('button', { name: SUBMIT_NAME }).or(page.locator('input[type="submit"]')).first();
      if (await button.isVisible().catch(() => false)) await button.click({ timeout: 10_000 });
      else await page.locator(field).first().press('Enter');
    }
    await this.settle(page);
  }

  /** Tick "remember this device / stay signed in" boxes so the application asks for MFA less often. */
  private async rememberDevice(page: Page): Promise<void> {
    const boxes = page.locator('input[type="checkbox"]');
    const n = Math.min(await boxes.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      const box = boxes.nth(i);
      if (!(await box.isVisible().catch(() => false)) || (await box.isChecked().catch(() => true))) continue;
      const label = await box.evaluate((el: any) => (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || el.id || '')).catch(() => '');
      if (REMEMBER_LABEL.test(String(label))) await box.check({ timeout: 5_000 }).catch(() => undefined);
    }
  }

  /** Codes by email / SMS from the profile's code source. */
  private messageCode: CodeSource = async (p, _page, since) => {
    if (!p.codes || !this.opts.codes) return null;
    return (await this.opts.codes(p.codes.source, { since, to: p.codes.to })).code;
  };

  private async code(p: LoginProfile, page: Page, since: Date): Promise<string | null> {
    // A page that says the code was emailed / texted is answered from the mailbox or phone first
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const messageFirst = !!p.codes && (!p.totp_secret || /e-?mail|sent (it )?to|text message|\bsms\b|phone/i.test(body));
    const sources = messageFirst ? [this.messageCode, totpCode] : [totpCode, this.messageCode];
    for (const source of [...sources, ...(this.opts.codeSources ?? [])]) {
      const c = await source(p, page, since);
      if (c) return c;
    }
    return null;
  }

  /** Fill the sign-in pages until signed in (or stuck). */
  private async formLogin(page: Page, p: LoginProfile): Promise<{ usedMfa: boolean }> {
    if (!p.username || !p.password) {
      throw new Error(`The saved session of ${p.name} has expired (or was never saved) and ${p.name} cannot sign in by itself (no stored password): `
        + 'use "Sign in once…" again (Agent → Sign-in & MFA)');
    }
    const since = new Date();
    await page.goto(this.loginUrl(p), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.settle(page);
    let usedMfa = false;
    let lastUrl = '';
    let sameCount = 0;
    for (let round = 0; round < 8; round++) {
      const body = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 5000);
      // "Stay signed in?" / "Trust this device?": accept, so the application asks less often
      if (STAY_SIGNED_IN_TEXT.test(body)) {
        await this.rememberDevice(page);
        const yes = page.getByRole('button', { name: /^(yes|trust|remember|continue)\b/i }).or(page.locator('input[type="submit"][value="Yes" i]')).first();
        if (await yes.isVisible().catch(() => false)) {
          await yes.click({ timeout: 10_000 });
          await this.settle(page);
          continue;
        }
      }
      if (round > 0 && (await this.isSignedIn(page, p))) return { usedMfa };
      const err = body.match(ERROR_TEXT);
      if (err && round > 0) throw new Error(`Sign-in as ${p.name} failed: ${err[0].trim()}`);

      const codeSel = await visible(page, [p.selectors.code ?? '', ...CODE_SELECTORS].filter(Boolean));
      const passSel = await visible(page, [p.selectors.password ?? '', ...PASSWORD_SELECTORS].filter(Boolean));
      if (codeSel && !passSel) {
        const code = await this.code(p, page, since);
        if (!code) {
          throw new Error(`${new URL(page.url()).hostname} asked ${p.name} for a verification code. Set the profile's authenticator (TOTP) key, `
            + 'connect a mailbox or phone number for codes (code source), or sign in once interactively so runs reuse the session');
        }
        await this.rememberDevice(page);
        await page.locator(codeSel).first().fill(code, { timeout: 10_000 });
        await this.submit(page, codeSel, p.selectors.code_submit);
        usedMfa = true;
        continue;
      }
      const userSel = await visible(page, [p.selectors.username ?? '', ...USERNAME_SELECTORS].filter(Boolean));
      if (passSel) {
        if (userSel && !(await page.locator(userSel).first().inputValue().catch(() => ''))) await page.locator(userSel).first().fill(p.username, { timeout: 10_000 });
        await page.locator(passSel).first().fill(p.password, { timeout: 10_000 });
        await this.rememberDevice(page);
        await this.submit(page, passSel, p.selectors.submit);
        continue;
      }
      if (userSel) {
        // Identifier-first: user name, then "Next"
        await page.locator(userSel).first().fill(p.username, { timeout: 10_000 });
        await this.submit(page, userSel, p.selectors.submit);
        continue;
      }
      // Nothing to fill: either signed in, or a page we do not understand
      if (page.url() === lastUrl && ++sameCount >= 1) break;
      lastUrl = page.url();
      await page.waitForTimeout(1000);
    }
    if (await this.isSignedIn(page, p)) return { usedMfa };
    throw new Error(`Sign-in as ${p.name} did not complete: stuck on ${page.url()}. Set the profile's selectors or success check, or sign in once interactively`);
  }

  private signIns = new KeyedLock();

  /** Sign in (parallel tests as the same user take turns, the later ones reuse the saved session). */
  async login(page: Page, name?: string, opts: { fresh?: boolean; landing?: string } = {}): Promise<AppLoginResult> {
    return this.signIns.run(this.profile(name).name, () => this.loginNow(page, name, opts));
  }

  private async loginNow(page: Page, name?: string, opts: { fresh?: boolean; landing?: string } = {}): Promise<AppLoginResult> {
    const p = this.profile(name);
    const context = page.context();
    const landing = absolute(this.baseUrl, opts.landing || p.landing_path || '/');
    const vault = this.opts.agentId && p.session.reuse ? this.opts.vault : undefined;

    if (vault && !opts.fresh) {
      const saved = await vault.load(this.opts.agentId!, 'app', p.name).catch(() => null);
      if (saved) {
        await context.clearCookies();
        await applyState(context, saved.state);
        await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await this.settle(page);
        if (await this.isSignedIn(page, p)) {
          return { profile: p, reused: true, usedMfa: false, message: `Signed in as ${p.name} with the saved session (from ${saved.capturedAt.slice(0, 16).replace('T', ' ')} UTC)` };
        }
        // Expired on the server: keep the device cookies, sign in again
      }
    }

    const { usedMfa } = await this.formLogin(page, p);
    if (opts.landing || p.landing_path) {
      await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.settle(page);
      // The application sent us back to sign-in: the session did not take
      if (!(await this.isSignedIn(page, p))) {
        throw new Error(`Sign-in as ${p.name} did not complete: ${landing} shows the sign-in page again. Set the profile's success check, or sign in once interactively`);
      }
    }
    if (vault) await vault.save(this.opts.agentId!, 'app', p.name, await captureState(context), { maxAgeHours: p.session.maxAgeHours }).catch(() => undefined);
    return { profile: p, reused: false, usedMfa, message: `Signed in as ${p.name} (${p.username})${usedMfa ? ' with an authenticator code' : ''}` };
  }
}
