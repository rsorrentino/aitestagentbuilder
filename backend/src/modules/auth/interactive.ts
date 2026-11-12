/**
 * "Sign in once": a person completes the sign-in of a login profile or a
 * Salesforce persona in a browser that runs on the server, seeing its
 * screen in the UI — whatever the MFA is (push approval, SMS code, number
 * matching, a code from a hardware token). The session, with its "remember
 * this device" cookies, is then saved (encrypted) and runs reuse it.
 *
 * Inputs are raw clicks, typing and keys, so any sign-in page works. The
 * stored password and authenticator code can be typed without showing them.
 * Typed text is never stored or logged.
 */

import crypto from 'crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../execution/browser.js';
import { maskSecrets } from '../../infra/security/secrets.js';
import { AppSessions, PASSWORD_SELECTORS, USERNAME_SELECTORS, CODE_SELECTORS } from './app-login.js';
import { LoginProfile } from './profiles.js';
import { captureState, IdentityKind, SessionInfo, SessionVault } from './session-vault.js';
import { totpFor } from '../salesforce/totp.js';

export const VIEWPORT = { width: 1280, height: 800 };
const IDLE_MS = 10 * 60 * 1000;

export class SignInError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface Identity {
  kind: IdentityKind;
  name: string;
  username?: string;
  password?: string;
  totpSecret?: string;
  /** Page to start at (the sign-in page) */
  startUrl: string;
  maxAgeHours: number;
  /** Is the page signed in? */
  signedIn: (page: Page) => Promise<boolean>;
}

