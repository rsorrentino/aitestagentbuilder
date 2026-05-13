/**
 * API Routes
 */

import { Router } from 'express';
import multer from 'multer';
import { IngestionController } from '../controllers/ingestion.controller.js';
import { AgentsController } from '../controllers/agents.controller.js';
import { TestCasesController } from '../controllers/testcases.controller.js';
import { RunsController } from '../controllers/runs.controller.js';
import { ReportsController } from '../controllers/reports.controller.js';
import { authenticate, optionalAuth, authorize } from '../../infra/auth/auth.middleware.js';
import { rateLimiters } from '../../infra/rate-limit/rate-limiter.js';

const router = Router();

// Apply authentication middleware (can be disabled via env var)
const requireAuth = process.env.AUTH_ENABLED !== 'false' ? authenticate : optionalAuth;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// Controllers
const ingestionController = new IngestionController();
const agentsController = new AgentsController();
const testCasesController = new TestCasesController();
const runsController = new RunsController();
const reportsController = new ReportsController();

// Ingestion routes (strict rate limiting for uploads)
router.post('/ingestion/upload', 
  requireAuth,
  authorize('admin', 'user'),
  rateLimiters.upload,
  upload.single('file'), 
  (req, res) => {
    ingestionController.uploadDocument(req, res);
  }
);
router.post('/ingestion/documents/:documentId/extract', 
  requireAuth,
  authorize('admin', 'user'),
  (req, res) => {
    ingestionController.extractTestCases(req, res);
  }
);

// Agents routes
router.post('/agents', requireAuth, authorize('admin', 'user'), (req, res) => agentsController.createAgent(req, res));
router.get('/agents', requireAuth, (req, res) => agentsController.listAgents(req, res));
router.get('/agents/:id', requireAuth, (req, res) => agentsController.getAgent(req, res));
router.put('/agents/:id', requireAuth, authorize('admin', 'user'), (req, res) => agentsController.updateAgent(req, res));
router.delete('/agents/:id', requireAuth, authorize('admin'), (req, res) => agentsController.deleteAgent(req, res));

// Test Cases routes
router.post('/testcases', requireAuth, authorize('admin', 'user'), (req, res) => testCasesController.createTestCase(req, res));
router.get('/testcases', requireAuth, (req, res) => testCasesController.listTestCases(req, res));
router.get('/testcases/:id', requireAuth, (req, res) => testCasesController.getTestCase(req, res));
router.put('/testcases/:id', requireAuth, authorize('admin', 'user'), (req, res) => testCasesController.updateTestCase(req, res));
router.delete('/testcases/:id', requireAuth, authorize('admin'), (req, res) => testCasesController.deleteTestCase(req, res));

// Runs routes
router.post('/runs', requireAuth, authorize('admin', 'user'), (req, res) => runsController.startRun(req, res));
router.get('/runs', requireAuth, (req, res) => runsController.listRuns(req, res));
router.get('/runs/:id', requireAuth, (req, res) => runsController.getRun(req, res));
router.post('/runs/:id/cancel', requireAuth, authorize('admin', 'user'), (req, res) => runsController.cancelRun(req, res));

// Reports routes
router.post('/reports/runs/:runId/generate', requireAuth, authorize('admin', 'user'), (req, res) => reportsController.generateReport(req, res));

// Test Data routes
import { TestDataController } from '../controllers/test-data.controller.js';
import { AuthController } from '../controllers/auth.controller.js';

const testDataController = new TestDataController();
const authController = new AuthController();
router.post('/testdata', requireAuth, authorize('admin', 'user'), (req, res) => testDataController.createTestData(req, res));
router.get('/testdata', requireAuth, (req, res) => testDataController.listTestData(req, res));
router.get('/testdata/:id', requireAuth, (req, res) => testDataController.getTestData(req, res));
router.put('/testdata/:id', requireAuth, authorize('admin', 'user'), (req, res) => testDataController.updateTestData(req, res));
router.delete('/testdata/:id', requireAuth, authorize('admin'), (req, res) => testDataController.deleteTestData(req, res));

// Auth routes (no auth required for login/refresh)
router.post('/auth/login', (req, res) => authController.login(req, res));
router.post('/auth/refresh', (req, res) => authController.refresh(req, res));
router.post('/auth/api-keys', requireAuth, (req, res) => authController.createApiKey(req, res));
router.get('/auth/api-keys', requireAuth, (req, res) => authController.listApiKeys(req, res));
router.delete('/auth/api-keys/:id', requireAuth, (req, res) => authController.revokeApiKey(req, res));

export default router;
