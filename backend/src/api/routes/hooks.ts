/**
 * Incoming webhooks from code hosts (no login: authenticated by their signature or secret token).
 *
 *   POST /api/v1/hooks/github/:integrationId   X-Hub-Signature-256 (HMAC of the body), X-GitHub-Event
 *   POST /api/v1/hooks/gitlab/:integrationId   X-Gitlab-Token (the secret), X-Gitlab-Event
 *   POST /api/v1/hooks/azure/:integrationId    X-ATAB-Token header or basic auth password (the secret)
 *
 * A push, pull / merge request or successful deployment starts the runs of the integration's
 * matching triggers; their commit gets a status and the pull / merge request a comment.
 */

import { Router, Request, Response } from 'express';
import logger from '../../infra/logger/index.js';
import { OrchestratorService } from '../../modules/orchestration/services/orchestrator.service.js';
import { IntegrationRepository } from '../../modules/integrations/repository.js';
import { parseGitHubEvent, verifyGitHubSignature } from '../../modules/integrations/github.js';
import { parseGitLabEvent, verifyGitLabToken } from '../../modules/integrations/gitlab.js';
import { parseAzureEvent, verifyAzureHook } from '../../modules/integrations/azure-devops.js';
import { matchTriggers } from '../../modules/integrations/triggers.js';
import { GitEvent, Integration } from '../../modules/integrations/types.js';

interface Provider {
  type: Integration['type'];
  label: string;
  /** Where the secret goes on the host's side, for error messages */
  secretHint: string;
  verify(secret: string, req: Request): boolean;
  /** 'ping' answers a connection test */
  event(req: Request): string;
  delivery(req: Request): string | undefined;
  parse(event: string, body: any): GitEvent | null;
  /** The config value naming the repository / project */
  repository(config: any): string;
}

const PROVIDERS: Record<string, Provider> = {
  github: {
    type: 'github', label: 'GitHub', secretHint: 'the webhook secret on GitHub',
    verify: (secret, req) => !!(req as any).rawBody && verifyGitHubSignature(secret, (req as any).rawBody, req.get('X-Hub-Signature-256')),
    event: (req) => String(req.get('X-GitHub-Event') ?? ''),
    delivery: (req) => req.get('X-GitHub-Delivery'),
    parse: parseGitHubEvent,
    repository: (c) => String(c.repository ?? ''),
  },
  gitlab: {
    type: 'gitlab', label: 'GitLab', secretHint: 'the webhook secret token on GitLab',
    verify: (secret, req) => verifyGitLabToken(secret, req.get('X-Gitlab-Token')),
    // GitLab's "Test" button sends a real event: there is no ping
    event: (req) => String(req.get('X-Gitlab-Event') ?? ''),
    delivery: (req) => req.get('X-Gitlab-Event-UUID') ?? req.get('X-Gitlab-Webhook-UUID'),
    parse: parseGitLabEvent,
    repository: (c) => String(c.project ?? ''),
  },
  azure: {
    type: 'azure_devops', label: 'Azure DevOps', secretHint: 'the X-ATAB-Token header (or basic authentication password) of the service hook',
    verify: (secret, req) => verifyAzureHook(secret, { token: req.get('X-ATAB-Token'), authorization: req.get('Authorization') }),
    // Azure DevOps "Test" sends a sample event for its sample repository: answered "for another repository"
    event: (req) => String(req.body?.eventType ?? ''),
    delivery: (req) => (req.body?.id ? String(req.body.id) : undefined),
    parse: (_event, body) => parseAzureEvent(body),
    repository: (c) => String(c.repository ?? ''),
  },
};

/** Deliveries already handled (hosts redeliver on timeouts and by hand). */
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

  router.post('/hooks/:provider/:integrationId', async (req: Request, res: Response) => {
    const provider = PROVIDERS[req.params.provider];
    if (!provider) return void res.status(404).json({ error: 'Unknown webhook' });
    try {
      const integration = await repo.get(req.params.integrationId, undefined, true).catch(() => null);
      if (!integration || integration.type !== provider.type) return void res.status(404).json({ error: 'Unknown webhook' });
      const secret = String(integration.config.webhook_secret ?? '');
      if (!secret) return void res.status(403).json({ error: `Set a webhook secret on the integration (Settings → Integrations) and use it as ${provider.secretHint}` });
      if (!provider.verify(secret, req)) {
        logger.warn(`${provider.label} webhook with a wrong secret`, { integration: integration.id });
        return void res.status(401).json({ error: `Invalid signature or token (${provider.secretHint} must be the integration's webhook secret)` });
      }
      const event = provider.event(req);
      if (event === 'ping') return void res.json({ ok: true, message: `Connected to ${integration.name}` });
      if (!integration.enabled) return void res.status(202).json({ ignored: 'The integration is disabled' });
      const delivery = provider.delivery(req);
      if (delivery && alreadySeen(`${provider.type}:${delivery}`)) return void res.status(202).json({ ignored: 'Delivery already handled' });

      const ev = provider.parse(event, req.body);
      if (!ev) return void res.status(202).json({ ignored: `Nothing to test for ${event || 'this event'}${req.body?.action || req.body?.object_attributes?.action ? ` (${req.body.action ?? req.body.object_attributes.action})` : ''}` });
      const expected = provider.repository(integration.config).toLowerCase();
      if (ev.repository.toLowerCase() !== expected && ev.repositoryId !== expected) {
        return void res.status(202).json({ ignored: `The event is for ${ev.repository}, the integration for ${provider.repository(integration.config)}` });
      }
      const wanted = matchTriggers(integration.config.triggers ?? [], ev);
      if (!wanted.length) return void res.status(202).json({ ignored: `No trigger matches this ${ev.event}${ev.branch ? ` on ${ev.baseBranch ?? ev.branch}` : ''}${ev.environment ? ` to ${ev.environment}` : ''}` });

      const runs: any[] = [];
      for (const w of wanted) {
        try {
          const run = await OrchestratorService.get().startRun({
            agentId: w.agentId, projectId: integration.projectId, baseUrl: w.baseUrl, testIds: w.testIds,
            metadata: { triggeredBy: 'webhook', git: { provider: integration.type, integrationId: integration.id, delivery, ...ev } },
          });
          runs.push({ agentId: w.agentId, runId: run.id, tests: run.totalTests });
        } catch (e: any) {
          runs.push({ agentId: w.agentId, error: e.message });
        }
      }
      logger.info(`${provider.label} webhook started runs`, { integration: integration.id, event: ev.event, sha: ev.sha, runs });
      res.status(202).json({ event: ev.event, sha: ev.sha, runs });
    } catch (error: any) {
      logger.error(`${provider.label} webhook failed`, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  });
}
