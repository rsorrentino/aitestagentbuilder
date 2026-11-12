/**
 * Salesforce personas — named test users with their own credentials and
 * login method, so the same test can run as an administrator, a sales rep,
 * a read-only user, etc.
 *
 * agent.config.salesforce:
 *   login_url        https://login.salesforce.com | https://test.salesforce.com | https://<MyDomain>.my.salesforce.com
 *   instance_url     https://<MyDomain>.lightning.force.com (UI) — defaults to the agent base URL
 *   api_version      v62.0
 *   default_persona  persona used by salesforce_login when none is named
 *   api_persona      persona with an API token (jwt / oauth_password) used for
 *                    admin-side checks of personas that have no token of their own
 *   connected_app    { client_id, client_secret*, private_key* }
 *   frontdoor_mode   auto | single_access | sid
 *   reuse_sessions   reuse a persona's browser session across tests of a run (default true)
 *   mfa              { code_selector, submit_selector } overrides for the verification page
 *   personas[]       { name, description, auth_method, username, password*, totp_secret*,
 *                      security_token*, login_as_via, landing_path,
 *                      expected_profile, expected_permission_sets[] }
 *   (* = secret, encrypted at rest)
 *
 * auth_method:
 *   password        UI login with username + password (trusted IP range / no MFA)
 *   password_totp   UI login + authenticator-app (TOTP) code generated from totp_secret
 *   jwt             OAuth JWT bearer flow (connected app + certificate), then frontdoor into the UI.
 *                   Recommended for administrators, who need phishing-resistant MFA in the UI.
 *   oauth_password  OAuth username-password flow, then frontdoor (legacy orgs)
 *   login_as        an administrator persona (login_as_via) logs in, then uses "Log in as" on this user
 */

export const AUTH_METHODS = ['password', 'password_totp', 'jwt', 'oauth_password', 'login_as'] as const;
export type AuthMethod = typeof AUTH_METHODS[number];

export const PERSONA_SECRET_FIELDS = ['password', 'totp_secret', 'security_token'] as const;
export const CONNECTED_APP_SECRET_FIELDS = ['client_secret', 'private_key'] as const;
export const PERSONA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface Persona {
  name: string;
  description?: string;
  auth_method: AuthMethod;
  username: string;
  password?: string;
  totp_secret?: string;
  security_token?: string;
  user_id?: string;
  login_as_via?: string;
  landing_path?: string;
  expected_profile?: string;
  expected_permission_sets?: string[];
  /** Emailed / SMS verification codes (device activation) from a code source */
  codes?: { source: string; to?: string };
}

export interface SalesforceSettings {
  loginUrl: string;
  instanceUrl: string;
  apiVersion: string;
  defaultPersona?: string;
  apiPersona?: string;
  connectedApp: { client_id?: string; client_secret?: string; private_key?: string };
  frontdoorMode: 'auto' | 'single_access' | 'sid';
  reuseSessions: boolean;
  mfa: { code_selector?: string; submit_selector?: string };
  personas: Persona[];
}

const trimSlash = (u: string) => String(u || '').replace(/\/+$/, '');

/** Settings from a (decrypted) agent config; legacy single-user configs become persona "default". */
export function salesforceSettings(config: any): SalesforceSettings | null {
  const sf = config?.salesforce;
  if (!sf || typeof sf !== 'object') return null;
  const personas: Persona[] = Array.isArray(sf.personas) ? sf.personas.map(normalizePersona) : [];
  if (personas.length === 0 && sf.username) {
    personas.push({ name: 'default', auth_method: 'password', username: sf.username, password: sf.password, security_token: sf.security_token });
  }
  const loginUrl = trimSlash(sf.login_url || (sf.sandbox ? 'https://test.salesforce.com' : config.base_url || 'https://login.salesforce.com'));
  return {
    loginUrl,
    instanceUrl: trimSlash(sf.instance_url || config.base_url || loginUrl),
    apiVersion: /^v\d+\.\d$/.test(sf.api_version ?? '') ? sf.api_version : 'v62.0',
    defaultPersona: sf.default_persona || personas[0]?.name,
    apiPersona: sf.api_persona || personas.find((p) => p.auth_method === 'jwt' || p.auth_method === 'oauth_password')?.name,
    connectedApp: sf.connected_app ?? {},
    frontdoorMode: ['single_access', 'sid'].includes(sf.frontdoor_mode) ? sf.frontdoor_mode : 'auto',
    reuseSessions: sf.reuse_sessions !== false,
    mfa: sf.mfa ?? {},
    personas,
  };
}

function normalizePersona(p: any): Persona {
  return {
    ...p,
    name: String(p.name ?? '').trim(),
    auth_method: AUTH_METHODS.includes(p.auth_method) ? p.auth_method : 'password',
    username: String(p.username ?? '').trim(),
    expected_permission_sets: Array.isArray(p.expected_permission_sets)
      ? p.expected_permission_sets.map(String).filter(Boolean)
      : typeof p.expected_permission_sets === 'string'
        ? p.expected_permission_sets.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined,
  };
}

/** Validation for personas being saved (plain, before encryption). Throws with a readable message. */
export function validatePersonas(sf: any): void {
  if (!sf || sf.personas === undefined) return;
  if (!Array.isArray(sf.personas)) throw new Error('salesforce.personas must be a list');
  const names = new Set<string>();
  for (const raw of sf.personas) {
    const p = normalizePersona(raw);
    if (!PERSONA_NAME_RE.test(p.name)) throw new Error(`Invalid persona name "${p.name}" (letters, digits, . _ -, up to 40)`);
    if (names.has(p.name.toLowerCase())) throw new Error(`Duplicate persona "${p.name}"`);
    names.add(p.name.toLowerCase());
    if (!AUTH_METHODS.includes(raw.auth_method)) throw new Error(`Persona "${p.name}": auth_method must be one of ${AUTH_METHODS.join(', ')}`);
    if (!p.username) throw new Error(`Persona "${p.name}": username is required`);
  }
  for (const raw of sf.personas) {
    if (raw.auth_method !== 'login_as') continue;
    const via = sf.personas.find((x: any) => x.name === raw.login_as_via);
    if (!via) throw new Error(`Persona "${raw.name}": login_as_via must name another persona (an administrator)`);
    if (via.auth_method === 'login_as') throw new Error(`Persona "${raw.name}": login_as_via cannot itself use login_as`);
  }
  for (const key of ['default_persona', 'api_persona']) {
    if (sf[key] && !names.has(String(sf[key]).toLowerCase())) throw new Error(`salesforce.${key} "${sf[key]}" is not a persona`);
  }
}

export function findPersona(settings: SalesforceSettings, name?: string): Persona {
  const wanted = name || settings.defaultPersona;
  if (!wanted) throw new Error('No Salesforce persona configured on this agent (Agent → Salesforce personas)');
  const persona = settings.personas.find((p) => p.name === wanted) ?? settings.personas.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (!persona) {
    throw new Error(`Unknown Salesforce persona "${wanted}" — configured: ${settings.personas.map((p) => p.name).join(', ') || 'none'}`);
  }
  return persona;
}

/** Persona names a test case should run as: data.personas = ["admin", "rep"] | "all". */
export function testPersonas(testData: any, settings: SalesforceSettings | null): string[] {
  const raw = testData?.personas;
  if (!raw) return [];
  if (raw === 'all' || (Array.isArray(raw) && raw.includes('all'))) return settings?.personas.map((p) => p.name) ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((s: any) => String(s).trim()).filter(Boolean))];
}
