/**
 * Project-scoped quality routes: visual baselines (list, delete, approve a new
 * screenshot from a run) and applying AI-healed selectors to test cases.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { signArtifactPath } from '../../infra/security/signed-urls.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { approveActual, VisualBaselineRepository, VisualEntry } from '../../modules/quality/visual.js';
import { applyHealing, healedStepsOf } from '../../modules/quality/healing.js';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (!res.headersSent) res.status(500).json({ error: error.message });
  });
};

export function registerQualityRoutes(router: Router, roles: { viewer: RequestHandler; editor: RequestHandler }): void {
  const { viewer, editor } = roles;
  const baselines = new VisualBaselineRepository();
  const runs = new RunRepository();
  const testCases = new TestCaseRepository();

  /** The run (in this project) and one of its results. */
  async function loadResult(req: AuthenticatedRequest, res: Response) {
    const run = await runs.findRunById(req.params.runId, req.project!.id);
    const result = run?.results?.find((r) => r.id === req.params.resultId);
    if (!run || !result) {
      res.status(404).json({ error: 'Run result not found' });
      return null;
    }
    return { run, result };
  }

  // ── Visual baselines ──────────────────────────────────────────────────────
  router.get('/visual/baselines', viewer, wrap(async (req, res) => {
    const list = await baselines.list(req.project!.id, req.query.agentId ? String(req.query.agentId) : undefined);
    res.json(list.map((b) => ({ ...b, image: signArtifactPath(b.path) })));
  }));

  router.delete('/visual/baselines/:id', editor, audit('visual.baseline.delete', 'visual_baseline'), wrap(async (req, res) => {
    if (!(await baselines.delete(req.params.id, req.project!.id))) {
      res.status(404).json({ error: 'Baseline not found' });
      return;
    }
    res.locals.audit = { entityId: req.params.id };
    res.status(204).end();
  }));

  /** Accept the screenshot of a failed visual check as the new baseline. Body: { name, persona?, viewport? } */
  router.post('/runs/:runId/results/:resultId/visual/approve', editor, audit('visual.baseline.approve', 'visual_baseline'), wrap(async (req, res) => {
    const found = await loadResult(req, res);
    if (!found) return;
    const { run, result } = found;
    const entries: VisualEntry[] = Array.isArray(result.metadata?.visual) ? result.metadata!.visual : [];
    const name = String(req.body?.name ?? '');
    const entry = entries.find((e) => e.name === name
      && (req.body?.persona === undefined || e.persona === String(req.body.persona))
      && (req.body?.viewport === undefined || e.viewport === String(req.body.viewport)));
    if (!entry) {
      res.status(404).json({ error: `No visual check "${name}" in this result` });
      return;
    }
    if (entry.status !== 'failed' || !entry.actual) {
      res.status(400).json({ error: 'Only a screenshot that differed from its baseline can be approved' });
      return;
    }
    const baseline = await approveActual(entry, req.project!.id, run.agentId, run.id, req.user?.email ?? 'local');
    entry.approved = true;
    await runs.updateResult(result.id, { metadata: { ...result.metadata, visual: entries } });
    res.locals.audit = { entityId: baseline.id, details: { name: entry.name, persona: entry.persona, viewport: entry.viewport, runId: run.id } };
    res.json({ ...baseline, image: signArtifactPath(baseline.path) });
  }));

  // ── Self-healing ──────────────────────────────────────────────────────────
  /** Write the selectors the AI repaired in this result back into the test case. Body: { stepIds?: number[] } */
  router.post('/runs/:runId/results/:resultId/apply-healing', editor, audit('testcase.healing.apply', 'testcase'), wrap(async (req, res) => {
    const found = await loadResult(req, res);
    if (!found) return;
    const { result } = found;
    const healed = healedStepsOf(result.metadata);
    if (!healed.length) {
      res.status(400).json({ error: 'This result has no healed selectors' });
      return;
    }
    const testCase = await testCases.findById(result.testCaseId, req.project!.id);
    if (!testCase) {
      res.status(404).json({ error: 'The test case no longer exists' });
      return;
    }
    const only = Array.isArray(req.body?.stepIds) ? req.body.stepIds.map(Number) : undefined;
    const { steps, applied, skipped } = applyHealing(testCase.steps, healed, only);
    if (applied.length) await testCases.update(testCase.id, { steps }, req.project!.id);
    await runs.updateResult(result.id, { metadata: { ...result.metadata, healing: { steps: healed, applied: applied.length > 0 } } });
    res.locals.audit = { entityId: testCase.id, details: { applied, skipped, resultId: result.id } };
    res.json({ testCaseId: testCase.id, applied, skipped });
  }));
}
