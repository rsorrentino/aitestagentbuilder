/**
 * Sign-in & MFA (no database): login profiles, TOTP keys, secrets handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authSettings, findProfile, validateAuth } from '../modules/auth/profiles.js';
import { parseTotpKey, totp, totpFor } from '../modules/salesforce/totp.js';
import { decryptAgentConfig, redactAgentConfig, sealAgentConfig, secretValues } from '../core/domain/agent-secrets.js';
import { REDACTED } from '../infra/security/secrets.js';

describe('login profiles', () => {
  it('normalizes profiles with safe defaults', () => {
    const s = authSettings({ auth: { default_profile: 'buyer', profiles: [{ name: 'buyer', username: 'b@example.com', session: { max_age_hours: 0 } }] } })!;
    const p = findProfile(s);
    assert.equal(p.name, 'buyer');
    assert.deepEqual(p.session, { reuse: true, maxAgeHours: 12 });
    assert.equal(authSettings({ auth: { profiles: [] } }), null);
    assert.throws(() => findProfile(s, 'nobody'), /Unknown login profile "nobody" — configured: buyer/);
  });

  it('validates names, defaults and TOTP keys', () => {
    assert.doesNotThrow(() => validateAuth({ profiles: [{ name: 'a' }, { name: 'b', totp_secret: 'otpauth://totp/X:a?secret=JBSWY3DPEHPK3PXP' }] }));
    assert.throws(() => validateAuth({ profiles: [{ name: 'a' }, { name: 'A' }] }), /Duplicate login profile/);
    assert.throws(() => validateAuth({ profiles: [{ name: 'bad name' }] }), /Invalid login profile name/);
    assert.throws(() => validateAuth({ default_profile: 'x', profiles: [{ name: 'a' }] }), /default_profile "x"/);
    assert.throws(() => validateAuth({ profiles: [{ name: 'a', totp_secret: 'not base32!' }] }), /Base32 key/);
  });

  it('encrypts profile secrets, keeps them on edits and masks them', () => {
    const sealed = sealAgentConfig({ auth: { profiles: [{ name: 'a', username: 'u', password: 'pw-123456', totp_secret: 'JBSWY3DPEHPK3PXP' }] } });
    assert.notEqual(sealed.auth.profiles[0].password, 'pw-123456');
    assert.equal(redactAgentConfig(sealed).auth.profiles[0].password, REDACTED);
    // The client sends the redacted value back unchanged: the stored secret stays
    const edited = sealAgentConfig({ auth: { profiles: [{ name: 'a', username: 'u2', password: REDACTED, totp_secret: REDACTED }] } }, sealed);
    const plain = decryptAgentConfig(edited);
    assert.equal(plain.auth.profiles[0].password, 'pw-123456');
    assert.equal(plain.auth.profiles[0].username, 'u2');
    assert.ok(secretValues(plain).includes('pw-123456'));
    assert.ok(secretValues(plain).includes('JBSWY3DPEHPK3PXP'));
  });
});

describe('TOTP keys', () => {
  it('reads Base32 keys and otpauth links', () => {
    assert.deepEqual(parseTotpKey('jbsw y3dp ehpk 3pxp'), { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 });
    const k = parseTotpKey('otpauth://totp/ACME%20Corp:qa%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Corp&digits=8&period=60');
    assert.deepEqual(k, { secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60, issuer: 'ACME Corp', account: 'qa@example.com' });
    const at = Date.UTC(2026, 0, 1);
    assert.equal(totpFor('JBSWY3DPEHPK3PXP', at), totp('JBSWY3DPEHPK3PXP', at));
    assert.equal(totpFor('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60', at), totp('JBSWY3DPEHPK3PXP', at, { step: 60, digits: 8 }));
    assert.throws(() => parseTotpKey('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP'), /time-based/);
    assert.throws(() => parseTotpKey('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256'), /SHA1 only/);
  });
});

describe('verification codes by email / SMS', () => {
  it('finds the code in common message formats', async () => {
    const { extractCode } = await import('../modules/auth/code-sources.js');
    assert.equal(extractCode('Verification Code: 482913\nIf you didn’t try to log in…'), '482913');
    assert.equal(extractCode('Use the code 271828 to sign in. It expires in 10 minutes. Reference 2026-11-12.'), '271828');
    assert.equal(extractCode('G-845201 is your Google verification code.'), '845201');
    assert.equal(extractCode('Your one-time passcode is 12345678'), '12345678');
    assert.equal(extractCode('Il tuo codice di verifica è 314159'), '314159');
    assert.equal(extractCode('Order 2026-11-12 total 120.50, call 555-1234'), null, 'dates, amounts and phone numbers are not codes');
    assert.equal(extractCode('Token: AB12-CD34', 'Token: ([A-Z0-9-]+)'), 'AB12-CD34');
  });

  it('validates sources and keeps their secrets encrypted', async () => {
    const { validateSources } = await import('../modules/auth/code-sources.js');
    assert.doesNotThrow(() => validateSources([{ name: 'inbox', type: 'email', host: 'imap.example.com', username: 'qa' }, { name: 'phone', type: 'sms', account_sid: `AC${'a'.repeat(32)}`, phone_number: '+15550001111' }]));
    assert.throws(() => validateSources([{ name: 'x', type: 'email' }]), /host and username/);
    assert.throws(() => validateSources([{ name: 'x', type: 'pigeon' }]), /type must be email or sms/);
    assert.throws(() => validateSources([{ name: 'x', type: 'email', host: 'h', username: 'u', code_pattern: '(' }]), /not a valid regular expression/);
    const sealed = sealAgentConfig({ code_sources: [{ name: 'inbox', type: 'email', host: 'h', username: 'u', password: 'imap-secret-1' }] });
    assert.notEqual(sealed.code_sources[0].password, 'imap-secret-1');
    assert.equal(redactAgentConfig(sealed).code_sources[0].password, REDACTED);
    const kept = sealAgentConfig({ code_sources: [{ name: 'inbox', type: 'email', host: 'h2', username: 'u', password: REDACTED }] }, sealed);
    assert.equal(decryptAgentConfig(kept).code_sources[0].password, 'imap-secret-1');
    assert.ok(secretValues(decryptAgentConfig(kept)).includes('imap-secret-1'));
  });
});

describe('sign-in health', () => {
  it('knows who can sign in without a person', async () => {
    const { unattendedOf } = await import('../modules/auth/health.js');
    assert.equal(unattendedOf('app', { username: 'u', password: 'p', totp_secret: 'K' }).unattended, 'yes');
    assert.equal(unattendedOf('app', { username: 'u', password: 'p', codes: { source: 'inbox' } }).how, 'password + codes from inbox');
    assert.equal(unattendedOf('app', { username: 'u', password: 'p' }).unattended, 'maybe');
    assert.equal(unattendedOf('app', { username: 'u' }).unattended, 'no');
    assert.equal(unattendedOf('salesforce', { auth_method: 'jwt' }).unattended, 'yes');
    assert.equal(unattendedOf('salesforce', { auth_method: 'password_totp', password: 'p', totp_secret: 'K' }).unattended, 'yes');
    assert.equal(unattendedOf('salesforce', { auth_method: 'password', password: 'p' }).unattended, 'maybe');
    assert.equal(unattendedOf('salesforce', { auth_method: 'password', password: 'p', codes: { source: 'sf_inbox' } }).unattended, 'yes');
  });
});

describe('parallel sign-ins', async () => {
  const { KeyedLock } = await import('../modules/auth/keyed-lock.js');
  const { freshTotp, totp } = await import('../modules/salesforce/totp.js');

  it('runs work for the same key one at a time, other keys in parallel', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => { order.push(`${name}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${name}-`); return name; };
    const results = await Promise.all([lock.run('alice', job('a1', 30)), lock.run('alice', job('a2', 1)), lock.run('bob', job('b1', 1))]);
    assert.deepEqual(results, ['a1', 'a2', 'b1']);
    assert.ok(order.indexOf('a1-') < order.indexOf('a2+'), 'the second alice waits for the first');
    assert.ok(order.indexOf('b1-') < order.indexOf('a1-'), 'bob does not wait for alice');
    await assert.rejects(lock.run('alice', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await lock.run('alice', async () => 'after an error'), 'after an error');
  });

  it('never types the same authenticator code twice', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12, 0, 5) });
    const key = 'JBSWY3DPEHPK3PXP';
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); t.mock.timers.tick(ms); };
    const first = await freshTotp(key, wait);
    assert.equal(first, totp(key, Date.UTC(2026, 0, 1, 12, 0, 5)));
    assert.deepEqual(waits, []);
    const second = await freshTotp(key, wait);
    assert.equal(waits.length, 1, 'waited for the next period');
    assert.notEqual(second, first);
    assert.equal(second, totp(key, Date.now()));
    // A code about to expire is not used either
    t.mock.timers.setTime(Date.UTC(2026, 0, 1, 12, 1, 58));
    waits.length = 0;
    await freshTotp(key, wait);
    assert.equal(waits.length, 1);
  });
});
