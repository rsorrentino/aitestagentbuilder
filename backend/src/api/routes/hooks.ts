/**
 * Incoming webhooks from code hosts (no login: authenticated by their HMAC signature).
 *
 *   POST /api/v1/hooks/github/:integrationId   (X-Hub-Signature-256, X-GitHub-Event)
 *
 * A push, pull request or successful deployment starts the runs of the integration's
 * matching triggers; their commit gets a status and the pull request a comment.
 */

import { Router, Request, Response } from 'express';
import logger from '../../infra/logger/index.js';
import { OrchestratorService } from '../../modules/orchestration/services/orchestrator.service.js';
import { IntegrationRepository } from '../../modules/integrations/repository.js';
import { parseGitHubEvent, verifyGitHubSignature } from '../../modules/integrations/github.js';
import { matchTriggers } from '../../modules/integrations/triggers.js';

/** Deliveries already handled (GitHub redelivers on timeouts and by hand). */
const seen: string[] = [];
const alreadySeen = (id: string | undefined) => {
  if (!id) return false;
  if (seen.includes(id)) return true;
  seen.push(id);
  if (seen.length > 1000) seen.shift();
  return false;
};

export function registerHookRoutes(router: Router): void {
  const repo = new IntegrationRepository();

  router.post('/hooks/github/:integrationId', async (req: Request, res: Response) => {
    try {
      const integration = await repo.get(req.params.integrationId, undefined, true).catch(() => null);
      if (!integration || integration.type !== 'github') return void res.status(404).json({ error: 'Unknown webhook' });
      const secret = String(integration.config.webhook_secret ?? '');
      if (!secret) return void res.status(403).json({ error: 'Set a webhook secret on the integration (Settings → Integrations) and the same secret on GitHub' });
      const raw: Buffer | undefined = (req as any).rawBody;
      if (!raw || !verifyGitHubSignature(secret, raw, req.get('X-Hub-Signature-256'))) {
        logger.warn('GitHub webhook with a wrong signature', { integration: integration.id });
        return void res.status(401).json({ error: 'Invalid signature (the webhook secret on GitHub must match the integration\'s)' });
      }
      const event = String(req.get('X-GitHub-Event') ?? '');
      if (event === 'ping') return void res.json({ ok: true, message: `Connected to ${integration.name}` });
      if (!integration.enabled) return void res.status(202).json({ ignored: 'The integration is disabled' });
      const delivery = req.get('X-GitHub-Delivery');
      if (alreadySeen(delivery)) return void res.status(202).json({ ignored: 'Delivery already handled' });

      const ev = parseGitHubEvent(event, req.body);
      if (!ev) return void res.status(202).json({ ignored: `Nothing to test for ${event}${req.body?.action ? ` (${req.body.action})` : ''}` });
      if (ev.repository.toLowerCase() !== String(integration.config.repository).toLowerCase()) {
        return void res.status(202).json({ ignored: `The event is for ${ev.repository}, the integration for ${integration.config.repository}` });
      }
      const wanted = matchTriggers(integration.config.triggers ?? [], ev);
      if (!wanted.length) return void res.status(202).json({ ignored: `No trigger matches this ${ev.event}${ev.branch ? ` on ${ev.baseBranch ?? ev.branch}` : ''}${ev.environment ? ` to ${ev.environment}` : ''}` });

      const runs: any[] = [];
      for (const w of wanted) {
        try {
          const run = await OrchestratorService.get().startRun({
            agentId: w.agentId, projectId: integration.projectId, baseUrl: w.baseUrl, testIds: w.testIds,
            metadata: { triggeredBy: 'webhook', git: { provider: 'github', integrationId: integration.id, delivery, ...ev } },
          });
          runs.push({ agentId: w.agentId, runId: run.id, tests: run.totalTests });
        } catch (e: any) {
          runs.push({ agentId: w.agentId, error: e.message });
        }
      }
      logger.info('GitHub webhook started runs', { integration: integration.id, event: ev.event, sha: ev.sha, runs });
      res.status(202).json({ event: ev.event, sha: ev.sha, runs });
    } catch (error: any) {
      logger.error('GitHub webhook failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  });
}
