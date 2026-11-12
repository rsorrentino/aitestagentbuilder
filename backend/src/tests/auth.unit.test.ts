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
