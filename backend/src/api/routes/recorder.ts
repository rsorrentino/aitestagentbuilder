/**
 * Test recorder routes (project-scoped, editors): remote recording sessions
 * and import of `npx playwright codegen` scripts.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { decryptAgentConfig, secretValues } from '../../core/domain/agent-secrets.js';
import { RecorderError, RecorderManager, RecordingSession, RecordedStep } from '../../modules/recorder/recorder.js';
import { importCodegen } from '../../modules/recorder/codegen-import.js';

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const wrap = (fn: Handler): RequestHandler => (req, res) => {
  fn(req as AuthenticatedRequest, res).catch((error: any) => {
    if (res.headersSent) return;
    if (error instanceof RecorderError) res.status(error.status).json({ error: error.message });
    else res.status(500).json({ error: error.message });
  });
};

export function registerRecorderRoutes(router: Router, roles: { editor: RequestHandler }): void {
  const { editor } = roles;
  const recorder = RecorderManager.get();
  const agents = new AgentRepository();
  const testCases = new TestCaseRepository();
  const userOf = (req: AuthenticatedRequest) => String(req.user?.userId ?? req.user?.email ?? 'local');
  const session = (req: AuthenticatedRequest) => recorder.find(req.params.id, req.project!.id, userOf(req));

  /** Save recorded or imported steps as a test case of the agent. */
  async function saveTestCase(req: AuthenticatedRequest, agentId: string | undefined, steps: RecordedStep[], source: string) {
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== 'string') throw new RecorderError('title is required');
    if (!steps.length) throw new RecorderError('There are no steps to save');
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'Medium';
    return testCases.create({
      title: b.title.trim().slice(0, 300),
      module: typeof b.module === 'string' && b.module.trim() ? b.module.trim() : 'Recorded',
      priority,
      steps,
      expectedResults: Array.isArray(b.expectedResults) ? b.expectedResults.map(String) : [],
      tags: [...new Set(['recorded', ...(agentId ? [`agent:${agentId}`] : []), ...(Array.isArray(b.tags) ? b.tags.map(String) : [])])],
      metadata: { author: req.user?.email ?? 'recorder', sourceDocument: source },
      projectId: req.project!.id,
    } as any);
  }

  router.post('/recordings', editor, audit('recording.start', 'agent'), wrap(async (req, res) => {
    const agent = await agents.findById(String(req.body?.agentId ?? ''), req.project!.id);
    if (!agent) return void res.status(404).json({ error: 'Agent not found' });
    const config = decryptAgentConfig(agent.config);
    const s = new RecordingSession(req.project!.id, userOf(req), { id: agent.id, name: agent.name, config }, config.secrets ?? {}, secretValues(config));
    await recorder.open(s, typeof req.body?.startPath === 'string' ? req.body.startPath : undefined,
      typeof req.body?.persona === 'string' && req.body.persona ? req.body.persona : undefined);
    res.locals.audit = { entityId: agent.id, details: { recording: s.id } };
    res.status(201).json(await s.state());
  }));

  router.get('/recordings', editor, wrap(async (req, res) => {
    res.json(await Promise.all(recorder.list(req.project!.id, userOf(req)).map((s) => s.state())));
  }));

  router.get('/recordings/:id', editor, wrap(async (req, res) => {
    res.json(await session(req).state());
  }));

  router.get('/recordings/:id/screenshot', editor, wrap(async (req, res) => {
    const png = await session(req).screenshot();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(png);
  }));

  router.post('/recordings/:id/inspect', editor, wrap(async (req, res) => {
    res.json(await session(req).inspect(Number(req.body?.x), Number(req.body?.y)));
  }));

  router.get('/recordings/:id/outline', editor, wrap(async (req, res) => {
    res.type('text/plain').send(await session(req).outline());
  }));

  router.post('/recordings/:id/steps', editor, wrap(async (req, res) => {
    const s = session(req);
    const { action, target, value, secret, record } = req.body ?? {};
    let data: Record<string, any> | undefined = req.body?.data && typeof req.body.data === 'object' ? req.body.data : undefined;
    if (secret !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(secret))) throw new RecorderError('secret must be the name of one of the agent\'s secrets');
      data = { ...(data ?? {}), value: `{{secrets.${secret}}}` };
    } else if (value !== undefined) data = { ...(data ?? {}), value: String(value) };
    const out = await s.record({ action: String(action ?? ''), ...(target ? { target: String(target) } : {}), ...(data ? { data } : {}) }, { record: record !== false });
    res.status(record === false ? 200 : 201).json({ ...out, state: await s.state() });
  }));

  router.post('/recordings/:id/scroll', editor, wrap(async (req, res) => {
    await session(req).scroll(Number(req.body?.dy));
    res.json({ ok: true });
  }));

  router.delete('/recordings/:id/steps/:index', editor, wrap(async (req, res) => {
    const s = session(req);
    const removed = s.removeStep(Number(req.params.index));
    res.json({ removed, state: await s.state() });
  }));

  router.post('/recordings/:id/save', editor, audit('recording.save', 'testcase'), wrap(async (req, res) => {
    const s = session(req);
    const tc = await saveTestCase(req, s.agent.id, s.steps, `recorder:${s.agent.id}`);
    res.locals.audit = { entityId: tc.id, details: { steps: s.steps.length, agentId: s.agent.id } };
    res.status(201).json(tc);
  }));

  router.delete('/recordings/:id', editor, wrap(async (req, res) => {
    session(req);
    await recorder.close(req.params.id);
    res.status(204).send();
  }));

  // `npx playwright codegen` script → steps (preview), or a saved test case with save: true
  router.post('/recordings/import', editor, audit('recording.import', 'testcase'), wrap(async (req, res) => {
    const script = typeof req.body?.script === 'string' ? req.body.script : '';
    if (!script.trim()) return void res.status(400).json({ error: 'script is required: paste what `npx playwright codegen` produced' });
    if (script.length > 500_000) return void res.status(413).json({ error: 'The script is too large' });
    const agent = req.body?.agentId ? await agents.findById(String(req.body.agentId), req.project!.id) : null;
    if (req.body?.agentId && !agent) return void res.status(404).json({ error: 'Agent not found' });
    const result = importCodegen(script, { baseUrl: agent?.config?.base_url });
    if (!req.body?.save) return void res.json(result);
    const tc = await saveTestCase(req, agent?.id, result.steps, 'playwright-codegen');
    res.locals.audit = { entityId: tc.id, details: { steps: result.steps.length, skipped: result.skipped.length } };
    res.status(201).json({ ...result, testCase: tc });
  }));
}
