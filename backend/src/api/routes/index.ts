/**
 * API Routes (mounted under /api/v1)
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
import { requireAuth, authorize } from '../../infra/auth/auth.middleware.js';
import { rateLimiters } from '../../infra/rate-limit/rate-limiter.js';
import { seedDemo } from '../../demo/seed-demo.js';

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

const ingestion = new IngestionController();
const agents = new AgentsController();
const testCases = new TestCasesController();
const runs = new RunsController();
const reports = new ReportsController();
const chat = new ChatController();
const llmProviders = new LlmProvidersController();
const testData = new TestDataController();
const auth = new AuthController();

const write = authorize('admin', 'user');
const admin = authorize('admin');

// Auth (public)
router.get('/auth/config', (req, res) => auth.config(req, res));
router.post('/auth/login', rateLimiters.strict, (req, res) => auth.login(req, res));
router.post('/auth/refresh', (req, res) => auth.refresh(req, res));

// Everything below requires authentication when AUTH_ENABLED=true
router.use(requireAuth);

router.get('/auth/me', (req, res) => auth.me(req, res));
router.post('/auth/api-keys', (req, res) => auth.createApiKey(req, res));
router.get('/auth/api-keys', (req, res) => auth.listApiKeys(req, res));
router.delete('/auth/api-keys/:id', (req, res) => auth.revokeApiKey(req, res));

// Documents / ingestion
router.get('/ingestion/documents', (req, res) => ingestion.listDocuments(req, res));
router.post('/ingestion/upload', write, rateLimiters.upload, uploadSingle, (req, res) => ingestion.uploadDocument(req, res));
router.get('/ingestion/documents/:documentId/preview', (req, res) => ingestion.previewDocument(req, res));
router.post('/ingestion/documents/:documentId/extract', write, (req, res) => ingestion.extractTestCases(req, res));
router.delete('/ingestion/documents/:documentId', write, (req, res) => ingestion.deleteDocument(req, res));

// Agents
router.post('/agents', write, (req, res) => agents.createAgent(req, res));
router.get('/agents', (req, res) => agents.listAgents(req, res));
router.get('/agents/:id', (req, res) => agents.getAgent(req, res));
router.put('/agents/:id', write, (req, res) => agents.updateAgent(req, res));
router.delete('/agents/:id', admin, (req, res) => agents.deleteAgent(req, res));
router.get('/agents/:id/plan', (req, res) => agents.getPlan(req, res));
router.post('/agents/:id/generate-tests', write, (req, res) => agents.generateTests(req, res));

// Test cases
router.post('/testcases', write, (req, res) => testCases.createTestCase(req, res));
router.get('/testcases', (req, res) => testCases.listTestCases(req, res));
router.get('/testcases/modules', (req, res) => testCases.listModules(req, res));
router.get('/testcases/:id', (req, res) => testCases.getTestCase(req, res));
router.put('/testcases/:id', write, (req, res) => testCases.updateTestCase(req, res));
router.delete('/testcases/:id', write, (req, res) => testCases.deleteTestCase(req, res));

// Runs
router.post('/runs', write, (req, res) => runs.startRun(req, res));
router.get('/runs', (req, res) => runs.listRuns(req, res));
router.get('/runs/stats', (req, res) => runs.stats(req, res));
router.get('/runs/:id', (req, res) => runs.getRun(req, res));
router.post('/runs/:id/cancel', write, (req, res) => runs.cancelRun(req, res));
router.get('/runs/:runId/report', (req, res) => reports.downloadReport(req, res));

// Reports (files on disk)
router.post('/reports/runs/:runId/generate', write, (req, res) => reports.generateReport(req, res));

// Test data
router.post('/testdata', write, (req, res) => testData.createTestData(req, res));
router.get('/testdata', (req, res) => testData.listTestData(req, res));
router.get('/testdata/:id', (req, res) => testData.getTestData(req, res));
router.put('/testdata/:id', write, (req, res) => testData.updateTestData(req, res));
router.delete('/testdata/:id', admin, (req, res) => testData.deleteTestData(req, res));

// Demo: creates the "Demo Shop" agent + tests against this server's /demo app
router.post('/demo/seed', write, async (req, res) => {
  if (process.env.DEMO_ENABLED === 'false') {
    res.status(404).json({ error: 'The demo is disabled (DEMO_ENABLED=false)' });
    return;
  }
  try {
    const result = await seedDemo(process.env.DEMO_BASE_URL || `${req.protocol}://${req.get('host')}/demo/`);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// AI
router.post('/chat', (req, res) => chat.chat(req, res));
router.get('/llm/providers', (req, res) => llmProviders.listProviders(req, res));

export default router;
