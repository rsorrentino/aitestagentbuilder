/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s, 6 digits) — the
 * codes Salesforce accepts from authenticator apps for MFA.
 *
 * The secret is the Base32 key shown when the test user registers an
 * authenticator app ("Can't scan the QR code?" reveals it).
 */

import crypto from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('TOTP secret must be Base32 (letters A-Z and digits 2-7)');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** HOTP (RFC 4226) for a counter. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secretBase32: string, at: number = Date.now(), opts: { step?: number; digits?: number } = {}): string {
  const step = opts.step ?? 30;
  return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / step), opts.digits ?? 6);
}

/** Verify a code allowing ±`window` time steps of clock drift. */
export function verifyTotp(secretBase32: string, code: string, at: number = Date.now(), window = 1): boolean {
  for (let w = -window; w <= window; w++) {
    if (totp(secretBase32, at + w * 30_000) === code) return true;
  }
  return false;
}

/** Seconds until the current code expires (to avoid submitting a code about to roll over). */
export function secondsRemaining(at: number = Date.now(), step = 30): number {
  return step - (Math.floor(at / 1000) % step);
}

/** The secret and parameters of a TOTP key given as Base32 or as an otpauth://totp/… link (QR code content). */
export function parseTotpKey(value: string): { secret: string; digits: number; period: number; issuer?: string; account?: string } {
  const v = String(value ?? '').trim();
  if (!/^otpauth:\/\//i.test(v)) {
    base32Decode(v);
    return { secret: v.toUpperCase().replace(/[\s=-]/g, ''), digits: 6, period: 30 };
  }
  const url = new URL(v);
  if (url.hostname.toLowerCase() !== 'totp') throw new Error('Only time-based (otpauth://totp/…) keys are supported, not counter-based (hotp)');
  const secret = (url.searchParams.get('secret') ?? '').toUpperCase().replace(/[\s=-]/g, '');
  base32Decode(secret);
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  if (algorithm !== 'SHA1') throw new Error(`TOTP algorithm ${algorithm} is not supported (SHA1 only, like most authenticator apps)`);
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/s) : [undefined, label];
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  return {
    secret,
    digits: [6, 7, 8].includes(digits) ? digits : 6,
    period: period > 0 && period <= 300 ? period : 30,
    issuer: url.searchParams.get('issuer') ?? labelIssuer ?? undefined,
    account: account?.trim() || undefined,
  };
}

/** Current code for a Base32 key or otpauth:// link. */
export function totpFor(key: string, at: number = Date.now()): string {
  const k = parseTotpKey(key);
  return totp(k.secret, at, { step: k.period, digits: k.digits });
}
