/**
 * API Routes (mounted under /api/v1)
 *
 * Access model:
 *   - requireAuth identifies the caller (local admin when AUTH_ENABLED is off)
 *   - project-scoped routes resolve the project from X-Project-Id (or ?projectId=)
 *     and require a minimum project role: viewer < editor < admin < owner
 *   - /admin/* requires a system administrator
 *   - mutating routes are recorded in the audit log
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { IngestionController } from '../controllers/ingestion.controller.js';
import { AgentsController } from '../controllers/agents.controller.js';
import { TestCasesController } from '../controllers/testcases.controller.js';
import { RunsController } from '../controllers/runs.controller.js';
import { ReportsController } from '../controllers/reports.controller.js';
import { ChatController } from '../controllers/chat.controller.js';
import { LlmProvidersController } from '../controllers/llm-providers.controller.js';
import { TestDataController } from '../controllers/test-data.controller.js';
import { AuthController } from '../controllers/auth.controller.js';
import { UsersController } from '../controllers/users.controller.js';
import { ProjectsController } from '../controllers/projects.controller.js';
import { AuditController } from '../controllers/audit.controller.js';
import {
  AuthenticatedRequest, projectContext, requireAuth, requireProjectRole, requireSystemAdmin,
} from '../../infra/auth/auth.middleware.js';
import { audit } from '../../infra/audit/audit.js';
import { rateLimiters } from '../../infra/rate-limit/rate-limiter.js';
import { seedDemo } from '../../demo/seed-demo.js';
import { registerAutomationRoutes } from './automation.js';
import { registerQualityRoutes } from './quality.js';
import { registerRecorderRoutes } from './recorder.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/** Turns multer errors (e.g. file too large) into 400 responses. */
const uploadSingle = (req: Request, res: Response, next: NextFunction) =>
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 50 MB' : err.message });
      return;
    }
    next();
  });

/** Use :projectId from the path as the project for projectContext. */
const projectFromParam = (req: Request, _res: Response, next: NextFunction) => {
  req.headers['x-project-id'] = req.params.projectId;
  next();
};

const ingestion = new IngestionController();
const agents = new AgentsController();
const testCases = new TestCasesController();
const runs = new RunsController();
const reports = new ReportsController();
const chat = new ChatController();
const llmProviders = new LlmProvidersController();
const testData = new TestDataController();
const auth = new AuthController();
const users = new UsersController();
const projects = new ProjectsController();
const auditLog = new AuditController();

const viewer = requireProjectRole('viewer');
const editor = requireProjectRole('editor');
const projectAdmin = requireProjectRole('admin');
const owner = requireProjectRole('owner');

// ── Public ───────────────────────────────────────────────────────────────────
router.get('/auth/config', (req, res) => auth.config(req, res));
router.post('/auth/login', rateLimiters.strict, (req, res) => auth.login(req, res));
router.post('/auth/refresh', (req, res) => auth.refresh(req, res));

// ── Everything below requires an identity ────────────────────────────────────
router.use(requireAuth);

router.get('/auth/me', (req, res) => auth.me(req, res));
router.post('/auth/change-password', rateLimiters.strict, audit('auth.password.change', 'user'), (req, res) => auth.changePassword(req, res));
router.post('/auth/api-keys', audit('apikey.create', 'api_key'), (req, res) => auth.createApiKey(req, res));
router.get('/auth/api-keys', (req, res) => auth.listApiKeys(req, res));
router.delete('/auth/api-keys/:id', audit('apikey.revoke', 'api_key'), (req, res) => auth.revokeApiKey(req, res));

