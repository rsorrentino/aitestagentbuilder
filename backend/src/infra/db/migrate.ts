/**
 * Database migrations runner.
 *
 * `runMigrations()` is called on every server start; `npm run db:migrate`
 * runs it standalone. Pending migrations from ./migrations.ts are applied in
 * order, each in its own transaction, under a Postgres advisory lock.
 */

import { fileURLToPath } from 'url';
import { DatabaseClient } from './client.js';
import getDatabaseClient from './client.js';
import { MIGRATIONS } from './migrations.js';
import { VECTOR_SCHEMA } from './schema.js';
import logger from '../logger/index.js';

/** Arbitrary constant identifying this application's migration lock. */
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationResult {
  vector: boolean;
  applied: number[];
  current: number;
}

export async function runMigrations(db: DatabaseClient = getDatabaseClient()): Promise<MigrationResult> {
  const client = await db.getClient();
  const applied: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);

    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)),
    );

    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
        await client.query('COMMIT');
        applied.push(migration.version);
        logger.info(`Applied migration ${migration.version}: ${migration.name}`);
      } catch (error: any) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${error.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }

  // pgvector is optional; probe first so a missing extension is not logged as an error.
  let vector = false;
  const available = await db.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
  if (available.rows.length > 0) {
    try {
      await db.query(VECTOR_SCHEMA);
      vector = true;
    } catch (error: any) {
      logger.warn('pgvector could not be enabled — semantic search disabled', { reason: error.message });
    }
  }

  return { vector, applied, current: Math.max(...MIGRATIONS.map((m) => m.version)) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const db = getDatabaseClient();
  runMigrations(db)
    .then(({ vector, applied, current }) => {
      console.log(`✅ Database at schema version ${current}${applied.length ? ` (applied ${applied.join(', ')})` : ' (up to date)'}` +
        `${vector ? ', pgvector enabled' : ''}`);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.close().catch(() => undefined);
      process.exit(process.exitCode ?? 0); // metrics timers would otherwise keep the process alive
    });
}
