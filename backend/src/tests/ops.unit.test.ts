/**
 * Root operations script (scripts/atab.mjs, used by the root package.json): `npm test`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

// Plain JavaScript outside the TypeScript project: load it dynamically.
const opsUrl = pathToFileURL(resolve(process.cwd(), '..', 'scripts', 'atab.mjs')).href;

describe('operations script (npm run …)', () => {
  it('parses npm-style options', async () => {
    const { parseArgs } = await import(opsUrl);
    assert.deepEqual(parseArgs(['--production', '--host', 'atab.local', '--db=postgresql://u:p@h/db?x=1', '--no-nssm', 'extra']), {
      _: ['extra'], production: true, host: 'atab.local', db: 'postgresql://u:p@h/db?x=1', noNssm: true,
    });
  });

  it('reads .env files (comments, quotes, CRLF)', async () => {
    const { readEnvFile } = await import(opsUrl);
    const file = join(mkdtempSync(join(tmpdir(), 'atab-env-')), '.env');
    writeFileSync(file, '# comment\r\nPORT=3100\r\nNAME="quoted value"\r\n  SPACED = x \r\nnot a line\r\n');
    assert.deepEqual(readEnvFile(file), { PORT: '3100', NAME: 'quoted value', SPACED: 'x' });
    assert.deepEqual(readEnvFile(join(tmpdir(), 'does-not-exist.env')), {});
  });

  it('generates a production .env with fresh secrets and public URLs', async () => {
    const { productionEnv } = await import(opsUrl);
    const a = productionEnv({ host: 'atab.contoso.local', db: 'postgresql://x', adminEmail: 'qa@contoso.com', uiPort: '4100' });
    const b = productionEnv({ host: 'atab.contoso.local' });
    const value = (content: string, key: string) => content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];
    assert.equal(value(a.content, 'NODE_ENV'), 'production');
    assert.equal(value(a.content, 'AUTH_ENABLED'), 'true');
    assert.equal(value(a.content, 'DATABASE_URL'), 'postgresql://x');
    assert.equal(value(a.content, 'NEXT_PUBLIC_API_URL'), 'http://atab.contoso.local:3000/api/v1');
    assert.equal(value(a.content, 'UI_PORT'), '4100');
    assert.match(value(a.content, 'CORS_ORIGIN')!, /^http:\/\/atab\.contoso\.local:4100,/);
    assert.equal(value(a.content, 'ADMIN_PASSWORD'), a.adminPassword);
    assert.notEqual(value(a.content, 'SECRETS_ENCRYPTION_KEY'), value(b.content, 'SECRETS_ENCRYPTION_KEY'));
    assert.ok(value(a.content, 'JWT_SECRET')!.length >= 60);
    // The generated password satisfies the policy (12+, 3 of 4 character classes)
    assert.match(a.adminPassword, /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/);
    const proxied = productionEnv({ publicUrl: 'https://atab.contoso.com/', publicUiUrl: 'https://atab.contoso.com', noAuth: true });
    assert.equal(value(proxied.content, 'NEXT_PUBLIC_API_URL'), 'https://atab.contoso.com/api/v1');
    assert.equal(value(proxied.content, 'AUTH_ENABLED'), 'false');
  });
});
