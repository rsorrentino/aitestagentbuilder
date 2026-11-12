/**
 * Logs a browser page in as a Salesforce persona, and gives API access
 * "as" that persona for identity and permission checks.
 *
 * One instance lives for a whole run: OAuth tokens and browser session
 * cookies are cached per persona, so a matrix of tests does not repeat the
 * full login (and MFA) for every test.
 */

import type { BrowserContext, Page } from 'playwright';
import { jwtBearerToken, passwordToken, TokenResult, uiBridgeUrl } from './oauth.js';
import { secondsRemaining, totp } from './totp.js';
import { FieldAccess, ObjectAccess, RecordAccess, SalesforceAdminChecks, SalesforceApi, SfIdentity } from './sf-api.js';
import { findPersona, Persona, SalesforceSettings } from './personas.js';
import type { SessionVault } from '../auth/session-vault.js';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

const DEFAULT_LANDING = '/lightning/page/home';
const CODE_SELECTORS = ['#tc', 'input[name="tc"]', '#emc', 'input[name="emc"]', '#smc', 'input[name="smc"]', 'input[autocomplete="one-time-code"]'];
const SUBMIT_SELECTORS = ['#save', 'button#save', 'input[type="submit"][value*="Verify" i]', 'button:has-text("Verify")'];
const ERROR_SELECTORS = ['#error', '.loginError', '#theloginform .error'];
const SKIP_INTERSTITIALS = ['a:has-text("Register My Phone")', 'a:has-text("Remind Me Later")', 'button:has-text("Remind Me Later")'];

export interface PersonaApi {
  /** 'self' = acting as the persona; 'admin' = an admin persona inspecting the persona's user. */
  mode: 'self' | 'admin';
  api: SalesforceApi;
  userId: string;
}

export interface LoginResult {
  persona: Persona;
  message: string;
  reused: boolean;
}

export class SalesforceSessions {
  private tokens = new Map<string, TokenResult>();
  private cookies = new Map<string, Cookie[]>();
  private userIds = new Map<string, string>();
  /** Persona currently logged in per browser context. */
  private active = new WeakMap<BrowserContext, string>();

  /**
   * With a vault, persona sessions are also kept across runs (encrypted), with the device-activation cookies
   * that keep Salesforce from asking for an emailed verification code at every new login.
   */
  constructor(public settings: SalesforceSettings, private store?: { agentId: string; vault: SessionVault; maxAgeHours?: number }) {}

  /** Session credentials obtained during the run (access tokens, session ids), for redaction. */
  sessionSecrets(): string[] {
    const out = [...this.tokens.values()].map((t) => t.accessToken);
    for (const cookies of this.cookies.values()) {
      for (const c of cookies) if (c.name === 'sid') out.push(c.value);
    }
    return out.filter((v) => v && v.length >= 8);
  }

  persona(name?: string): Persona {
    return findPersona(this.settings, name);
  }

  currentPersona(page: Page): string | undefined {
    return this.active.get(page.context());
  }

  private landing(persona: Persona, override?: string): string {
    return override || persona.landing_path || DEFAULT_LANDING;
  }