// Administration (system administrators)
router.get('/admin/users', requireSystemAdmin, (req, res) => users.list(req, res));
router.post('/admin/users', requireSystemAdmin, audit('user.create', 'user'), (req, res) => users.create(req, res));
router.patch('/admin/users/:userId', requireSystemAdmin, audit('user.update', 'user'), (req, res) => { req.params.id = req.params.userId; return users.update(req, res); });
router.post('/admin/users/:userId/reset-password', requireSystemAdmin, audit('user.password.reset', 'user'), (req, res) => { req.params.id = req.params.userId; return users.resetPassword(req, res); });
router.post('/admin/users/:userId/unlock', requireSystemAdmin, audit('user.unlock', 'user'), (req, res) => { req.params.id = req.params.userId; return users.unlock(req, res); });
router.get('/admin/audit', requireSystemAdmin, (req, res) => auditLog.global(req, res));

// Projects
router.get('/projects', (req, res) => projects.list(req, res));
router.post('/projects', audit('project.create', 'project'), (req, res) => projects.create(req, res));
router.get('/projects/:projectId', projectFromParam, projectContext, viewer, (req, res) => projects.get(req, res));
router.patch('/projects/:projectId', projectFromParam, projectContext, projectAdmin, audit('project.update', 'project'), (req, res) => projects.update(req, res));
router.delete('/projects/:projectId', projectFromParam, projectContext, owner, audit('project.delete', 'project'), (req, res) => projects.remove(req, res));
router.get('/projects/:projectId/members', projectFromParam, projectContext, viewer, (req, res) => projects.listMembers(req, res));
router.put('/projects/:projectId/members', projectFromParam, projectContext, projectAdmin, audit('project.member.set', 'user'), (req, res) => projects.setMember(req, res));
router.delete('/projects/:projectId/members/:userId', projectFromParam, projectContext, projectAdmin, audit('project.member.remove', 'user'), (req, res) => projects.removeMember(req, res));

// AI (not project data)
router.post('/chat', (req, res) => chat.chat(req, res));
router.get('/llm/providers', (req, res) => llmProviders.listProviders(req, res));

// ── Project-scoped routes (X-Project-Id header, default "default") ───────────
const scoped = Router();
scoped.use(projectContext);

// Documents / ingestion
scoped.get('/ingestion/documents', viewer, (req, res) => ingestion.listDocuments(req, res));
scoped.post('/ingestion/upload', editor, rateLimiters.upload, uploadSingle, audit('document.upload', 'document'), (req, res) => ingestion.uploadDocument(req, res));
scoped.get('/ingestion/documents/:documentId/preview', viewer, (req, res) => ingestion.previewDocument(req, res));
scoped.post('/ingestion/documents/:documentId/extract', editor, audit('document.extract', 'document'), (req, res) => ingestion.extractTestCases(req, res));
scoped.delete('/ingestion/documents/:documentId', editor, audit('document.delete', 'document'), (req, res) => ingestion.deleteDocument(req, res));

// Agents
scoped.post('/agents', editor, audit('agent.create', 'agent'), (req, res) => agents.createAgent(req, res));
scoped.get('/agents', viewer, (req, res) => agents.listAgents(req, res));
scoped.get('/agents/:id', viewer, (req, res) => agents.getAgent(req, res));
scoped.put('/agents/:id', editor, async (req: AuthenticatedRequest, res, next) => {
  // Changing secrets or credentials requires a project admin
  const cfg = req.body?.config;
  if (cfg && (cfg.secrets !== undefined || cfg.salesforce !== undefined)) return projectAdmin(req, res, next);
  // So does moving the target URL of an agent with Salesforce credentials: logins and
  // session ids may be sent there when the org URLs are not set explicitly.
  const baseUrl = cfg?.base_url ?? cfg?.baseUrl;
  if (baseUrl !== undefined) {
    try {
      const existing = await new AgentRepository().findById(req.params.id, req.project!.id);
      if (existing?.config?.salesforce && String(baseUrl).trim() !== existing.config.base_url) return projectAdmin(req, res, next);
    } catch (error) {
      return next(error);
    }
  }
  next();
}, audit('agent.update', 'agent'), (req, res) => agents.updateAgent(req, res));
scoped.delete('/agents/:id', projectAdmin, audit('agent.delete', 'agent'), (req, res) => agents.deleteAgent(req, res));
scoped.post('/agents/:id/salesforce/personas/:name/verify', editor, audit('salesforce.persona.verify', 'agent'), (req, res) => agents.verifyPersona(req, res));
scoped.get('/agents/:id/plan', viewer, (req, res) => agents.getPlan(req, res));
scoped.post('/agents/:id/generate-tests', editor, audit('agent.generate_tests', 'agent'), (req, res) => agents.generateTests(req, res));

