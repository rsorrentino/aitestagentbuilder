/**
 * Which parts of an agent config are secret, and how they are stored,
 * returned and used.
 *
 *   config.secrets              { NAME: value }  — usable in steps as {{secrets.NAME}}
 *   config.salesforce.password / security_token                 (legacy single user)
 *   config.salesforce.connected_app.client_secret / private_key
 *   config.salesforce.personas[].password / totp_secret / security_token
 *   config.auth.profiles[].password / totp_secret                (login profiles of any application)
 *   config.code_sources[].password / auth_token                  (mailboxes / phone numbers for verification codes)
 *   config.grid.access_key                                        (BrowserStack, LambdaTest, Sauce Labs)
 */

import { decryptSecret, isEncrypted, REDACTED, sealSecret } from '../../infra/security/secrets.js';
import { CONNECTED_APP_SECRET_FIELDS, PERSONA_SECRET_FIELDS, validatePersonas } from '../../modules/salesforce/personas.js';
import { PROFILE_SECRET_FIELDS, validateAuth } from '../../modules/auth/profiles.js';
import { SOURCE_SECRET_FIELDS, validateSources } from '../../modules/auth/code-sources.js';

type Fields = readonly string[];

/** Apply `fn` to the given secret fields of an object (returns a copy). */
function mapFields(obj: any, fields: Fields, fn: (value: any, field: string) => any): any {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of fields) {
    const v = fn(obj[field], field);
    if (v === undefined || v === null || v === '') delete out[field];
    else out[field] = v;
  }
  return out;
}

/** Every secret-bearing object of a salesforce config, with its fields. */
function salesforceSecretSpots(sf: any): Array<{ obj: any; fields: Fields }> {
  if (!sf || typeof sf !== 'object') return [];
  return [
    { obj: sf, fields: SALESFORCE_SECRET_FIELDS },
    { obj: sf.connected_app, fields: CONNECTED_APP_SECRET_FIELDS },
    ...(Array.isArray(sf.personas) ? sf.personas.map((p: any) => ({ obj: p, fields: PERSONA_SECRET_FIELDS })) : []),
  ];
}

function transformSalesforce(sf: any, fn: (value: any, field: string) => any): any {
  if (!sf || typeof sf !== 'object') return sf;
  const out = mapFields(sf, SALESFORCE_SECRET_FIELDS, fn);
  if (sf.connected_app) out.connected_app = mapFields(sf.connected_app, CONNECTED_APP_SECRET_FIELDS, fn);
  if (Array.isArray(sf.personas)) out.personas = sf.personas.map((p: any) => mapFields(p, PERSONA_SECRET_FIELDS, fn));
  return out;
}

/** Every secret-bearing login profile. */
function authSecretSpots(auth: any): Array<{ obj: any; fields: Fields }> {
  return Array.isArray(auth?.profiles) ? auth.profiles.map((p: any) => ({ obj: p, fields: PROFILE_SECRET_FIELDS })) : [];
}

function transformAuth(auth: any, fn: (value: any, field: string) => any): any {
  if (!auth || typeof auth !== 'object' || !Array.isArray(auth.profiles)) return auth;
  return { ...auth, profiles: auth.profiles.map((p: any) => mapFields(p, PROFILE_SECRET_FIELDS, fn)) };
}

function sourceSecretSpots(list: any): Array<{ obj: any; fields: Fields }> {
  return Array.isArray(list) ? list.map((x: any) => ({ obj: x, fields: SOURCE_SECRET_FIELDS })) : [];
}

const transformSources = (list: any, fn: (value: any, field: string) => any) =>
  (Array.isArray(list) ? list.map((x: any) => mapFields(x, SOURCE_SECRET_FIELDS, fn)) : list);

/** Seal code sources: secrets kept by name (or position when renamed). */
function sealSources(next: any, previous: any): any {
  if (next === undefined) return previous;
  if (!next) return next;
  validateSources(next);
  const prev: any[] = Array.isArray(previous) ? previous : [];
  return next.map((x: any, i: number) => {
    const before = prev.find((p) => p.name === (x.previous_name ?? x.name)) ?? (x.previous_name === undefined ? prev[i] : undefined);
    const { previous_name: _ignored, ...src } = x;
    return mapFields(src, SOURCE_SECRET_FIELDS, (_v, f) => sealSecret(src[f], before?.[f]));
  });
}

