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
