/**
 * Authenticator codes (RFC 6238 TOTP, HMAC-SHA1) computed in the browser, so a
 * key can be checked against the phone before it is saved. Pure JavaScript:
 * works on plain-HTTP intranet servers too (Web Crypto needs HTTPS).
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpKey { secret: string; digits: number; period: number; issuer?: string; account?: string }

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('The key must be Base32 (letters A-Z and digits 2-7)');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A Base32 key or an otpauth://totp/… link (the content of the QR code). */
export function parseKey(value: string): TotpKey {
  const v = value.trim();
  if (!/^otpauth:\/\//i.test(v)) {
    base32Decode(v);
    return { secret: v.toUpperCase().replace(/[\s=-]/g, ''), digits: 6, period: 30 };
  }
  const url = new URL(v);
  if (url.hostname.toLowerCase() !== 'totp') throw new Error('Only time-based keys (otpauth://totp/…) are supported');
  const secret = (url.searchParams.get('secret') ?? '').toUpperCase();
  base32Decode(secret);
  if ((url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1') throw new Error('Only SHA1 keys are supported (like most authenticator apps)');
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [issuer, account] = label.includes(':') ? label.split(/:([\s\S]*)/) : [undefined, label];
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  return {
    secret,
    digits: [6, 7, 8].includes(digits) ? digits : 6,
    period: period > 0 && period <= 300 ? period : 30,
    issuer: url.searchParams.get('issuer') ?? issuer ?? undefined,
    account: account?.trim() || undefined,
  };
}

function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const words = new Uint32Array((((ml + 8) >> 6) + 1) * 16);
  for (let i = 0; i < ml; i++) words[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  words[words.length - 1] = ml * 8;
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let i = 0; i < words.length; i += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[i + t];
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => { out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 255; out[i * 4 + 2] = (h >>> 8) & 255; out[i * 4 + 3] = h & 255; });
  return out;
}

function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha1(key) : key;
  const padded = new Uint8Array(64);
  padded.set(k);
  k = padded;
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

/** Current code and seconds until it changes. */
export function currentCode(key: string, at = Date.now()): { code: string; secondsLeft: number; key: TotpKey } {
  const k = parseKey(key);
  const counter = Math.floor(at / 1000 / k.period);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = hmacSha1(base32Decode(k.secret), msg);
  const offset = mac[19] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const code = String(bin % 10 ** k.digits).padStart(k.digits, '0');
  return { code, secondsLeft: k.period - (Math.floor(at / 1000) % k.period), key: k };
}
