/**
 * Audit log queries.
 *
 *   GET /audit         — the current project's log (project admins)
 *   GET /admin/audit   — the whole installation (system admins), optional ?projectId=
 * Both accept ?userId &action (prefix) &entityId &from &to &limit &offset &format=csv
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { AuditQuery, auditToCsv, queryAudit } from '../../infra/audit/audit.js';

function parseQuery(req: AuthenticatedRequest): AuditQuery {
  const q = req.query;
  const date = (v: unknown) => {
    if (!v) return undefined;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return {
    userId: q.userId ? String(q.userId) : undefined,
    action: q.action ? String(q.action) : undefined,
    entityId: q.entityId ? String(q.entityId) : undefined,
    from: date(q.from),
    to: date(q.to),
    limit: parseInt(String(q.limit ?? '')) || (q.format === 'csv' ? 5000 : 100),
    offset: parseInt(String(q.offset ?? '')) || 0,
  };
}

async function respond(req: AuthenticatedRequest, res: Response, query: AuditQuery): Promise<void> {
  try {
    const result = await queryAudit(query);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(auditToCsv(result.entries));
      return;
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export class AuditController {
  async project(req: AuthenticatedRequest, res: Response): Promise<void> {
    await respond(req, res, { ...parseQuery(req), projectId: req.project!.id });
  }

  async global(req: AuthenticatedRequest, res: Response): Promise<void> {
    await respond(req, res, { ...parseQuery(req), projectId: req.query.projectId ? String(req.query.projectId) : undefined });
  }
}