/** Seal login profiles: secrets are kept by profile name (or position when renamed). */
function sealAuth(next: any, previous: any): any {
  if (next === undefined) return previous;
  if (!next) return next;
  validateAuth(next);
  if (!Array.isArray(next.profiles)) return next;
  const prev: any[] = Array.isArray(previous?.profiles) ? previous.profiles : [];
  return {
    ...next,
    profiles: next.profiles.map((p: any, i: number) => {
      const before = prev.find((x) => x.name === (p.previous_name ?? p.name)) ?? (p.previous_name === undefined ? prev[i] : undefined);
      const { previous_name: _ignored, ...profile } = p;
      return mapFields(profile, PROFILE_SECRET_FIELDS, (_v, f) => sealSecret(profile[f], before?.[f]));
    }),
  };
}

/** Seal the salesforce section: personas keep previous secrets by name (or position when renamed). */
function sealSalesforce(next: any, previous: any): any {
  if (next === undefined) return previous;
  if (!next) return next;
  validatePersonas(next);
  const out = mapFields({ ...(previous ?? {}), ...next }, SALESFORCE_SECRET_FIELDS, (_v, f) => sealSecret(next[f], previous?.[f]));
  if (next.connected_app !== undefined || previous?.connected_app) {
    const app = next.connected_app === undefined ? previous?.connected_app : next.connected_app;
    out.connected_app = app
      ? mapFields(app, CONNECTED_APP_SECRET_FIELDS, (_v, f) => sealSecret(next.connected_app === undefined ? REDACTED : app[f], previous?.connected_app?.[f]))
      : app;
  }
  if (Array.isArray(next.personas)) {
    const prev: any[] = Array.isArray(previous?.personas) ? previous.personas : [];
    out.personas = next.personas.map((p: any, i: number) => {
      const before = prev.find((x) => x.name === (p.previous_name ?? p.name)) ?? (p.previous_name === undefined ? prev[i] : undefined);
      const { previous_name: _ignored, ...persona } = p;
      return mapFields(persona, PERSONA_SECRET_FIELDS, (_v, f) => sealSecret(persona[f], before?.[f]));
    });
  }
  return out;
}

const GRID_SECRET_FIELDS = ['access_key'];
const gridSecretSpots = (grid: any): Array<{ obj: any; fields: Fields }> => (grid && typeof grid === 'object' ? [{ obj: grid, fields: GRID_SECRET_FIELDS }] : []);
const transformGrid = (grid: any, fn: (value: any, field: string) => any) => (grid && typeof grid === 'object' ? mapFields(grid, GRID_SECRET_FIELDS, fn) : grid);

/** Whether a stored config still holds plaintext secrets (written before encryption existed). */
export function hasPlaintextSecrets(config: any): boolean {
  if (Object.values(config?.secrets ?? {}).some((v) => !isEncrypted(v))) return true;
  return [...salesforceSecretSpots(config?.salesforce), ...authSecretSpots(config?.auth), ...sourceSecretSpots(config?.code_sources), ...gridSecretSpots(config?.grid)]
    .some(({ obj, fields }) => fields.some((f) => obj?.[f] && !isEncrypted(obj[f])));
}