// Test cases
scoped.post('/testcases', editor, audit('testcase.create', 'test_case'), (req, res) => testCases.createTestCase(req, res));
scoped.get('/testcases', viewer, (req, res) => testCases.listTestCases(req, res));
scoped.get('/testcases/modules', viewer, (req, res) => testCases.listModules(req, res));
scoped.get('/testcases/:id', viewer, (req, res) => testCases.getTestCase(req, res));
scoped.put('/testcases/:id', editor, audit('testcase.update', 'test_case'), (req, res) => testCases.updateTestCase(req, res));
scoped.delete('/testcases/:id', editor, audit('testcase.delete', 'test_case'), (req, res) => testCases.deleteTestCase(req, res));

// Runs & reports
scoped.post('/runs', editor, audit('run.start', 'run'), (req, res) => runs.startRun(req, res));
scoped.get('/runs', viewer, (req, res) => runs.listRuns(req, res));
scoped.get('/runs/stats', viewer, (req, res) => runs.stats(req, res));
scoped.get('/runs/:id', viewer, (req, res) => runs.getRun(req, res));
scoped.post('/runs/:id/cancel', editor, audit('run.cancel', 'run'), (req, res) => runs.cancelRun(req, res));
scoped.get('/runs/:runId/report', viewer, (req, res) => reports.downloadReport(req, res));
scoped.post('/reports/runs/:runId/generate', editor, (req, res) => reports.generateReport(req, res));

// Test data
scoped.post('/testdata', editor, audit('testdata.create', 'test_data'), (req, res) => testData.createTestData(req, res));
scoped.post('/testdata/generate', editor, audit('testdata.generate', 'test_data'), (req, res) => testData.generateTestData(req, res));
scoped.get('/testdata/fake-kinds', viewer, (req, res) => testData.fakeKinds(req, res));
scoped.get('/testdata', viewer, (req, res) => testData.listTestData(req, res));
scoped.get('/testdata/:id', viewer, (req, res) => testData.getTestData(req, res));
scoped.put('/testdata/:id', editor, audit('testdata.update', 'test_data'), (req, res) => testData.updateTestData(req, res));
scoped.delete('/testdata/:id', projectAdmin, audit('testdata.delete', 'test_data'), (req, res) => testData.deleteTestData(req, res));

// Audit log of the current project
scoped.get('/audit', projectAdmin, (req, res) => auditLog.project(req, res));

// Demo: creates the "Demo Shop" agent + tests in the current project
scoped.post('/demo/seed', editor, audit('demo.seed', 'agent'), async (req: AuthenticatedRequest, res) => {
  if (process.env.DEMO_ENABLED === 'false') {
    res.status(404).json({ error: 'The demo is disabled (DEMO_ENABLED=false)' });
    return;
  }
  try {
    const result = await seedDemo(process.env.DEMO_BASE_URL || `${req.protocol}://${req.get('host')}/demo/`, req.project!.id);
    res.locals.audit = { entityId: result.agentId };
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Schedules, notifications, analytics (Phase 2/3)
registerAutomationRoutes(scoped, { viewer, editor, projectAdmin });
registerQualityRoutes(scoped, { viewer, editor });
registerRecorderRoutes(scoped, { editor });

router.use(scoped);

export default router;
