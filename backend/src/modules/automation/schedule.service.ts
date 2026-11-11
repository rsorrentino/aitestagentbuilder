/**
 * Scheduled runs (cron per agent).
 *
 * The scheduler tick claims due schedules with FOR UPDATE SKIP LOCKED and
 * advances next_run_at in the same transaction, so with several API replicas
 * each occurrence starts exactly one run.
 */

import { CronExpressionParser } from 'cron-parser';
import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import { OrchestratorService } from '../orchestration/services/orchestrator.service.js';

export interface Schedule {
  id: string;
  projectId: string;
  agentId: string;
  agentName?: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt?: Date;
  lastRunAt?: Date;
  lastRunId?: string;
  lastError?: string;
  createdAt: Date;
  createdBy?: string;
}

const minIntervalMinutes = () => Math.max(1, parseInt(process.env.MIN_SCHEDULE_INTERVAL_MINUTES || '5'));

export function validateTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next occurrence after `from`; throws on invalid expressions. */
export function nextOccurrence(cron: string, timezone: string, from: Date = new Date()): Date {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: from }).next().toDate();
}

/** Returns an error message, or null when the cron expression is acceptable. */
export function validateCron(cron: string, timezone: string): string | null {
  if (typeof cron !== 'string' || cron.trim().split(/\s+/).length !== 5) {
    return 'cron must have 5 fields: minute hour day-of-month month day-of-week (e.g. "0 6 * * 1-5")';
  }
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    if ((b - a) / 60000 < minIntervalMinutes()) {
      return `Schedules must be at least ${minIntervalMinutes()} minutes apart`;
    }
    return null;
  } catch (error: any) {
    return `Invalid cron expression: ${error.message}`;
  }
}

function map(row: any): Schedule {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? undefined,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
  };
}

export class ScheduleService {
  private db = getDatabaseClient();

  async list(projectId: string, agentId?: string): Promise<Schedule[]> {
    const result = await this.db.query(
      `SELECT s.*, a.name AS agent_name FROM schedules s JOIN agents a ON a.id = s.agent_id
        WHERE s.project_id = $1 ${agentId ? 'AND s.agent_id = $2' : ''} ORDER BY s.created_at`,
      agentId ? [projectId, agentId] : [projectId],
    );
    return result.rows.map(map);
  }

  async get(id: string, projectId: string): Promise<Schedule | null> {
    const result = await this.db.query(
      `SELECT s.*, a.name AS agent_name FROM schedules s JOIN agents a ON a.id = s.agent_id WHERE s.id = $1 AND s.project_id = $2`,
      [id, projectId],
    );
    return result.rows.length ? map(result.rows[0]) : null;
  }

  async create(input: { projectId: string; agentId: string; name: string; cron: string; timezone: string; enabled: boolean; createdBy?: string }): Promise<Schedule> {
    const id = `SCH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = input.enabled ? nextOccurrence(input.cron, input.timezone) : null;
    await this.db.query(
      `INSERT INTO schedules (id, project_id, agent_id, name, cron, timezone, enabled, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.projectId, input.agentId, input.name, input.cron.trim(), input.timezone, input.enabled, next, input.createdBy ?? null],
    );
    return (await this.get(id, input.projectId))!;
  }

  async update(id: string, projectId: string, input: { name?: string; cron?: string; timezone?: string; enabled?: boolean }): Promise<Schedule | null> {
    const current = await this.get(id, projectId);
    if (!current) return null;
    const merged = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Schedule;
    const next = merged.enabled ? nextOccurrence(merged.cron, merged.timezone) : null;
    await this.db.query(
      `UPDATE schedules SET name = $1, cron = $2, timezone = $3, enabled = $4, next_run_at = $5 WHERE id = $6 AND project_id = $7`,
      [merged.name, merged.cron.trim(), merged.timezone, merged.enabled, next, id, projectId],
    );
    return this.get(id, projectId);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM schedules WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Start runs for every due schedule. Returns the number of runs started. */
  async tick(now: Date = new Date()): Promise<number> {
    const client = await this.db.getClient();
    const claimed: Schedule[] = [];
    try {
      await client.query('BEGIN');
      const due = await client.query(
        `SELECT * FROM schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
          ORDER BY next_run_at LIMIT 25 FOR UPDATE SKIP LOCKED`,
        [now],
      );
      for (const row of due.rows) {
        const s = map(row);
        let next: Date | null = null;
        try {
          next = nextOccurrence(s.cron, s.timezone, now);
        } catch (error: any) {
          await client.query('UPDATE schedules SET enabled = false, last_error = $1 WHERE id = $2', [`Disabled: ${error.message}`, s.id]);
          continue;
        }
        await client.query('UPDATE schedules SET next_run_at = $1, last_run_at = $2 WHERE id = $3', [next, now, s.id]);
        claimed.push(s);
      }
      await client.query('COMMIT');
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error('Scheduler tick failed', { error: error.message });
      return 0;
    } finally {
      client.release();
    }

    let started = 0;
    for (const s of claimed) {
      try {
        const run = await OrchestratorService.get().startRun({
          agentId: s.agentId,
          projectId: s.projectId,
          metadata: { triggeredBy: 'schedule', scheduleId: s.id, scheduleName: s.name },
        });
        await this.db.query('UPDATE schedules SET last_run_id = $1, last_error = NULL WHERE id = $2', [run.id, s.id]);
        logger.info('Scheduled run started', { schedule: s.name, runId: run.id });
        started++;
      } catch (error: any) {
        await this.db.query('UPDATE schedules SET last_error = $1 WHERE id = $2', [error.message, s.id]);
        logger.warn('Scheduled run could not start', { schedule: s.name, error: error.message });
      }
    }
    return started;
  }
}
