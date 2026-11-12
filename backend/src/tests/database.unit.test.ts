/**
 * Database steps: placeholders, the read-only guard, result checks, settings; each driver is
 * loaded and reports a readable error when the database cannot be reached.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkResult, DbConnections, isReadOnlySql, toDriverSql, validateDatabases } from '../modules/database/db.js';

describe('database steps', () => {
  it('converts ? to each database\'s placeholders, not inside quotes or comments', () => {
    const sql = "SELECT * FROM t WHERE a = ? AND b = '?' AND c = ? -- why?\n/* ? */ AND d ?? e";
    assert.equal(toDriverSql(sql, 'postgres'), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2 -- why?\n/* ? */ AND d ? e");
    assert.equal(toDriverSql(sql, 'sqlserver'), "SELECT * FROM t WHERE a = @p1 AND b = '?' AND c = @p2 -- why?\n/* ? */ AND d ? e");
    assert.equal(toDriverSql(sql, 'oracle'), "SELECT * FROM t WHERE a = :1 AND b = '?' AND c = :2 -- why?\n/* ? */ AND d ? e");
    assert.equal(toDriverSql(sql, 'mysql'), sql, 'mysql2 understands ? itself');
  });

  it('allows one SELECT-like statement on read-only databases', () => {
    for (const ok of ['SELECT 1', '  select * from orders;', 'WITH x AS (SELECT 1) SELECT * FROM x', "SELECT 'delete' AS word", 'EXPLAIN SELECT 1', '-- note\nSELECT 2']) assert.equal(isReadOnlySql(ok), true, ok);
    for (const bad of ['DELETE FROM t', 'SELECT 1; DELETE FROM t', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'SELECT * INTO copy FROM t', 'UPDATE t SET a = 1', 'select pg_sleep(1); drop table t']) {
      assert.equal(isReadOnlySql(bad), false, bad);
    }
  });

  it('checks results', () => {
    const r = { rows: [{ Status: 'new', total: '42.00', at: new Date('2026-01-02T03:04:05Z'), note: null }], rowCount: 1, columns: [] };
    assert.deepEqual(checkResult(r, { rows: 1, equals: { status: 'new', TOTAL: 42.0.toFixed(2), note: null } }), []);
    assert.deepEqual(checkResult(r, { rows: '>0', contains: '2026-01-02' }), []);
    assert.deepEqual(checkResult(r, { rows: 2, equals: { status: 'paid', missing: 1 }, empty: true }), [
      'expected no rows but got 1', 'expected 2 row(s) but got 1', 'Status is "new", expected "paid"', 'no column "missing" (columns: Status, total, at, note)',
    ]);
    assert.deepEqual(checkResult({ rows: [], rowCount: 0, columns: [] }, { equals: { a: 1 }, contains: 'x' }), ['expected a row to compare but got none', 'no cell contains "x"']);
    assert.deepEqual(checkResult(r, { rows: 'lots' }), ['rows must be a number or a comparison like ">0" (got lots)']);
  });

  it('validates settings', () => {
    assert.deepEqual(validateDatabases([{ name: 'crm', type: 'sqlserver', host: 'db', database: 'crm', user: 'qa', password: 'x' }, { name: 'erp', type: 'oracle', url: 'db:1521/ERP' }]), []);
    assert.deepEqual(validateDatabases('x'), ['config.databases must be a list']);
    assert.match(validateDatabases([{ name: 'a b', type: 'postgres', host: 'h', port: 99999, read_only: 'no' }]).join('\n'), /short name[\s\S]*port must be a port number[\s\S]*read_only must be true or false/);
  });

  it('refuses unsafe use before connecting', async () => {
    const dbs = new DbConnections([{ name: 'ro', type: 'postgres', host: '127.0.0.1' }, { name: 'rw', type: 'postgres', host: '127.0.0.1', read_only: false }]);
    await assert.rejects(dbs.query('ro', 'DELETE FROM t', [], { write: true }), /Database "ro" is read-only/);
    await assert.rejects(dbs.query('ro', 'DELETE FROM t'), /Only one SELECT-like statement/);
    await assert.rejects(dbs.query(undefined, 'SELECT 1'), /Say which database \(target\): ro, rw/);
    await assert.rejects(dbs.query('nope', 'SELECT 1'), /Unknown database "nope"/);
    await assert.rejects(dbs.query('rw', ' '), /needs data\.sql/);
    await assert.rejects(new DbConnections([]).query(undefined, 'SELECT 1'), /The agent has no databases/);
  });

  for (const type of ['mysql', 'sqlserver', 'oracle'] as const) {
    it(`loads the ${type} driver and reports an unreachable database`, async () => {
      const dbs = new DbConnections([{ name: 'x', type, host: '127.0.0.1', port: 9, database: 'db', user: 'u', password: 'secret-pw' }]);
      try {
        await assert.rejects(dbs.query('x', 'SELECT 1 FROM dual'), (e: any) => /ECONNREFUSED|connect|Failed to connect|NJS-|ORA-|ETIMEDOUT|ESOCKET/i.test(String(e.message)) && !String(e.message).includes('secret-pw'));
      } finally {
        await dbs.closeAll();
      }
    });
  }
});
