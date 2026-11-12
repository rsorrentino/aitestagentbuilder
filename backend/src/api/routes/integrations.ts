/**
 * Integrations (project-scoped): Jira, GitHub, GitLab, Azure DevOps connections,
 * test ↔ issue links (requirements), coverage, story import, filed defects.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { getLLMRouter } from '../../infra/llm/router.js';
import { ParserAgentService } from '../../modules/ingestion/services/parser-agent.service.js';
import { DefectRepository, IntegrationRepository, redactIntegration, TestLinkRepository } from '../../modules/integrations/repository.js';
import { trackerFor } from '../../modules/integrations/registry.js';
import { INTEGRATION_TYPES, IntegrationError, IntegrationType } from '../../modules/integrations/types.js';
import { validateIntegration } from '../../modules/integrations/validate.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (res.headersSent) return;
    res.status(error instanceof IntegrationError ? error.status : 500).json({ error: error.message });
  });
};

export function registerIntegrationRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler; projectAdmin: RequestHandler }): void {
  const { viewer, editor, projectAdmin } = roles;
  const repo = new IntegrationRepository();
  const links = new TestLinkRepository();
  const testCases = new TestCaseRepository();

  const load = async (req: AuthenticatedRequest, res: Response) => {
    const i = await repo.get(req.params.id, req.project!.id, true);
    if (!i) res.status(404).json({ error: 'Integration not found' });
    return i;
  };

  router.get('/integrations', viewer, wrap(async (req, res) => {
    res.json((await repo.list(req.project!.id)).map(redactIntegration));
  }));

  router.post('/integrations', projectAdmin, audit('integration.create', 'integration'), wrap(async (req, res) => {
    const { type, name, config } = req.body ?? {};
    if (!INTEGRATION_TYPES.includes(type)) return void res.status(400).json({ error: `type must be one of ${INTEGRATION_TYPES.join(', ')}` });
    const errors = validateIntegration(type as IntegrationType, config, false);
    if (!name || typeof name !== 'string') errors.unshift('name is required');
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const created = await repo.create({ projectId: req.project!.id, type, name: name.trim(), config, createdBy: req.user?.email });
    res.locals.audit = { entityId: created.id, details: { type, name } };
    res.status(201).json(redactIntegration(created));
  }));

  router.put('/integrations/:id', projectAdmin, audit('integration.update', 'integration'), wrap(async (req, res) => {
    const current = await repo.get(req.params.id, req.project!.id);
    if (!current) return void res.status(404).json({ error: 'Integration not found' });
    if (req.body?.config !== undefined) {
      const errors = validateIntegration(current.type, { ...current.config, ...req.body.config }, true);
      if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    }
    const updated = await repo.update(current.id, req.project!.id, {
      name: typeof req.body?.name === 'string' ? req.body.name.trim() : undefined,
      config: req.body?.config,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    });
    res.json(redactIntegration(updated!));
  }));

  router.delete('/integrations/:id', projectAdmin, audit('integration.delete', 'integration'), wrap(async (req, res) => {
    if (!(await repo.delete(req.params.id, req.project!.id))) return void res.status(404).json({ error: 'Integration not found' });
    res.status(204).send();
  }));

  router.post('/integrations/:id/check', editor, wrap(async (req, res) => {
    const i = await load(req, res);
    if (!i) return;
    try {
      const r = await trackerFor(i).check();
      await repo.setCheck(i.id, r);
      res.json(r);
    } catch (e: any) {
      await repo.setCheck(i.id, { ok: false, error: e.message });
      res.json({ ok: false, error: e.message });
    }
  }));

  router.get('/integrations/:id/issues', viewer, wrap(async (req, res) => {
    const i = await load(req, res);
    if (!i) return;
    const q = String(req.query.q ?? '').trim();
    if (!q) return void res.status(400).json({ error: 'q is required: issue keys (PROJ-1, PROJ-2), JQL, or words' });
    res.json(await trackerFor(i).search(q, Math.min(Number(req.query.limit) || 25, 100)));
  }));

  /**
   * Import stories / issues: the AI writes test cases from each one's title and description
   * (acceptance criteria included), linked to the issue so its results show there.
   */
  router.post('/integrations/:id/import', editor, audit('integration.import', 'integration'), wrap(async (req, res) => {
    const i = await load(req, res);
    if (!i) return;
    const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!keys.length && !query) return void res.status(400).json({ error: 'Give keys ["PROJ-1"] or a query' });
    if (!getLLMRouter().hasAnyProvider()) return void res.status(400).json({ error: 'Importing stories as tests needs an AI provider (Settings → AI Providers)' });
    const tracker = trackerFor(i);
    const issues = keys.length ? await Promise.all(keys.slice(0, 20).map((k) => tracker.get(k))) : await tracker.search(query, Math.min(Number(req.body?.limit) || 10, 20));
    const parser = new ParserAgentService();
    const out: any[] = [];
    for (const issue of issues) {
      try {
        const text = `${issue.type ?? 'Issue'} ${issue.key}: ${issue.title}\n\n${issue.description ?? ''}`;
        const extracted = await parser.extractTestCases(text, '', { module: typeof req.body?.module === 'string' ? req.body.module : undefined });
        const created = [];
        for (const tc of extracted.testCases) {
          const saved = await testCases.create({
            ...tc, documentId: undefined, projectId: req.project!.id,
            tags: [...new Set([...(tc.tags ?? []), `${i.type}:${issue.key}`, ...(req.body?.agentId ? [`agent:${req.body.agentId}`] : [])])],
            metadata: { ...(tc.metadata ?? {}), sourceDocument: `${i.type}:${issue.key}`, author: `ai (${extracted.metadata.provider})` },
          } as any);
          await links.add({ testCaseId: saved.id, integrationId: i.id, key: issue.key, url: issue.url, title: issue.title });
          created.push({ id: saved.id, title: saved.title });
        }
        out.push({ key: issue.key, title: issue.title, url: issue.url, created });
      } catch (e: any) {
        out.push({ key: issue.key, title: issue.title, url: issue.url, created: [], error: e.message });
      }
    }
    res.locals.audit = { entityId: i.id, details: { issues: out.map((o) => o.key), tests: out.reduce((n, o) => n + o.created.length, 0) } };
    res.json({ issues: out });
  }));

  // ── test ↔ issue links ──────────────────────────────────────────────────────
  router.get('/testcases/:id/links', viewer, wrap(async (req, res) => {
    if (!(await testCases.findById(req.params.id, req.project!.id))) return void res.status(404).json({ error: 'Test case not found' });
    res.json(await links.forTests([req.params.id]));
  }));

  router.post('/testcases/:id/links', editor, audit('testcase.link', 'testcase'), wrap(async (req, res) => {
    if (!(await testCases.findById(req.params.id, req.project!.id))) return void res.status(404).json({ error: 'Test case not found' });
    const i = await repo.get(String(req.body?.integrationId ?? ''), req.project!.id, true);
    if (!i) return void res.status(404).json({ error: 'Integration not found' });
    const key = String(req.body?.key ?? '').trim();
    if (!key) return void res.status(400).json({ error: 'key is required' });
    const issue = await trackerFor(i).get(key);
    await links.add({ testCaseId: req.params.id, integrationId: i.id, key: issue.key, url: issue.url, title: issue.title });
    res.status(201).json({ testCaseId: req.params.id, integrationId: i.id, key: issue.key, url: issue.url, title: issue.title });
  }));

  router.delete('/testcases/:id/links/:integrationId/:key', editor, audit('testcase.unlink', 'testcase'), wrap(async (req, res) => {
    if (!(await testCases.findById(req.params.id, req.project!.id))) return void res.status(404).json({ error: 'Test case not found' });
    if (!(await links.remove(req.params.id, req.params.integrationId, req.params.key))) return void res.status(404).json({ error: 'Link not found' });
    res.status(204).send();
  }));

  // Requirement coverage: linked issues, their tests and latest results
  router.get('/requirements/coverage', viewer, wrap(async (req, res) => {
    const items = (await links.coverage(req.project!.id)).map((r) => {
      const statuses = r.tests.map((t) => t.status);
      const state = statuses.some((s) => s && ['failed', 'error', 'timeout'].includes(s)) ? 'failing'
        : statuses.every((s) => s === 'passed') ? 'passing' : statuses.some((s) => s === 'passed') ? 'partial' : 'not_run';
      return { ...r, state };
    });
    const summary = { requirements: items.length, passing: 0, failing: 0, partial: 0, not_run: 0 } as Record<string, number>;
    for (const it of items) summary[it.state]++;
    res.json({ summary, requirements: items });
  }));

  router.get('/defects', viewer, wrap(async (req, res) => {
    const status = req.query.status === 'open' || req.query.status === 'resolved' ? String(req.query.status) : undefined;
    res.json(await new DefectRepository().list(req.project!.id, { status, agentId: req.query.agentId ? String(req.query.agentId) : undefined }));
  }));
}
