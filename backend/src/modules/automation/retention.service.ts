/**
 * Data retention: deletes old runs (with their results and screenshots) and
 * old audit entries. Disabled when the corresponding variable is 0.
 *
 *   RUN_RETENTION_DAYS    default 90
 *   AUDIT_RETENTION_DAYS  default 365
 */

import { rmSync } from 'fs';
import { join } from 'path';
import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import { ARTIFACTS_PATH } from '../execution/run-executor.js';

export async function applyRetention(): Promise<{ runs: number; auditEntries: number }> {
  const db = getDatabaseClient();
  const runDays = parseInt(process.env.RUN_RETENTION_DAYS ?? '90');
  const auditDays = parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365');
  let runs = 0;
  let auditEntries = 0;

  if (runDays > 0) {
    const deleted = await db.query(
      `DELETE FROM runs WHERE started_at < NOW() - ($1 || ' days')::interval AND status NOT IN ('pending', 'running') RETURNING id`,
      [String(runDays)],
    );
    runs = deleted.rowCount ?? 0;
    for (const row of deleted.rows) {
      try {
        rmSync(join(ARTIFACTS_PATH, row.id), { recursive: true, force: true });
      } catch {
        // artifacts are best-effort
      }
    }
  }

  if (auditDays > 0) {
    const deleted = await db.query(`DELETE FROM audit_log WHERE at < NOW() - ($1 || ' days')::interval`, [String(auditDays)]);
    auditEntries = deleted.rowCount ?? 0;
  }

  if (runs || auditEntries) logger.info('Retention applied', { runsDeleted: runs, auditEntriesDeleted: auditEntries, runDays, auditDays });
  return { runs, auditEntries };
}
