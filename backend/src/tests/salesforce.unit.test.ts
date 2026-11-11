/**
 * Unit tests for Salesforce personas (no database, no network): `npm test`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../modules/execution/step-runner.js';

import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../modules/salesforce/totp.js';
import { audienceFor } from '../modules/salesforce/oauth.js';
import { salesforceSettings, testPersonas, validatePersonas, findPersona } from '../modules/salesforce/personas.js';
import { SalesforceSessions } from '../modules/salesforce/session.js';
import { compareAccess } from '../modules/execution/step-runner.js';
import { decryptAgentConfig, hasPlaintextSecrets, redactAgentConfig, sealAgentConfig, secretValues } from '../core/domain/agent-secrets.js';

describe('TOTP (RFC 4226 / RFC 6238)', () => {
  const rfcKey = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(rfcKey, counter), code));
  });

  it('matches the RFC 6238 SHA-1 vectors (8 digits)', () => {
    const secret = base32Encode(rfcKey);
    assert.equal(totp(secret, 59_000, { digits: 8 }), '94287082');
    assert.equal(totp(secret, 1111111109_000, { digits: 8 }), '07081804');
    assert.equal(totp(secret, 2000000000_000, { digits: 8 }), '69279037');
  });

  it('decodes Base32 leniently and rejects garbage', () => {
    assert.deepEqual(base32Decode('jbsw y3dp-ehpk3pxp=='), base32Decode('JBSWY3DPEHPK3PXP'));
    assert.throws(() => base32Decode('not base32!'), /Base32/);
  });

  it('verifies with one step of clock drift', () => {
    const now = 1_700_000_000_000;
    const code = totp('JBSWY3DPEHPK3PXP', now - 30_000);
    assert.equal(verifyTotp('JBSWY3DPEHPK3PXP', code, now), true);
    assert.equal(verifyTotp('JBSWY3DPEHPK3PXP', code, now + 60_000), false);
  });
});

describe('Salesforce persona config', () => {
  it('chooses the JWT audience by org type', () => {
    assert.equal(audienceFor('https://login.salesforce.com'), 'https://login.salesforce.com');
    assert.equal(audienceFor('https://acme.my.salesforce.com/'), 'https://login.salesforce.com');
    assert.equal(audienceFor('https://test.salesforce.com'), 'https://test.salesforce.com');
    assert.equal(audienceFor('https://acme--uat.sandbox.my.salesforce.com'), 'https://test.salesforce.com');
    assert.equal(audienceFor('http://localhost:3000/demo/salesforce/'), 'http://localhost:3000/demo/salesforce');
  });

  it('turns a legacy single-user config into persona "default"', () => {
    const s = salesforceSettings({ base_url: 'https://acme.lightning.force.com', salesforce: { username: 'u@x.com', password: 'p' } })!;
    assert.equal(s.personas[0].name, 'default');
    assert.equal(s.personas[0].auth_method, 'password');
    assert.equal(s.defaultPersona, 'default');
    assert.equal(s.loginUrl, 'https://acme.lightning.force.com');
    assert.equal(salesforceSettings({ base_url: 'x' }), null);
    assert.equal(salesforceSettings({ salesforce: { sandbox: true, username: 'u' } })!.loginUrl, 'https://test.salesforce.com');
  });

  it('picks the api persona and resolves names case-insensitively', () => {
    const s = salesforceSettings({ salesforce: { personas: [
      { name: 'rep', auth_method: 'password', username: 'r' },
      { name: 'Admin', auth_method: 'jwt', username: 'a' },
    ] } })!;
    assert.equal(s.apiPersona, 'Admin');
    assert.equal(findPersona(s, 'admin').username, 'a');
    assert.equal(findPersona(s).name, 'rep');
    assert.throws(() => findPersona(s, 'ghost'), /Unknown Salesforce persona "ghost" — configured: rep, Admin/);
    assert.deepEqual(testPersonas({ personas: 'all' }, s), ['rep', 'Admin']);
    assert.deepEqual(testPersonas({ personas: 'rep, Admin,rep' }, s), ['rep', 'Admin']);
    assert.deepEqual(testPersonas({}, s), []);
  });

  it('validates personas', () => {
    const ok = { personas: [{ name: 'admin', auth_method: 'jwt', username: 'a@x' }, { name: 'rep', auth_method: 'login_as', username: 'r@x', login_as_via: 'admin' }] };
    assert.doesNotThrow(() => validatePersonas(ok));
    assert.throws(() => validatePersonas({ personas: [{ name: 'bad name', auth_method: 'jwt', username: 'a' }] }), /Invalid persona name/);
    assert.throws(() => validatePersonas({ personas: [{ name: 'a', auth_method: 'magic', username: 'a' }] }), /auth_method/);
    assert.throws(() => validatePersonas({ personas: [{ name: 'a', auth_method: 'jwt' }] }), /username is required/);
    assert.throws(() => validatePersonas({ ...ok, default_persona: 'ghost' }), /default_persona/);
    assert.throws(() => validatePersonas({ personas: [{ name: 'a', auth_method: 'login_as', username: 'x', login_as_via: 'a' }] }), /cannot itself use login_as/);
  });

  it('encrypts, redacts and keeps persona secrets across renames', () => {
    const sealed = sealAgentConfig({ base_url: 'x', salesforce: {
      connected_app: { client_id: 'cid', private_key: '-----BEGIN PRIVATE KEY-----abc' },
      personas: [{ name: 'rep', auth_method: 'password_totp', username: 'r', password: 'Pw-123456', totp_secret: 'JBSWY3DPEHPK3PXP' }],
    } });
    const rep = sealed.salesforce.personas[0];
    assert.match(rep.password, /^enc:v1:/);
    assert.match(rep.totp_secret, /^enc:v1:/);
    assert.match(sealed.salesforce.connected_app.private_key, /^enc:v1:/);
    assert.equal(sealed.salesforce.connected_app.client_id, 'cid');
    assert.equal(hasPlaintextSecrets(sealed), false);
    assert.equal(hasPlaintextSecrets({ salesforce: { personas: [{ password: 'plain' }] } }), true);

    const redacted = redactAgentConfig(sealed);
    assert.equal(redacted.salesforce.personas[0].password, '••••••••');
    assert.ok(!JSON.stringify(redacted).includes('enc:v1:'));

    // Client renames the persona and sends redacted values back: secrets are kept
    const renamed = sealAgentConfig({ ...redacted, salesforce: { ...redacted.salesforce, personas: [{ ...redacted.salesforce.personas[0], name: 'sales_rep', previous_name: 'rep' }] } }, sealed);
    const plain = decryptAgentConfig(renamed);
    assert.equal(plain.salesforce.personas[0].name, 'sales_rep');
    assert.equal(plain.salesforce.personas[0].password, 'Pw-123456');
    assert.equal(plain.salesforce.personas[0].previous_name, undefined);
    assert.equal(plain.salesforce.connected_app.private_key, '-----BEGIN PRIVATE KEY-----abc');
    assert.ok(secretValues(plain).includes('JBSWY3DPEHPK3PXP'));

    // Empty string clears a secret
    const cleared = decryptAgentConfig(sealAgentConfig({ salesforce: { personas: [{ ...redacted.salesforce.personas[0], totp_secret: '' }] } }, sealed));
    assert.equal(cleared.salesforce.personas[0].totp_secret, undefined);
    assert.equal(cleared.salesforce.personas[0].password, 'Pw-123456');
  });

  it('reports identity drift', () => {
    const persona = { name: 'rep', auth_method: 'password' as const, username: 'r', expected_profile: 'Standard User', expected_permission_sets: ['Sales_Ops', 'Reports'] };
    assert.deepEqual(SalesforceSessions.identityMismatches(persona, { userId: '1', profile: 'standard user', permissionSets: ['sales_ops', 'Reports'] }), []);
    assert.deepEqual(SalesforceSessions.identityMismatches(persona, { userId: '1', profile: 'System Administrator', permissionSets: ['Sales_Ops'] }), [
      'profile is "System Administrator", expected "Standard User"', 'missing permission set(s): Reports',
    ]);
  });

  it('compares expected and actual access', () => {
    const actual = { read: true, create: false, edit: true, delete: false, via: 'self' };
    assert.match(compareAccess('Opportunity', actual, { read: true, edit: 'yes', delete: 'false' }, 'rep'), /as expected \(read=yes, edit=yes, delete=no\)/);
    assert.throws(() => compareAccess('Opportunity', actual, { delete: true }, 'rep'), /Unexpected access to Opportunity for rep: delete is denied \(expected allowed\)/);
    assert.throws(() => compareAccess('Opportunity', actual, {}), /Give the expected access/);
    assert.throws(() => compareAccess('Opportunity', actual, { read: 'maybe' }), /true\/false/);
  });

  it('classifies persona and permission steps', () => {
    const cases: Array<[string, any, string]> = [
      ['salesforce_login', {}, 'salesforce_login'],
      ['Log in as', { target: 'rep' }, 'salesforce_login'],
      ['salesforce_logout', {}, 'salesforce_logout'],
      ['assert_object_access', { target: 'Account' }, 'assert_object_access'],
      ['assert_field_access', { target: 'Account.Name' }, 'assert_field_access'],
      ['assert_record_access', { target: '001' }, 'assert_record_access'],
      ['assert_profile', {}, 'assert_profile'],
      ['Verify access denied', { target: '/lightning/setup' }, 'assert_access_denied'],
      ['Verify the user sees Insufficient Privileges', {}, 'assert_access_denied'],
      ['Verify the Delete button is not visible', { target: 'Delete button' }, 'assert_not_visible'],
      ['Verify the Delete button is hidden', { target: 'Delete button' }, 'assert_not_visible'],
      ['Verify the Delete button is visible', { target: 'Delete button' }, 'assert_visible'],
      ['Log out', { target: 'Sign out link' }, 'manual'],
    ];
    for (const [action, step, kind] of cases) assert.equal(classifyAction(action, step), kind, action);
  });
});
