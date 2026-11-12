/**
 * Project-scoped automation routes: schedules, notification channels, analytics.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { ScheduleService, validateCron, validateTimezone } from '../../modules/automation/schedule.service.js';
import { getNotificationService, validateChannel } from '../../modules/automation/notification.service.js';
import { sendDigest } from '../../modules/automation/digest.js';
import { AnalyticsService } from '../../modules/automation/analytics.service.js';
import { OrchestratorService, RunValidationError } from '../../modules/orchestration/services/orchestrator.service.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    const status = error instanceof RunValidationError ? error.statusCode : 500;
    if (!res.headersSent) res.status(status).json({ error: error.message });
  });
};

export function registerAutomationRoutes(
  router: Router,
  roles: { viewer: RequestHandler; editor: RequestHandler; projectAdmin: RequestHandler },
): void {
  const { viewer, editor, projectAdmin } = roles;
  const schedules = new ScheduleService();
  const notifications = getNotificationService();
  const analytics = new AnalyticsService();
  const agents = new AgentRepository();

  // ── Schedules ─────────────────────────────────────────────────────────────
  router.get('/schedules', viewer, wrap(async (req, res) => {
    res.json(await schedules.list(req.project!.id, req.query.agentId ? String(req.query.agentId) : undefined));
  }));

  router.post('/schedules', editor, audit('schedule.create', 'schedule'), wrap(async (req, res) => {
    const { agentId, name, cron, timezone = 'UTC', enabled = true } = req.body ?? {};
    const agent = agentId ? await agents.findById(String(agentId), req.project!.id) : null;
    if (!agent) {
      res.status(400).json({ error: 'agentId must reference an agent in this project' });
      return;
    }
    if (!validateTimezone(String(timezone))) {
      res.status(400).json({ error: `Unknown timezone "${timezone}" (use an IANA name such as Europe/Rome)` });
      return;
    }
    const cronError = validateCron(String(cron ?? ''), String(timezone));
    if (cronError) {
      res.status(400).json({ error: cronError });
      return;
    }
    const created = await schedules.create({
      projectId: req.project!.id, agentId: agent.id, name: String(name || `${agent.name} schedule`).slice(0, 255),
      cron: String(cron), timezone: String(timezone), enabled: !!enabled, createdBy: req.user?.email,
    });
    res.locals.audit = { entityId: created.id, details: { agentId: agent.id, cron, timezone } };
    res.status(201).json(created);
  }));

  router.put('/schedules/:id', editor, audit('schedule.update', 'schedule'), wrap(async (req, res) => {
    const current = await schedules.get(req.params.id, req.project!.id);
    if (!current) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const { name, cron, timezone, enabled } = req.body ?? {};
    const tz = String(timezone ?? current.timezone);
    if (!validateTimezone(tz)) {
      res.status(400).json({ error: `Unknown timezone "${tz}"` });
      return;
    }
    const cronError = validateCron(String(cron ?? current.cron), tz);
    if (cronError) {
      res.status(400).json({ error: cronError });
      return;
    }
    res.locals.audit = { details: { name, cron, timezone, enabled } };
    res.json(await schedules.update(req.params.id, req.project!.id, { name, cron, timezone, enabled }));
  }));

  router.delete('/schedules/:id', editor, audit('schedule.delete', 'schedule'), wrap(async (req, res) => {
    if (!(await schedules.delete(req.params.id, req.project!.id))) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.status(204).send();
  }));

  router.post('/schedules/:id/run', editor, audit('schedule.run_now', 'schedule'), wrap(async (req, res) => {
    const s = await schedules.get(req.params.id, req.project!.id);
    if (!s) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const run = await OrchestratorService.get().startRun({
      agentId: s.agentId, projectId: s.projectId,
      metadata: { triggeredBy: 'schedule', scheduleId: s.id, scheduleName: s.name, startedBy: req.user?.email },
    });
    res.status(201).json(run);
  }));

  // ── Notification channels ─────────────────────────────────────────────────
  router.get('/notifications', viewer, wrap(async (req, res) => {
    res.json(await notifications.list(req.project!.id));
  }));

  router.post('/notifications', projectAdmin, audit('notification.create', 'notification_channel'), wrap(async (req, res) => {
    const { name, type, config, events = ['run.failed'], enabled = true } = req.body ?? {};
    const errors = validateChannel(type, config, events);
    if (!name) errors.unshift('name is required');
    if (errors.length) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    const created = await notifications.create({
      projectId: req.project!.id, name: String(name), type, config, events, enabled, createdBy: req.user?.email,
    });
    res.locals.audit = { entityId: created.id, details: { name, type, events } };
    res.status(201).json(created);
  }));

  router.post('/notifications/:id/digest', projectAdmin, audit('notification.digest', 'notification_channel'), wrap(async (req, res) => {
    const channel = await notifications.get(req.params.id, req.project!.id);
    if (!channel) return void res.status(404).json({ error: 'Channel not found' });
    res.json(await sendDigest({ id: channel.id, projectId: channel.projectId }));
  }));

  router.put('/notifications/:id', projectAdmin, audit('notification.update', 'notification_channel'), wrap(async (req, res) => {
    const current = await notifications.get(req.params.id, req.project!.id);
    if (!current) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const { name, config, events, enabled } = req.body ?? {};
    const errors = validateChannel(current.type, config, events, true);
    if (errors.length) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    res.locals.audit = { details: { name, events, enabled, configChanged: config !== undefined } };
    res.json(await notifications.update(req.params.id, req.project!.id, { name, config, events, enabled }));
  }));

  router.delete('/notifications/:id', projectAdmin, audit('notification.delete', 'notification_channel'), wrap(async (req, res) => {
    if (!(await notifications.delete(req.params.id, req.project!.id))) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.status(204).send();
  }));

  router.post('/notifications/:id/test', projectAdmin, wrap(async (req, res) => {
    const result = await notifications.sendTest(req.params.id, req.project!.id);
    res.status(result.ok ? 200 : 502).json(result);
  }));

  router.get('/notifications/:id/deliveries', viewer, wrap(async (req, res) => {
    if (!(await notifications.get(req.params.id, req.project!.id))) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json(await notifications.deliveries(req.params.id));
  }));

  // ── Analytics ─────────────────────────────────────────────────────────────
  router.get('/analytics', viewer, wrap(async (req, res) => {
    res.json(await analytics.get(req.project!.id, parseInt(String(req.query.days ?? '30')) || 30));
  }));
}
