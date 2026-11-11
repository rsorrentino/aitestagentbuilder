/**
 * Audit log.
 *
 *   router.post('/agents', audit('agent.create', 'agent'), handler)
 *
 * The middleware records the action after the response is sent, only when it
 * succeeded (status < 400). Handlers can refine the entry through
 * `res.locals.audit = { entityId, details }`. Request bodies are never stored
 * wholesale, so secrets do not end up in the log.
 */

import { NextFunction, Response } from 'express';
import getDatabaseClient from '../db/client.js';
import logger from '../logger/index.js';
import type { AuthenticatedRequest } from '../auth/auth.middleware.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  projectId?: string;
  userId?: string;
  userEmail?: string;
  status?: number;
  ip?: string;
  userAgent?: string;
  details?: Record<string, any>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  at: Date;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await getDatabaseClient().query(
      `INSERT INTO audit_log (action, entity_type, entity_id, project_id, user_id, user_email, status, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.projectId ?? null,
        entry.userId ?? null,
        entry.userEmail ?? null,
        entry.status ?? null,
        entry.ip ?? null,
        entry.userAgent?.slice(0, 500) ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  } catch (error: any) {
    // Auditing must never break the request it describes.
    logger.error('Failed to write audit log entry', { action: entry.action, error: error.message });
  }
}

export function requestMeta(req: AuthenticatedRequest): Pick<AuditEntry, 'userId' | 'userEmail' | 'ip' | 'userAgent' | 'projectId'> {
  return {
    userId: req.user?.userId,
    userEmail: req.user?.email,
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.get('user-agent'),
    projectId: req.project?.id,
  };
}

export function audit(action: string, entityType?: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const extra = (res.locals.audit ?? {}) as { entityId?: string; details?: Record<string, any>; projectId?: string };
      const p = req.params ?? {};
      void recordAudit({
        ...requestMeta(req),
        action,
        entityType,
        entityId: extra.entityId ?? p.id ?? p.documentId ?? p.runId ?? p.userId,
        projectId: extra.projectId ?? req.project?.id,
        status: res.statusCode,
        details: {
          ...(req.apiKey ? { apiKey: req.apiKey.keyId } : {}),
          ...(extra.details ?? {}),
        },
      });
    });
    next();
  };
}

export interface AuditQuery {
  projectId?: string;
  userId?: string;
  action?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function queryAudit(q: AuditQuery): Promise<{ total: number; entries: AuditRecord[] }> {
  const where: string[] = [];
  const values: any[] = [];
  const add = (sql: string, v: any) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
  if (q.projectId) add('project_id = ?', q.projectId);
  if (q.userId) add('user_id = ?', q.userId);
  if (q.action) add('action LIKE ?', `${q.action.replace(/[%_]/g, '')}%`);
  if (q.entityId) add('entity_id = ?', q.entityId);
  if (q.from) add('at >= ?', q.from);
  if (q.to) add('at <= ?', q.to);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDatabaseClient();
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM audit_log ${clause}`, values)).rows[0].n;
  values.push(Math.min(q.limit ?? 100, 5000), q.offset ?? 0);
  const rows = (await db.query(
    `SELECT * FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )).rows;
  return {
    total,
    entries: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      action: r.action,
      entityType: r.entity_type ?? undefined,
      entityId: r.entity_id ?? undefined,
      projectId: r.project_id ?? undefined,
      userId: r.user_id ?? undefined,
      userEmail: r.user_email ?? undefined,
      status: r.status ?? undefined,
      ip: r.ip ?? undefined,
      userAgent: r.user_agent ?? undefined,
      details: r.details ?? undefined,
    })),
  };
}

export function auditToCsv(entries: AuditRecord[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['time', 'user', 'action', 'entity_type', 'entity_id', 'project', 'status', 'ip', 'details'];
  const lines = entries.map((e) => [
    new Date(e.at).toISOString(), e.userEmail, e.action, e.entityType, e.entityId, e.projectId, e.status, e.ip, e.details,
  ].map(esc).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}