const SALESFORCE_SECRET_FIELDS = ['password', 'security_token'];
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Encrypts secrets for storage, keeping previous values where the client sent REDACTED. */
export function sealAgentConfig(next: any, previous?: any): any {
  if (!next || typeof next !== 'object') return next;
  const out = { ...next };

  if (next.secrets !== undefined || previous?.secrets) {
    const sealed: Record<string, string> = {};
    const incoming = next.secrets === undefined ? previous?.secrets ?? {} : next.secrets ?? {};
    for (const [name, value] of Object.entries(incoming)) {
      if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name "${name}" (letters, digits, underscore)`);
      const v = sealSecret(value, previous?.secrets?.[name]);
      if (v !== undefined) sealed[name] = v;
    }
    out.secrets = sealed;
  }

  if (next.salesforce !== undefined || previous?.salesforce) {
    out.salesforce = sealSalesforce(next.salesforce, previous?.salesforce);
  }

  if (next.auth !== undefined || previous?.auth) {
    out.auth = sealAuth(next.auth, previous?.auth);
  }
  if (next.code_sources !== undefined || previous?.code_sources) {
    out.code_sources = sealSources(next.code_sources, previous?.code_sources);
  }
  // The grid keeps its access key when sent back redacted or left out, unless the provider changed
  if (next.grid !== undefined || previous?.grid) {
    const grid = next.grid === undefined ? previous.grid : next.grid;
    out.grid = grid && typeof grid === 'object'
      ? mapFields(grid, GRID_SECRET_FIELDS, (_v, f) => (next.grid === undefined ? previous.grid[f]
        : grid[f] === undefined && grid.provider !== previous?.grid?.provider ? undefined : sealSecret(grid[f], previous?.grid?.[f])))
      : grid;
  }
  return out;
}

/** Copy of the config with secret values replaced by REDACTED (safe for API responses). */
export function redactAgentConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (config.secrets) {
    out.secrets = Object.fromEntries(Object.keys(config.secrets).map((k) => [k, REDACTED]));
  }
  if (config.salesforce) out.salesforce = transformSalesforce(config.salesforce, (v) => (v ? REDACTED : undefined));
  if (config.auth) out.auth = transformAuth(config.auth, (v) => (v ? REDACTED : undefined));
  if (config.code_sources) out.code_sources = transformSources(config.code_sources, (v) => (v ? REDACTED : undefined));
  if (config.grid) out.grid = transformGrid(config.grid, (v) => (v ? REDACTED : undefined));
  return out;
}

/** Config with decrypted secrets, for the executor only. */
export function decryptAgentConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (config.secrets) {
    out.secrets = Object.fromEntries(Object.entries(config.secrets).map(([k, v]) => [k, decryptSecret(String(v))]));
  }
  if (config.salesforce) out.salesforce = transformSalesforce(config.salesforce, (v) => (v ? decryptSecret(String(v)) : undefined));
  if (config.auth) out.auth = transformAuth(config.auth, (v) => (v ? decryptSecret(String(v)) : undefined));
  if (config.code_sources) out.code_sources = transformSources(config.code_sources, (v) => (v ? decryptSecret(String(v)) : undefined));
  if (config.grid) out.grid = transformGrid(config.grid, (v) => (v ? decryptSecret(String(v)) : undefined));
  return out;
}

/** All plaintext secret values of a decrypted config (for log masking). */
export function secretValues(decrypted: any): string[] {
  const values: string[] = Object.values(decrypted?.secrets ?? {}).map(String);
  for (const { obj, fields } of [...salesforceSecretSpots(decrypted?.salesforce), ...authSecretSpots(decrypted?.auth), ...sourceSecretSpots(decrypted?.code_sources), ...gridSecretSpots(decrypted?.grid)]) {
    for (const f of fields) if (obj?.[f]) values.push(String(obj[f]));
  }
  return values.filter(Boolean);
}

/**
 * Replace {{secrets.NAME}}, {{env.NAME}}, {{vars.NAME}}, {{data.FIELD}}, {{fake.KIND[:label]}} and {{totp.NAME}}
 * placeholders. Unknown secrets, variables and fields throw. Variables come from earlier steps
 * of the test (http_request extract), data fields from the test's data set row, fake values
 * from the test data generator (the same kind and label give the same value within a test).
 */
export function resolvePlaceholders(
  text: string,
  secrets: Record<string, string>,
  vars?: Record<string, string>,
  extra: { data?: Record<string, any> | null; fake?: { get(kind: string, label?: string): string }; keepSecrets?: boolean; totp?: (name: string) => string } = {},
): string {
  return text.replace(/\{\{\s*(secrets|env|vars|data|fake|totp)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)(?::([\w-]{1,40}))?\s*\}\}/g, (match, kind, name, label) => {
    if (label !== undefined && kind !== 'fake') return match;
    if (kind === 'fake') {
      if (!extra.fake) throw new Error('{{fake.…}} values are only available while a test runs');
      return extra.fake.get(name, label ?? '');
    }
    if (kind === 'data') {
      if (!extra.data) throw new Error(`{{data.${name}}} needs a data set: set data.dataset on the test case`);
      let cur: any = extra.data;
      for (const part of name.split('.')) cur = cur !== null && typeof cur === 'object' && part in cur ? cur[part] : undefined;
      if (cur === undefined) throw new Error(`Unknown data field "${name}" — the row has: ${Object.keys(extra.data).join(', ') || '(no fields)'}`);
      return cur === null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
    }
    if (kind === 'totp') {
      // Current authenticator code of a login profile, a Salesforce persona or a secret holding a key
      if (extra.keepSecrets) return match;
      if (!extra.totp) throw new Error('{{totp.…}} codes are only available while a test runs');
      return extra.totp(name);
    }
    if (name.includes('.')) return match;
    // Text for the AI: secrets and environment values stay placeholders, resolved only when an action runs
    if (extra.keepSecrets && (kind === 'secrets' || kind === 'env')) return match;
    if (kind === 'secrets') {
      if (!(name in secrets)) throw new Error(`Unknown secret "${name}" — define it in the agent's secrets`);
      return secrets[name];
    }
    if (kind === 'vars') {
      if (!vars || !(name in vars)) throw new Error(`Unknown variable "${name}" — capture it first with http_request data.extract`);
      return vars[name];
    }
    const allowed = (process.env.STEP_ENV_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(name)) throw new Error(`Environment variable "${name}" is not in STEP_ENV_ALLOWLIST`);
    return process.env[name] ?? '';
  });
}