/** Identity of a login profile. */
export function profileIdentity(sessions: AppSessions, profile: LoginProfile, baseUrl: string): Identity {
  return {
    kind: 'app',
    name: profile.name,
    username: profile.username,
    password: profile.password,
    totpSecret: profile.totp_secret,
    startUrl: new URL(profile.login_url || 'login', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
    maxAgeHours: profile.session.maxAgeHours,
    signedIn: (page) => sessions.isSignedIn(page, profile),
  };
}

export class SignInSession {
  readonly id = `SIGNIN-${crypto.randomBytes(8).toString('hex')}`;
  lastUsed = Date.now();
  private browser?: Browser;
  private context?: BrowserContext;
  page?: Page;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    readonly projectId: string,
    readonly userId: string,
    readonly agentId: string,
    readonly identity: Identity,
    private secretList: string[],
  ) {}

  async start(): Promise<void> {
    this.browser = await launchBrowser();
    this.context = await this.browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    await this.page.goto(this.identity.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.lastUsed = Date.now();
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  mask(text: string): string {
    return maskSecrets(text, this.secretList);
  }

  async state(): Promise<{ id: string; kind: IdentityKind; identity: string; url: string; title: string; viewport: typeof VIEWPORT; canFill: { username: boolean; password: boolean; code: boolean } }> {
    const page = this.page!;
    return {
      id: this.id,
      kind: this.identity.kind,
      identity: this.identity.name,
      url: this.mask(page.url()),
      title: this.mask(await page.title().catch(() => '')),
      viewport: VIEWPORT,
      canFill: { username: !!this.identity.username, password: !!this.identity.password, code: !!this.identity.totpSecret },
    };
  }

  screenshot(): Promise<Buffer> {
    return this.serial(() => this.page!.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 }));
  }

  /** A click, typing, a key, a stored value typed into the field that needs it, or an address. */
  input(input: { type: string; x?: number; y?: number; text?: string; key?: string; what?: string; url?: string; dy?: number }): Promise<void> {
    return this.serial(async () => {
      const page = this.page!;
      switch (input.type) {
        case 'click':
          await page.mouse.click(Math.round(Number(input.x)), Math.round(Number(input.y)));
          break;
        case 'text':
          await page.keyboard.type(String(input.text ?? '').slice(0, 1000), { delay: 15 });
          break;
        case 'key': {
          const key = String(input.key ?? '');
          if (!/^(Enter|Tab|Escape|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|Shift\+Tab)$/.test(key)) throw new SignInError(`Key "${key}" is not allowed`);
          await page.keyboard.press(key === 'Space' ? ' ' : key);
          break;
        }
        case 'scroll':
          await page.mouse.wheel(0, Math.max(Math.min(Number(input.dy) || 0, 5000), -5000));
          break;
        case 'navigate': {
          const url = String(input.url ?? '');
          if (!/^https?:\/\//i.test(url)) throw new SignInError('Give a full http(s) address');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        }
        case 'fill':
          await this.fillStored(String(input.what));
          break;
        default:
          throw new SignInError(`Unknown input "${input.type}" (click, text, key, scroll, navigate, fill)`);
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    });
  }

  /** Type the stored user name, password or current authenticator code into the field for it (focused, or found). */
  private async fillStored(what: string): Promise<void> {
    const page = this.page!;
    const value = what === 'username' ? this.identity.username
      : what === 'password' ? this.identity.password
        : what === 'code' && this.identity.totpSecret ? totpFor(this.identity.totpSecret) : undefined;
    if (!value) throw new SignInError(`This ${this.identity.kind === 'app' ? 'login profile' : 'persona'} has no stored ${what === 'code' ? 'authenticator key' : what}`);
    const selectors = what === 'username' ? USERNAME_SELECTORS : what === 'password' ? PASSWORD_SELECTORS : CODE_SELECTORS;
    for (const s of selectors) {
      const field = page.locator(s).first();
      if (await field.isVisible().catch(() => false)) {
        await field.fill(value, { timeout: 5_000 });
        return;
      }
    }
    // No recognisable field: type into whatever has the focus
    const focused = await page.evaluate('!!document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)');
    if (!focused) throw new SignInError(`No ${what} field found: click into the field first`);
    await page.keyboard.type(value, { delay: 15 });
  }

  /** Save the session (when signed in, or when forced) to the vault. */
  finish(vault: SessionVault, opts: { force?: boolean; user?: string }): Promise<{ signedIn: boolean; session: SessionInfo }> {
    return this.serial(async () => {
      const page = this.page!;
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
      const signedIn = await this.identity.signedIn(page).catch(() => false);
      if (!signedIn && !opts.force) throw new SignInError('This page does not look signed in yet. Finish the sign-in, or save anyway', 409);
      const state = await captureState(this.context!);
      const session = await vault.save(this.agentId, this.identity.kind, this.identity.name,
        this.identity.kind === 'salesforce' ? { cookies: state.cookies, origins: [] } : state,
        { maxAgeHours: this.identity.maxAgeHours, capturedBy: 'interactive', user: opts.user });
      return { signedIn, session };
    });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }
}

export class SignInManager {
  private static instance?: SignInManager;
  private sessions = new Map<string, SignInSession>();
  private timer = setInterval(() => void this.sweep(), 60_000);

  static get(): SignInManager {
    if (!SignInManager.instance) SignInManager.instance = new SignInManager();
    return SignInManager.instance;
  }

  private constructor() {
    this.timer.unref?.();
  }

  get max(): number {
    return Math.max(1, parseInt(process.env.SIGNIN_MAX_SESSIONS || '', 10) || 4);
  }

  async open(session: SignInSession): Promise<SignInSession> {
    await this.sweep();
    if (this.sessions.size >= this.max) throw new SignInError(`All ${this.max} sign-in browsers are in use: close one, or raise SIGNIN_MAX_SESSIONS`, 429);
    this.sessions.set(session.id, session);
    try {
      await session.start();
    } catch (e) {
      this.sessions.delete(session.id);
      await session.close();
      throw new SignInError(`Could not open the sign-in page: ${session.mask(String((e as Error).message ?? e)).split('\n')[0]}`, 422);
    }
    return session;
  }

  find(id: string, projectId: string, userId: string): SignInSession {
    const s = this.sessions.get(id);
    if (!s || s.projectId !== projectId || s.userId !== userId) throw new SignInError('Sign-in session not found (it closes after 10 minutes without use)', 404);
    return s;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.close();
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastUsed > IDLE_MS) await this.close(id);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}
