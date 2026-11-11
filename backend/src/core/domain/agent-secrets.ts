/**
 * Which parts of an agent config are secret, and how they are stored,
 * returned and used.
 *
 *   config.secrets              { NAME: value }  — usable in steps as {{secrets.NAME}}
 *   config.salesforce.password / security_token                 (legacy single user)
 *   config.salesforce.connected_app.client_secret / private_key
 *   config.salesforce.personas[].password / totp_secret / security_token
 */

import { decryptSecret, isEncrypted, REDACTED, sealSecret } from '../../infra/security/secrets.js';
import { CONNECTED_APP_SECRET_FIELDS, PERSONA_SECRET_FIELDS, validatePersonas } from '../../modules/salesforce/personas.js';

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

/** Whether a stored config still holds plaintext secrets (written before encryption existed). */
export function hasPlaintextSecrets(config: any): boolean {
  if (Object.values(config?.secrets ?? {}).some((v) => !isEncrypted(v))) return true;
  return salesforceSecretSpots(config?.salesforce).some(({ obj, fields }) => fields.some((f) => obj?.[f] && !isEncrypted(obj[f])));
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
  return out;
}

/** All plaintext secret values of a decrypted config (for log masking). */
export function secretValues(decrypted: any): string[] {
  const values: string[] = Object.values(decrypted?.secrets ?? {}).map(String);
  for (const { obj, fields } of salesforceSecretSpots(decrypted?.salesforce)) {
    for (const f of fields) if (obj?.[f]) values.push(String(obj[f]));
  }
  return values.filter(Boolean);
}

/**
 * Replace {{secrets.NAME}}, {{env.NAME}} and {{vars.NAME}} placeholders. Unknown secrets
 * and variables throw. Variables come from earlier steps of the test (http_request extract).
 */
export function resolvePlaceholders(text: string, secrets: Record<string, string>, vars?: Record<string, string>): string {
  return text.replace(/\{\{\s*(secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, kind, name) => {
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
