/**
 * Secret encryption (AES-256-GCM).
 *
 * Encrypted values look like `enc:v1:<iv>:<tag>:<ciphertext>` (base64url).
 *
 * Key: SECRETS_ENCRYPTION_KEY (any string; hashed to 32 bytes). Without it,
 * development installs generate and keep a key in backend/.data/secrets.key;
 * production (NODE_ENV=production) refuses to start without the variable,
 * because losing the key makes stored secrets unreadable.
 */

import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BACKEND_ROOT } from '../config/env.js';
import logger from '../logger/index.js';

const PREFIX = 'enc:v1:';
/** Placeholder returned instead of a secret; sending it back keeps the stored value. */
export const REDACTED = '••••••••';

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.SECRETS_ENCRYPTION_KEY;
  if (fromEnv) {
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SECRETS_ENCRYPTION_KEY must be set in production (e.g. `openssl rand -base64 32`).');
  }
  const dir = process.env.DATA_DIR || join(BACKEND_ROOT, '.data');
  const file = join(dir, 'secrets.key');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    logger.warn(`SECRETS_ENCRYPTION_KEY not set — generated a development key at ${file}. Set the variable in production.`);
  }
  cachedKey = crypto.createHash('sha256').update(readFileSync(file, 'utf-8').trim()).digest();
  return cachedKey;
}

/** Purpose-specific key derived from the secrets key (e.g. for URL signing). */
export function deriveKey(purpose: string): Buffer {
  return crypto.createHmac('sha256', loadKey()).update(purpose).digest();
}

/** Fails fast at startup when the key is unavailable. */
export function assertSecretsKey(): void {
  loadKey();
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf-8');
}

/**
 * Encrypt a value for storage. `REDACTED` / undefined keep `previous`;
 * empty string clears it.
 */
export function sealSecret(next: unknown, previous?: string): string | undefined {
  if (next === undefined || next === null || next === REDACTED) return previous;
  const str = String(next);
  if (str === '') return undefined;
  return isEncrypted(str) ? str : encryptSecret(str);
}

/** Replace every occurrence of the given secret values in a text. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('••••');
  }
  return out;
}
