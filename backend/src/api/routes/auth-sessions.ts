/**
 * Sign-in & MFA routes (project-scoped): check a login profile's sign-in,
 * and see / forget the saved sessions of an agent's profiles and personas.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { decryptAgentConfig, secretValues } from '../../core/domain/agent-secrets.js';
import { maskSecrets } from '../../infra/security/secrets.js';
import { launchBrowser } from '../../modules/execution/browser.js';
import { AppSessions } from '../../modules/auth/app-login.js';
import { authSettings } from '../../modules/auth/profiles.js';
import { SessionVault } from '../../modules/auth/session-vault.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  });
};

export function registerAuthSessionRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler }): void {
  const { viewer, editor } = roles;
  const agents = new AgentRepository();
  const vault = new SessionVault();

  router.get('/agents/:id/auth/sessions', viewer, wrap(async (req, res) => {
    const agent = await agents.findById(req.params.id, req.project!.id);
    if (!agent) return void res.status(404).json({ error: 'Agent not found' });
    res.json(await vault.list(agent.id));
  }));

  router.delete('/agents/:id/auth/sessions', editor, audit('agent.auth_sessions.forget', 'agent'), wrap(async (req, res) => {
    const agent = await agents.findById(req.params.id, req.project!.id);
    if (!agent) return void res.status(404).json({ error: 'Agent not found' });
    const kind = req.query.kind === 'app' || req.query.kind === 'salesforce' ? req.query.kind : undefined;
    const identity = typeof req.query.identity === 'string' && req.query.identity ? req.query.identity : undefined;
    const forgotten = await vault.forget(agent.id, kind, identity);
    res.locals.audit = { entityId: agent.id, details: { kind, identity, forgotten } };
    res.json({ forgotten });
  }));

  // Sign in as a login profile now (fresh, or reusing the saved session): checks the setup and saves the session
  router.post('/agents/:id/auth/profiles/:name/verify', editor, audit('agent.auth_profile.verify', 'agent'), wrap(async (req, res) => {
    const agent = await agents.findById(req.params.id, req.project!.id);
    if (!agent) return void res.status(404).json({ error: 'Agent not found' });
    const config = decryptAgentConfig(agent.config);
    const settings = authSettings(config);
    if (!settings) return void res.status(400).json({ error: 'This agent has no login profiles' });
    const sessions = new AppSessions(settings, config.base_url, { agentId: agent.id, vault });
    let profile;
    try {
      profile = sessions.profile(req.params.name);
    } catch (e: any) {
      return void res.status(404).json({ error: e.message });
    }
    const mask = (t: string) => maskSecrets(t, secretValues(config));
    res.locals.audit = { entityId: agent.id, details: { profile: profile.name } };
    const started = Date.now();
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const r = await sessions.login(page, profile.name, { fresh: req.body?.fresh === true });
      const saved = (await vault.list(agent.id)).find((s) => s.kind === 'app' && s.identity === profile.name);
      res.json({
        ok: true, profile: profile.name, message: mask(r.message), reused: r.reused, usedMfa: r.usedMfa,
        landedUrl: page.url().split('?')[0], session: saved ?? null, durationMs: Date.now() - started,
      });
    } catch (e: any) {
      res.json({ ok: false, profile: profile.name, error: mask(String(e.message).split('\n')[0]), durationMs: Date.now() - started });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }));
}
