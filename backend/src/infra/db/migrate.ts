/**
 * Database migrations (idempotent).
 *
 * `runMigrations()` is called on every server start; `npm run db:migrate`
 * runs it standalone.
 */

import { fileURLToPath } from 'url';
import { DatabaseClient } from './client.js';
import getDatabaseClient from './client.js';
import { CORE_SCHEMA, VECTOR_SCHEMA } from './schema.js';
import logger from '../logger/index.js';

export async function runMigrations(db: DatabaseClient = getDatabaseClient()): Promise<{ vector: boolean }> {
  await db.query(CORE_SCHEMA);

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
  return { vector };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const db = getDatabaseClient();
  runMigrations(db)
    .then(({ vector }) => {
      console.log(`✅ Database migration completed${vector ? ' (pgvector enabled)' : ' (pgvector not installed — optional)'}`);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
