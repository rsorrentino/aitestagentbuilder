/**
 * App discovery (project-scoped): crawl an agent's application, keep the map, turn it into
 * library elements and proposed tests.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { cancelDiscovery, DISCOVERY_LIMITS, DiscoveryRepository, runDiscovery } from '../../modules/discovery/discovery.js';
import { ElementRepository } from '../../modules/library/library.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  });
};
const strings = (v: any) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);

export function registerDiscoveryRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler }): void {
  const { viewer, editor } = roles;
  const repo = new DiscoveryRepository();
  const agents = new AgentRepository();

  router.post('/agents/:id/discover', editor, audit('discovery.start', 'agent'), wrap(async (req, res) => {
    const agent = await agents.findById(req.params.id, req.project!.id);
    if (!agent) return void res.status(404).json({ error: 'Agent not found' });
    if (!agent.config?.base_url) return void res.status(400).json({ error: 'The agent has no base_url' });
    if (await repo.running(req.project!.id)) return void res.status(409).json({ error: 'A discovery is already running in this project' });
    const b = req.body ?? {};
    const options = {
      maxPages: Math.min(Math.max(Number(b.maxPages) || 25, 1), DISCOVERY_LIMITS.maxPages),
      maxDepth: Math.min(Math.max(Number(b.maxDepth ?? 3), 0), DISCOVERY_LIMITS.maxDepth),
      ...(typeof b.loginAs === 'string' && b.loginAs.trim() ? { loginAs: b.loginAs.trim() } : {}),
      startPaths: strings(b.startPaths).slice(0, 10),
      exclude: strings(b.exclude).slice(0, 50),
    };
    const d = await repo.create(req.project!.id, agent.id, options, req.user?.email);
    void runDiscovery(d, agent);
    res.locals.audit = { entityId: agent.id, details: { discovery: d.id, ...options } };
    res.status(202).json(d);
  }));

  router.get('/discoveries', viewer, wrap(async (req, res) => {
    res.json((await repo.list(req.project!.id, typeof req.query.agentId === 'string' ? req.query.agentId : undefined))
      .map(({ pages, proposals, ...d }) => ({ ...d, pageCount: pages.length, proposalCount: proposals.length })));
  }));

  router.get('/discoveries/:id', viewer, wrap(async (req, res) => {
    const d = await repo.get(req.params.id, req.project!.id);
    if (!d) return void res.status(404).json({ error: 'Discovery not found' });
    res.json(d);
  }));

  router.post('/discoveries/:id/cancel', editor, wrap(async (req, res) => {
    const d = await repo.get(req.params.id, req.project!.id);
    if (!d) return void res.status(404).json({ error: 'Discovery not found' });
    cancelDiscovery(d.id);
    res.json({ cancelling: d.status === 'running' });
  }));

  /** Save discovered elements in the library (by name; existing names are kept). */
  router.post('/discoveries/:id/elements', editor, audit('discovery.elements', 'element'), wrap(async (req, res) => {
    const d = await repo.get(req.params.id, req.project!.id);
    if (!d) return void res.status(404).json({ error: 'Discovery not found' });
    const wanted = new Set(strings(req.body?.names).map((n) => n.toLowerCase()));
    const elements = new ElementRepository();
    const existing = await elements.byName(req.project!.id);
    const created: string[] = [];
    const skipped: string[] = [];
    for (const page of d.pages) {
      for (const e of page.elements) {
        if (wanted.size && !wanted.has(e.name.toLowerCase())) continue;
        if (existing.has(e.name.toLowerCase())) { skipped.push(e.name); continue; }
        const saved = await elements.create(req.project!.id, { name: e.name, locator: e.locator, alternatives: e.alternatives, pageUrl: page.pattern, description: `${e.role} “${e.label}” on ${page.name}` }, req.user?.email);
        existing.set(e.name.toLowerCase(), saved);
        created.push(e.name);
      }
    }
    // Mark the source
    if (created.length) {
      const { default: getDatabaseClient } = await import('../../infra/db/client.js');
      await getDatabaseClient().query("UPDATE elements SET source = 'discovery' WHERE project_id = $1 AND name = ANY($2)", [req.project!.id, created]);
    }
    res.locals.audit = { entityId: d.id, details: { created: created.length } };
    res.json({ created, skipped });
  }));

  /** Create proposed tests (their elements are added to the library first). */
  router.post('/discoveries/:id/tests', editor, audit('discovery.tests', 'test_case'), wrap(async (req, res) => {
    const d = await repo.get(req.params.id, req.project!.id);
    if (!d) return void res.status(404).json({ error: 'Discovery not found' });
    const indexes: number[] = Array.isArray(req.body?.indexes) ? req.body.indexes.map(Number) : d.proposals.map((_p, i) => i);
    const chosen = indexes.map((i) => d.proposals[i]).filter(Boolean);
    if (!chosen.length) return void res.status(400).json({ error: 'No proposed tests chosen' });
    const elements = new ElementRepository();
    const existing = await elements.byName(req.project!.id);
    const byName = new Map(d.pages.flatMap((p) => p.elements.map((e) => [e.name.toLowerCase(), { e, p }] as const)));
    const addedElements: string[] = [];
    for (const name of new Set(chosen.flatMap((t) => t.elements))) {
      const hit = byName.get(name.toLowerCase());
      if (!hit || existing.has(name.toLowerCase())) continue;
      const saved = await elements.create(req.project!.id, { name: hit.e.name, locator: hit.e.locator, alternatives: hit.e.alternatives, pageUrl: hit.p.pattern, description: `${hit.e.role} “${hit.e.label}” on ${hit.p.name}` }, req.user?.email);
      existing.set(name.toLowerCase(), saved);
      addedElements.push(saved.name);
    }
    const tests = new TestCaseRepository();
    const created = [];
    for (const t of chosen) {
      const tc = await tests.create({
        title: t.title, module: t.module, priority: 'Medium', type: 'Smoke', projectId: req.project!.id,
        steps: t.steps.map((s, i) => ({ ...s, stepId: i + 1 })) as any, expectedResults: ['The screen opens and shows its main parts'],
        tags: ['discovered', `discovery:${t.source}`], ...(t.data ? { data: t.data } : {}),
        metadata: { author: t.source === 'ai' ? 'ai (discovery)' : 'discovery', sourceDocument: `discovery:${d.id}` },
      } as any);
      created.push({ id: tc.id, title: tc.title });
    }
    res.locals.audit = { entityId: d.id, details: { tests: created.length, elements: addedElements.length } };
    res.status(201).json({ tests: created, elements: addedElements });
  }));
}
