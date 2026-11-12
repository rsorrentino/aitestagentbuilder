/**
 * Mock APIs: management (project-scoped) and the mock endpoints themselves (no login,
 * unguessable address): ALL /api/v1/mocks/<slug>/<path>.
 */

import { Router, Request, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { answer, MockServiceRepository, MockState, readSpec, validateMockService } from '../../modules/mocks/mocks.js';
import { fetchSpec, listOperations } from '../../modules/quality/openapi-tests.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (!res.headersSent) res.status(error.status ?? 400).json({ error: error.message });
  });
};

const view = (s: any) => ({
  id: s.id, name: s.name, slug: s.slug, routes: s.routes, createdAt: s.createdAt, createdBy: s.createdBy,
  operations: s.spec ? listOperations(s.spec).map((o) => `${o.method} ${o.path}`) : [],
  hasSpec: !!s.spec, path: `/api/v1/mocks/${s.slug}`,
});

/** The mock endpoints (public). */
export function registerMockEndpoint(router: Router): void {
  const repo = new MockServiceRepository();
  const serve = async (req: Request, res: Response) => {
    const service = await repo.bySlug(req.params.slug).catch(() => null);
    if (!service) return void res.status(404).json({ error: 'Unknown mock service' });
    const path = `/${(req.params as any)[0] ?? ''}`.replace(/\/+$/, '') || '/';
    const a = answer(service, req.method, path);
    MockState.record(service.id, {
      at: new Date().toISOString(), method: req.method, path, query: req.query as Record<string, string>,
      ...(req.body && Object.keys(req.body).length ? { body: req.body } : {}), status: a.status, source: a.source,
    });
    if (a.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(a.delayMs, 10_000)));
    res.status(a.status).set({ 'X-Mock-Source': a.source, ...a.headers });
    if (a.body === undefined) return void res.end();
    if (typeof a.body === 'string' && !/json/i.test(String(a.headers['Content-Type'] ?? a.headers['content-type'] ?? ''))) return void res.type(a.headers['Content-Type'] ? String(a.headers['Content-Type']) : 'text/plain').send(a.body);
    res.json(a.body);
  };
  router.all('/mocks/:slug', serve);
  router.all('/mocks/:slug/*', serve);
}

export function registerMockRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler }): void {
  const { viewer, editor } = roles;
  const repo = new MockServiceRepository();

  const specFrom = async (body: any) => {
    if (body?.specUrl) return readSpec(await fetchSpec(String(body.specUrl)));
    if (body?.spec !== undefined && body.spec !== null && body.spec !== '') return readSpec(body.spec);
    return undefined;
  };

  router.get('/mock-services', viewer, wrap(async (req, res) => {
    res.json((await repo.list(req.project!.id)).map(view));
  }));

  router.get('/mock-services/:id', viewer, wrap(async (req, res) => {
    const s = await repo.get(req.params.id, req.project!.id);
    if (!s) return void res.status(404).json({ error: 'Mock service not found' });
    res.json(view(s));
  }));

  router.post('/mock-services', editor, audit('mock.create', 'mock_service'), wrap(async (req, res) => {
    const errors = validateMockService(req.body ?? {});
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const spec = await specFrom(req.body);
    if (!spec && !(req.body.routes ?? []).length) return void res.status(400).json({ error: 'Give an OpenAPI description (spec or specUrl) or at least one route' });
    const s = await repo.create(req.project!.id, { name: req.body.name, spec, routes: (req.body.routes ?? []).map((r: any) => ({ ...r, method: String(r.method).toUpperCase() })) }, req.user?.email);
    res.locals.audit = { entityId: s.id, details: { name: s.name } };
    res.status(201).json(view(s));
  }));

  router.put('/mock-services/:id', editor, audit('mock.update', 'mock_service'), wrap(async (req, res) => {
    const errors = validateMockService(req.body ?? {}, true);
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const spec = req.body?.spec === null ? null : await specFrom(req.body);
    const s = await repo.update(req.params.id, req.project!.id, {
      ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
      ...(spec !== undefined ? { spec } : {}),
      ...(req.body?.routes !== undefined ? { routes: req.body.routes.map((r: any) => ({ ...r, method: String(r.method).toUpperCase() })) } : {}),
    });
    if (!s) return void res.status(404).json({ error: 'Mock service not found' });
    res.json(view(s));
  }));

  router.delete('/mock-services/:id', editor, audit('mock.delete', 'mock_service'), wrap(async (req, res) => {
    if (!(await repo.delete(req.params.id, req.project!.id))) return void res.status(404).json({ error: 'Mock service not found' });
    res.status(204).send();
  }));

  router.get('/mock-services/:id/requests', viewer, wrap(async (req, res) => {
    const s = await repo.get(req.params.id, req.project!.id);
    if (!s) return void res.status(404).json({ error: 'Mock service not found' });
    res.json(MockState.calls(s.id).slice().reverse());
  }));
}