  private abs(base: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  // ---------------------------------------------------------------- tokens

  /** OAuth token for personas that log in through OAuth; null for UI-only methods. */
  async token(persona: Persona): Promise<TokenResult | null> {
    if (persona.auth_method !== 'jwt' && persona.auth_method !== 'oauth_password') return null;
    const cached = this.tokens.get(persona.name);
    if (cached) return cached;
    const app = this.settings.connectedApp;
    let result: TokenResult;
    if (persona.auth_method === 'jwt') {
      if (!app.client_id || !app.private_key) throw new Error(`Persona "${persona.name}" uses the JWT bearer flow: set the connected app consumer key and private key`);
      result = await jwtBearerToken({ loginUrl: this.settings.loginUrl, clientId: app.client_id, privateKeyPem: app.private_key, username: persona.username });
    } else {
      if (!app.client_id || !app.client_secret) throw new Error(`Persona "${persona.name}" uses the OAuth password flow: set the connected app consumer key and secret`);
      if (!persona.password) throw new Error(`Persona "${persona.name}" has no password`);
      result = await passwordToken({
        loginUrl: this.settings.loginUrl, clientId: app.client_id, clientSecret: app.client_secret,
        username: persona.username, password: persona.password, securityToken: persona.security_token,
      });
    }
    this.tokens.set(persona.name, result);
    return result;
  }

  // ---------------------------------------------------------------- browser login

  /** Log the page's browser context in as `name`. Any previous Salesforce session in the context is dropped. */
  async login(page: Page, name?: string, opts: { landing?: string; fresh?: boolean } = {}): Promise<LoginResult> {
    const persona = this.persona(name);
    const context = page.context();
    await context.clearCookies();
    this.active.delete(context);

    if (this.settings.reuseSessions && !opts.fresh && persona.auth_method !== 'login_as') {
      if (!this.cookies.has(persona.name) && this.store) {
        const stored = await this.store.vault.load(this.store.agentId, 'salesforce', persona.name).catch(() => null);
        if (stored?.state.cookies?.length) this.cookies.set(persona.name, stored.state.cookies as Cookie[]);
      }
      const saved = this.cookies.get(persona.name);
      if (saved?.length) {
        await context.addCookies(saved);
        await page.goto(this.abs(this.settings.instanceUrl, this.landing(persona, opts.landing)), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => undefined);
        if (!(await this.onLoginPage(page))) {
          this.active.set(context, persona.name);
          return { persona, reused: true, message: `Logged in to Salesforce as ${persona.name} (${persona.username}) — reused session` };
        }
        this.cookies.delete(persona.name);
        await context.clearCookies();
      }
    }

    let how: string;
    switch (persona.auth_method) {
      case 'password':
      case 'password_totp':
        how = await this.uiLogin(page, persona, opts.landing);
        break;
      case 'jwt':
      case 'oauth_password':
        how = await this.tokenLogin(page, persona, opts.landing);
        break;
      case 'login_as':
        how = await this.loginAs(page, persona, opts.landing);
        break;
      default:
        throw new Error(`Unsupported auth_method "${(persona as any).auth_method}"`);
    }

    if (await this.onLoginPage(page)) {
      throw new Error(`Salesforce login as ${persona.name} did not complete — still on the login page (${page.url()})`);
    }
    this.active.set(context, persona.name);
    if (this.settings.reuseSessions && persona.auth_method !== 'login_as') {
      const cookies = await context.cookies();
      this.cookies.set(persona.name, cookies);
      if (this.store) {
        await this.store.vault.save(this.store.agentId, 'salesforce', persona.name, { cookies: cookies as any, origins: [] }, { maxAgeHours: this.store.maxAgeHours ?? 8 }).catch(() => undefined);
      }
    }
    return { persona, reused: false, message: `Logged in to Salesforce as ${persona.name} (${persona.username}) via ${how}` };
  }

  async logout(page: Page): Promise<void> {
    await page.goto(this.abs(this.settings.instanceUrl, '/secur/logout.jsp'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await page.context().clearCookies();
    this.active.delete(page.context());
  }

  private async onLoginPage(page: Page): Promise<boolean> {
    return (await page.locator('#username').isVisible().catch(() => false)) && (await page.locator('#Login').count().catch(() => 0)) > 0;
  }

  private async firstVisible(page: Page, selectors: string[]): Promise<string | null> {
    for (const s of selectors) {
      if (await page.locator(s).first().isVisible().catch(() => false)) return s;
    }
    return null;
  }

  private async loginError(page: Page): Promise<string | null> {
    for (const s of ERROR_SELECTORS) {
      const el = page.locator(s).first();
      if (await el.isVisible().catch(() => false)) {
        const text = (await el.innerText().catch(() => '')).trim();
        if (text) return text;
      }
    }
    return null;
  }

  private async uiLogin(page: Page, persona: Persona, landing?: string): Promise<string> {
    if (!persona.password) throw new Error(`Persona "${persona.name}" has no password`);
    const startUrl = new URL(this.settings.loginUrl.includes('://') ? this.settings.loginUrl : `https://${this.settings.loginUrl}`);
    const target = landing || persona.landing_path;
    if (target) startUrl.searchParams.set('startURL', target);
    await page.goto(startUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#username').fill(persona.username, { timeout: 15000 });
    await page.locator('#password').fill(persona.password, { timeout: 15000 });
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => undefined),
      page.locator('#Login').click({ timeout: 15000 }),
    ]);
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);

    let usedMfa = false;
    for (let i = 0; i < 4; i++) {
      const error = await this.loginError(page);
      if (error) throw new Error(`Salesforce login as ${persona.name} failed: ${error}`);

      const codeSelector = await this.firstVisible(page, this.settings.mfa.code_selector ? [this.settings.mfa.code_selector] : CODE_SELECTORS);
      if (codeSelector) {
        if (!persona.totp_secret) {
          const emailed = /emc|smc/.test(codeSelector);
          throw new Error(
            `Salesforce asked ${persona.name} for ${emailed ? 'an emailed/SMS' : 'a'} verification code. ` +
            (emailed
              ? 'Add the test runner\'s IP range to the profile\'s Login IP Ranges or Network Access, or register an authenticator app and set the persona\'s TOTP secret.'
              : 'Set the persona\'s TOTP secret (auth method password_totp), or use the JWT bearer method.'),
          );
        }
        if (/emc|smc/.test(codeSelector)) {
          throw new Error(`Salesforce asked ${persona.name} for an emailed/SMS code instead of the authenticator app — make the authenticator the user's default verification method.`);
        }
        // Avoid submitting a code that expires in flight.
        if (secondsRemaining() < 3) await page.waitForTimeout(secondsRemaining() * 1000 + 200);
        await page.locator(codeSelector).first().fill(totp(persona.totp_secret), { timeout: 10000 });
        const submit = await this.firstVisible(page, this.settings.mfa.submit_selector ? [this.settings.mfa.submit_selector] : SUBMIT_SELECTORS);
        if (!submit) throw new Error('Could not find the Verify button on the Salesforce verification page (set salesforce.mfa.submit_selector)');
        await page.locator(submit).first().click({ timeout: 10000 });
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);
        usedMfa = true;
        continue;
      }

      const skip = await this.firstVisible(page, SKIP_INTERSTITIALS);
      if (skip) {
        await page.locator(skip).first().click({ timeout: 10000 });
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);
        continue;
      }
      break;
    }
    const error = await this.loginError(page);
    if (error) throw new Error(`Salesforce login as ${persona.name} failed: ${error}`);
    return usedMfa ? 'username/password + authenticator code (TOTP)' : 'username/password';
  }

  private async tokenLogin(page: Page, persona: Persona, landing?: string): Promise<string> {
    const token = (await this.token(persona))!;
    const url = await uiBridgeUrl(token.instanceUrl, token.accessToken, this.landing(persona, landing), this.settings.frontdoorMode);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);
    return persona.auth_method === 'jwt' ? 'OAuth JWT bearer + frontdoor' : 'OAuth username-password + frontdoor';
  }

  private async loginAs(page: Page, persona: Persona, landing?: string): Promise<string> {
    if (!persona.login_as_via) throw new Error(`Persona "${persona.name}" uses login_as but has no login_as_via administrator`);
    const admin = this.persona(persona.login_as_via);
    await this.login(page, admin.name, { landing: DEFAULT_LANDING });
    const adminApi = await this.selfApi(page, admin);
    if (!adminApi) throw new Error(`Cannot reach the Salesforce API as ${admin.name} to look up the user to log in as`);
    const orgId = await adminApi.organizationId();
    const userId = persona.user_id || (await adminApi.userIdByUsername(persona.username));
    this.userIds.set(persona.name, userId);
    const su = new URL(this.abs(this.settings.instanceUrl, '/servlet/servlet.su'));
    su.searchParams.set('oid', orgId);
    su.searchParams.set('suorgadminid', userId);
    su.searchParams.set('retURL', `/${userId}?noredirect=1`);
    su.searchParams.set('targetURL', this.landing(persona, landing));
    await page.goto(su.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/insufficient privileges|not allowed to log in as|login as.*(not|isn't) (available|enabled)/.test(body)) {
      throw new Error(`"Log in as" ${persona.username} was refused — ${admin.name} needs "Manage Users" and the org must allow administrators to log in as any user`);
    }
    return `"Log in as" from ${admin.name}`;
  }

  // ---------------------------------------------------------------- API access

  /** API client acting as the persona itself: its OAuth token, else the UI session id cookie. */
  private async selfApi(page: Page | undefined, persona: Persona): Promise<SalesforceApi | null> {
    const token = await this.token(persona);
    if (token) return new SalesforceApi(token.instanceUrl, token.accessToken, this.settings.apiVersion);
    if (!page || this.active.get(page.context()) !== persona.name || persona.auth_method === 'login_as') return null;
    const cookies = await page.context().cookies();
    const host = new URL(this.settings.instanceUrl).hostname;
    const myDomainHost = host.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
    const sid = cookies.find((c) => c.name === 'sid' && (c.domain.replace(/^\./, '') === myDomainHost || c.domain.replace(/^\./, '') === host))
      ?? cookies.find((c) => c.name === 'sid');
    if (!sid) return null;
    const base = host === myDomainHost ? this.settings.instanceUrl : this.settings.instanceUrl.replace(host, myDomainHost);
    const api = new SalesforceApi(base, sid.value, this.settings.apiVersion);
    try {
      await api.get('/services/oauth2/userinfo');
      return api;
    } catch {
      return null;
    }
  }

  /** Admin API (api_persona) used to inspect users that have no token of their own. */
  private async adminApi(): Promise<SalesforceApi | null> {
    if (!this.settings.apiPersona) return null;
    const admin = this.persona(this.settings.apiPersona);
    const token = await this.token(admin);
    return token ? new SalesforceApi(token.instanceUrl, token.accessToken, this.settings.apiVersion) : null;
  }

  async apiFor(page: Page | undefined, name?: string): Promise<PersonaApi> {
    const persona = this.persona(name);
    const self = await this.selfApi(page, persona);
    if (self) {
      const userId = this.userIds.get(persona.name) ?? String((await self.get('/services/oauth2/userinfo')).user_id);
      this.userIds.set(persona.name, userId);
      return { mode: 'self', api: self, userId };
    }
    const admin = await this.adminApi();
    if (!admin) {
      throw new Error(
        `No Salesforce API access for persona "${persona.name}": log in first (UI session), use the jwt/oauth_password method, ` +
        'or set salesforce.api_persona to an administrator persona with an OAuth token',
      );
    }
    const userId = persona.user_id || this.userIds.get(persona.name) || (await admin.userIdByUsername(persona.username));
    this.userIds.set(persona.name, userId);
    return { mode: 'admin', api: admin, userId };
  }

  async identity(page: Page | undefined, name?: string): Promise<SfIdentity & { via: 'self' | 'admin' }> {
    const { mode, api, userId } = await this.apiFor(page, name);
    const identity = mode === 'self' ? await api.identity() : await new SalesforceAdminChecks(api).identityOf(userId);
    return { ...identity, via: mode };
  }

  async objectAccess(page: Page | undefined, name: string | undefined, objectName: string): Promise<ObjectAccess & { via: string }> {
    const { mode, api, userId } = await this.apiFor(page, name);
    const access = mode === 'self' ? await api.objectAccess(objectName) : await new SalesforceAdminChecks(api).objectAccess(userId, objectName);
    return { ...access, via: mode };
  }

  async fieldAccess(page: Page | undefined, name: string | undefined, objectName: string, fieldName: string): Promise<FieldAccess & { via: string }> {
    const { mode, api, userId } = await this.apiFor(page, name);
    const access = mode === 'self' ? await api.fieldAccess(objectName, fieldName) : await new SalesforceAdminChecks(api).fieldAccess(userId, objectName, fieldName);
    return { ...access, via: mode };
  }

  async recordAccess(page: Page | undefined, name: string | undefined, recordId: string): Promise<RecordAccess & { via: string }> {
    const { mode, api, userId } = await this.apiFor(page, name);
    return { ...(await api.recordAccess(userId, recordId)), via: mode };
  }

  /** Mismatches between a persona's actual identity and its expected profile / permission sets. */
  static identityMismatches(persona: Persona, identity: SfIdentity): string[] {
    const problems: string[] = [];
    if (persona.expected_profile && identity.profile?.toLowerCase() !== persona.expected_profile.toLowerCase()) {
      problems.push(`profile is "${identity.profile ?? 'unknown'}", expected "${persona.expected_profile}"`);
    }
    const have = new Set(identity.permissionSets.map((s) => s.toLowerCase()));
    const missing = (persona.expected_permission_sets ?? []).filter((s) => !have.has(s.toLowerCase()));
    if (missing.length) problems.push(`missing permission set(s): ${missing.join(', ')}`);
    return problems;
  }
}
