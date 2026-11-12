/**
 * Login profiles: test users of any web application (not only Salesforce),
 * with how to sign them in and how to handle multi-factor authentication.
 *
 * agent.config.auth:
 *   default_profile   profile tests start signed in as (optional)
 *   profiles[]        { name, description, login_url, username, password*, totp_secret*,
 *                       selectors: { username, password, submit, code, code_submit },
 *                       success: { url_contains, selector },
 *                       session: { reuse (default true), max_age_hours (default 12) },
 *                       landing_path }
 *   (* = secret, encrypted at rest)
 *
 * Signing in, in order:
 *   1. a saved session (cookies + local storage, encrypted) that is still valid: no login at all;
 *   2. the sign-in form, filled automatically, also for two-step forms (Microsoft, Okta, Google, …);
 *      a verification code page is answered with the authenticator (TOTP) code;
 *   3. the session is saved for the next tests and runs, with "remember this device" cookies,
 *      so the application usually stops asking for MFA.
 */

export const PROFILE_SECRET_FIELDS = ['password', 'totp_secret'] as const;
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface LoginProfile {
  name: string;
  description?: string;
  login_url?: string;
  username?: string;
  password?: string;
  totp_secret?: string;
  landing_path?: string;
  selectors: { username?: string; password?: string; submit?: string; code?: string; code_submit?: string };
  success: { url_contains?: string; selector?: string };
  session: { reuse: boolean; maxAgeHours: number };
}

export interface AuthSettings {
  defaultProfile?: string;
  profiles: LoginProfile[];
}

const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function normalizeProfile(raw: any): LoginProfile {
  const sel = raw?.selectors ?? {};
  const maxAge = Number(raw?.session?.max_age_hours);
  return {
    name: String(raw?.name ?? '').trim(),
    description: str(raw?.description),
    login_url: str(raw?.login_url),
    username: str(raw?.username),
    password: typeof raw?.password === 'string' && raw.password ? raw.password : undefined,
    totp_secret: str(raw?.totp_secret),
    landing_path: str(raw?.landing_path),
    selectors: {
      username: str(sel.username), password: str(sel.password), submit: str(sel.submit), code: str(sel.code), code_submit: str(sel.code_submit),
    },
    success: { url_contains: str(raw?.success?.url_contains), selector: str(raw?.success?.selector) },
    session: { reuse: raw?.session?.reuse !== false, maxAgeHours: Number.isFinite(maxAge) && maxAge > 0 ? Math.min(maxAge, 24 * 90) : 12 },
  };
}

/** Settings from a (decrypted) agent config, or null when the agent has no login profiles. */
export function authSettings(config: any): AuthSettings | null {
  const auth = config?.auth;
  if (!auth || typeof auth !== 'object' || !Array.isArray(auth.profiles) || !auth.profiles.length) return null;
  return { defaultProfile: str(auth.default_profile), profiles: auth.profiles.map(normalizeProfile) };
}

export function validateAuth(auth: any): void {
  if (auth === undefined || auth === null) return;
  if (typeof auth !== 'object' || Array.isArray(auth)) throw new Error('auth must be an object { profiles: [...] }');
  if (auth.profiles === undefined) return;
  if (!Array.isArray(auth.profiles)) throw new Error('auth.profiles must be a list');
  const names = new Set<string>();
  for (const raw of auth.profiles) {
    const p = normalizeProfile(raw);
    if (!PROFILE_NAME_RE.test(p.name)) throw new Error(`Invalid login profile name "${p.name}" (letters, digits, . _ -, up to 40)`);
    if (names.has(p.name.toLowerCase())) throw new Error(`Duplicate login profile "${p.name}"`);
    names.add(p.name.toLowerCase());
    if (p.login_url && !/^(https?:\/\/|\/|[\w.-])/.test(p.login_url)) throw new Error(`Login profile "${p.name}": login_url must be a URL or a path`);
    if (p.totp_secret && /[^A-Za-z2-7=\s-]/.test(p.totp_secret) && !p.totp_secret.startsWith('otpauth://') && p.totp_secret !== '••••••••') {
      throw new Error(`Login profile "${p.name}": totp_secret must be the Base32 key (A-Z, 2-7) or an otpauth:// link`);
    }
  }
  if (auth.default_profile && !names.has(String(auth.default_profile).toLowerCase())) throw new Error(`auth.default_profile "${auth.default_profile}" is not a login profile`);
}

export function findProfile(settings: AuthSettings, name?: string): LoginProfile {
  const wanted = name || settings.defaultProfile;
  if (!wanted) throw new Error('No login profile named: give one, or set auth.default_profile');
  const p = settings.profiles.find((x) => x.name === wanted) ?? settings.profiles.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
  if (!p) throw new Error(`Unknown login profile "${wanted}" — configured: ${settings.profiles.map((x) => x.name).join(', ') || 'none'}`);
  return p;
}

export function hasProfile(settings: AuthSettings | null, name?: string): boolean {
  if (!settings || !name) return false;
  return settings.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase());
}
