/**
 * Which parts of an agent config are secret, and how they are stored,
 * returned and used.
 *
 *   config.secrets              { NAME: value }  — usable in steps as {{secrets.NAME}}
 *   config.salesforce.password
 *   config.salesforce.security_token
 */

import { decryptSecret, REDACTED, sealSecret } from '../../infra/security/secrets.js';

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

  if (next.salesforce || previous?.salesforce) {
    const sf = { ...(previous?.salesforce ?? {}), ...(next.salesforce ?? {}) };
    for (const field of SALESFORCE_SECRET_FIELDS) {
      const v = sealSecret(next.salesforce?.[field], previous?.salesforce?.[field]);
      if (v === undefined) delete sf[field];
      else sf[field] = v;
    }
    out.salesforce = sf;
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
  if (config.salesforce) {
    out.salesforce = { ...config.salesforce };
    for (const field of SALESFORCE_SECRET_FIELDS) {
      if (out.salesforce[field]) out.salesforce[field] = REDACTED;
    }
  }
  return out;
}

/** Config with decrypted secrets, for the executor only. */
export function decryptAgentConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (config.secrets) {
    out.secrets = Object.fromEntries(Object.entries(config.secrets).map(([k, v]) => [k, decryptSecret(String(v))]));
  }
  if (config.salesforce) {
    out.salesforce = { ...config.salesforce };
    for (const field of SALESFORCE_SECRET_FIELDS) {
      if (out.salesforce[field]) out.salesforce[field] = decryptSecret(String(out.salesforce[field]));
    }
  }
  return out;
}

/** All plaintext secret values of a decrypted config (for log masking). */
export function secretValues(decrypted: any): string[] {
  const values: string[] = Object.values(decrypted?.secrets ?? {}).map(String);
  for (const field of SALESFORCE_SECRET_FIELDS) {
    if (decrypted?.salesforce?.[field]) values.push(String(decrypted.salesforce[field]));
  }
  return values.filter(Boolean);
}

/** Replace {{secrets.NAME}} and {{env.NAME}} placeholders. Unknown secrets throw. */
export function resolvePlaceholders(text: string, secrets: Record<string, string>): string {
  return text.replace(/\{\{\s*(secrets|env)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, kind, name) => {
    if (kind === 'secrets') {
      if (!(name in secrets)) throw new Error(`Unknown secret "${name}" — define it in the agent's secrets`);
      return secrets[name];
    }
    const allowed = (process.env.STEP_ENV_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(name)) throw new Error(`Environment variable "${name}" is not in STEP_ENV_ALLOWLIST`);
    return process.env[name] ?? '';
  });
}
