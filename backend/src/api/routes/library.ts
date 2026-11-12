/**
 * Project library (project-scoped): reusable step blocks and named elements.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { BlockRepository, ElementRepository, LibraryError, validateBlock, validateElement } from '../../modules/library/library.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (res.headersSent) return;
    res.status(error instanceof LibraryError ? error.status : 500).json({ error: error.message });
  });
};

export function registerLibraryRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler }): void {
  const { viewer, editor } = roles;
  const blocks = new BlockRepository();
  const elements = new ElementRepository();

  // ── blocks ────────────────────────────────────────────────────────────────
  router.get('/blocks', viewer, wrap(async (req, res) => {
    res.json(await blocks.list(req.project!.id));
  }));

  router.get('/blocks/:id', viewer, wrap(async (req, res) => {
    const b = await blocks.get(req.params.id, req.project!.id);
    if (!b) return void res.status(404).json({ error: 'Block not found' });
    res.json({ ...b, usage: await blocks.usage(req.project!.id, b.name) });
  }));

  router.post('/blocks', editor, audit('block.create', 'block'), wrap(async (req, res) => {
    const errors = validateBlock(req.body ?? {});
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const { name, description, params, steps } = req.body;
    const created = await blocks.create(req.project!.id, { name, description, params, steps }, req.user?.email);
    res.locals.audit = { entityId: created.id, details: { name: created.name } };
    res.status(201).json(created);
  }));

  router.put('/blocks/:id', editor, audit('block.update', 'block'), wrap(async (req, res) => {
    const current = await blocks.get(req.params.id, req.project!.id);
    if (!current) return void res.status(404).json({ error: 'Block not found' });
    const errors = validateBlock({ params: current.params, ...req.body }, true);
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const updated = await blocks.update(current.id, req.project!.id, req.body ?? {}, req.user?.email);
    res.locals.audit = { entityId: current.id, details: { name: updated!.name } };
    res.json(updated);
  }));

  router.delete('/blocks/:id', editor, audit('block.delete', 'block'), wrap(async (req, res) => {
    const current = await blocks.get(req.params.id, req.project!.id);
    if (!current) return void res.status(404).json({ error: 'Block not found' });
    const usage = await blocks.usage(req.project!.id, current.name);
    if ((usage.tests.length || usage.blocks.length) && req.query.force !== 'true') {
      return void res.status(409).json({ error: `"${current.name}" is used by ${usage.tests.length} test(s) and ${usage.blocks.length} block(s)`, usage });
    }
    await blocks.delete(current.id, req.project!.id);
    res.status(204).send();
  }));

  // ── elements ──────────────────────────────────────────────────────────────
  router.get('/elements', viewer, wrap(async (req, res) => {
    res.json(await elements.list(req.project!.id));
  }));

  router.get('/elements/:id', viewer, wrap(async (req, res) => {
    const e = await elements.get(req.params.id, req.project!.id);
    if (!e) return void res.status(404).json({ error: 'Element not found' });
    res.json({ ...e, usage: await elements.usage(req.project!.id, e.name) });
  }));

  router.post('/elements', editor, audit('element.create', 'element'), wrap(async (req, res) => {
    const errors = validateElement(req.body ?? {});
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const { name, locator, alternatives, description, pageUrl } = req.body;
    const created = await elements.create(req.project!.id, { name, locator, alternatives, description, pageUrl }, req.user?.email);
    res.locals.audit = { entityId: created.id, details: { name: created.name } };
    res.status(201).json(created);
  }));

  router.put('/elements/:id', editor, audit('element.update', 'element'), wrap(async (req, res) => {
    const errors = validateElement(req.body ?? {}, true);
    if (errors.length) return void res.status(400).json({ error: errors.join('; ') });
    const updated = await elements.update(req.params.id, req.project!.id, req.body ?? {});
    if (!updated) return void res.status(404).json({ error: 'Element not found' });
    res.locals.audit = { entityId: updated.id, details: { name: updated.name } };
    res.json(updated);
  }));

  router.delete('/elements/:id', editor, audit('element.delete', 'element'), wrap(async (req, res) => {
    const current = await elements.get(req.params.id, req.project!.id);
    if (!current) return void res.status(404).json({ error: 'Element not found' });
    const usage = await elements.usage(req.project!.id, current.name);
    if ((usage.tests.length || usage.blocks.length) && req.query.force !== 'true') {
      return void res.status(409).json({ error: `{{el.${current.name}}} is used by ${usage.tests.length} test(s) and ${usage.blocks.length} block(s)`, usage });
    }
    await elements.delete(current.id, req.project!.id);
    res.status(204).send();
  }));
}
