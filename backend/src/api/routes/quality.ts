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
import { triageRun } from '../../modules/quality/triage.js';
import { QuarantineRepository } from '../../modules/quality/quarantine.js';
import { aiApiTests, basePathOf, fetchSpec, listOperations, operationKey, parseSpec, smokeTest } from '../../modules/quality/openapi-tests.js';
import type { TestCaseCreateInput } from '../../core/domain/test-case.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { getLLMRouter } from '../../infra/llm/router.js';

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

  // ── API tests from OpenAPI ────────────────────────────────────────────────
  /**
   * Body: { specUrl? | spec? (JSON/YAML text or object), operations?: ["GET /orders"], ai?: boolean,
   *         count?: number, save?: boolean (default true) }
   */
  router.post('/agents/:id/generate-api-tests', editor, audit('agent.generate_api_tests', 'agent'), wrap(async (req, res) => {
    const agent = await new AgentRepository().findById(req.params.id, req.project!.id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const cfg: any = agent.config ?? {};
    const { specUrl, operations: only, ai = false, save = true } = req.body ?? {};
    let spec: any;
    try {
      if (req.body?.spec) spec = typeof req.body.spec === 'string' ? parseSpec(req.body.spec) : parseSpec(JSON.stringify(req.body.spec));
      else if (specUrl) spec = await fetchSpec(new URL(String(specUrl), String(cfg.api_base_url || cfg.base_url)).toString());
      else throw new Error('Give the OpenAPI description: specUrl (absolute, or relative to the agent URL) or spec');
    } catch (e: any) {
      res.status(400).json({ error: e.message });
      return;
    }
    let ops = listOperations(spec);
    if (Array.isArray(only) && only.length) ops = ops.filter((op) => only.map(String).includes(operationKey(op)));
    if (!ops.length) {
      res.status(400).json({ error: 'No operations to test in this description' });
      return;
    }

    const skipped: Array<{ operation: string; reason: string }> = [];
    let tests: TestCaseCreateInput[] = [];
    let provider: string | undefined;
    if (ai) {
      if (!getLLMRouter().hasAnyProvider()) {
        res.status(503).json({ error: 'No AI provider is configured: generate without AI (smoke tests) or configure one' });
        return;
      }
      const result = await aiApiTests(spec, ops, Math.min(Math.max(Number(req.body?.count) || ops.length * 2, 1), 50), cfg.ai?.provider);
      tests = result.tests;
      provider = result.provider;
    } else {
      for (const op of ops) {
        const { test, skipped: why } = smokeTest(op, basePathOf(spec));
        if (test) tests.push(test);
        else skipped.push({ operation: operationKey(op), reason: why! });
      }
    }

    // Tag for the agent and respect its priority filter so the tests actually run
    const priorities: string[] = cfg.test_selection?.priority ?? [];
    const toSave = tests.map((t) => ({
      ...t,
      ...(priorities.length && !priorities.includes(t.priority) ? { priority: priorities[0] as any } : {}),
      tags: [...new Set([...(t.tags ?? []), `agent:${agent.id}`])],
      projectId: req.project!.id,
    }));
    const saved = save ? await Promise.all(toSave.map((t) => testCases.create(t))) : toSave;
    const servers = (spec.servers ?? []).map((s: any) => s.url).filter(Boolean);
    res.locals.audit = { entityId: agent.id, details: { operations: ops.length, created: saved.length, ai, saved: !!save } };
    res.json({
      operations: ops.length,
      created: saved.length,
      saved: !!save,
      tests: saved,
      skipped,
      ...(provider ? { provider } : {}),
      servers,
      ...(!cfg.api_base_url && servers.some((u: string) => /^https?:\/\//.test(u)) ? { hint: `Set the agent's API base URL (api_base_url) to ${servers[0]} if the API is not under ${cfg.base_url}` } : {}),
    });
  }));

  // ── Flaky-test quarantine ──────────────────────────────────────────────────
  const quarantine = new QuarantineRepository();

  router.get('/quarantine', viewer, wrap(async (req, res) => {
    res.json(await quarantine.list(req.project!.id));
  }));

  /** Quarantine a test by hand. Body: { reason } */
  router.post('/testcases/:id/quarantine', editor, audit('testcase.quarantine', 'testcase'), wrap(async (req, res) => {
    const tc = await testCases.findById(req.params.id, req.project!.id);
    if (!tc) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }
    const reason = String(req.body?.reason ?? '').trim().slice(0, 500) || 'Quarantined by hand';
    const q = await quarantine.add({ testCaseId: tc.id, projectId: req.project!.id, reason, auto: false, by: req.user?.email ?? 'local' });
    res.locals.audit = { entityId: tc.id, details: { reason } };
    res.status(201).json({ ...q, title: tc.title });
  }));

  router.delete('/testcases/:id/quarantine', editor, audit('testcase.release', 'testcase'), wrap(async (req, res) => {
    if (!(await quarantine.remove(req.params.id, req.project!.id))) {
      res.status(404).json({ error: 'This test case is not quarantined' });
      return;
    }
    res.locals.audit = { entityId: req.params.id };
    res.status(204).end();
  }));

  // ── Failure triage ────────────────────────────────────────────────────────
  /** (Re)triage a run's failures. Body: { ai?: boolean } — ai asks the AI to explain each group. */
  router.post('/runs/:runId/triage', editor, audit('run.triage', 'run'), wrap(async (req, res) => {
    const run = await runs.findRunById(req.params.runId, req.project!.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const ai = req.body?.ai === true;
    if (ai && !getLLMRouter().hasAnyProvider()) {
      res.status(503).json({ error: 'No AI provider is configured; triage by rules is already on the run' });
      return;
    }
    const agent = await new AgentRepository().findById(run.agentId, req.project!.id).catch(() => null);
    const triage = await triageRun(run, { ai, preferred: (agent?.config as any)?.ai?.provider });
    await runs.updateRun(run.id, { metadata: { triage } });
    res.locals.audit = { entityId: run.id, details: { ai, groups: triage.groups.length } };
    res.json(triage);
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
