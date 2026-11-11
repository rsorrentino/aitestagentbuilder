/**
 * Express application factory (no network listeners) — used by the server
 * entry point and by integration tests.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { mkdirSync } from 'fs';
import './infra/config/env.js';
import routes from './api/routes/index.js';
import healthRoutes from './api/routes/health.js';
import { errorHandler, notFoundHandler } from './api/middlewares/error-handler.js';
import { metricsMiddleware } from './api/middlewares/metrics.middleware.js';
import { rateLimiters } from './infra/rate-limit/rate-limiter.js';
import { ARTIFACTS_PATH } from './modules/execution/run-executor.js';
import { demoRouter } from './demo/pages.js';
import { salesforceSimulator } from './demo/salesforce-simulator.js';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApi } from './api/openapi.js';
import { verifyArtifactSignature } from './infra/security/signed-urls.js';

export const API_PREFIX = process.env.API_PREFIX || '/api/v1';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');

  app.use(helmet({
    contentSecurityPolicy: false, // API + HTML reports with inline styles
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // screenshots are shown by the UI on another port
  }));

  app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Project-Id'],
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(metricsMiddleware);

  app.get('/', (_req, res) => {
    res.json({ name: 'AI Test Agent Builder API', api: API_PREFIX, docs: '/api/docs', openapi: `${API_PREFIX}/openapi.json`, health: '/health/ready' });
  });

  // Health and metrics (no auth)
  app.use('/health', healthRoutes);

  // Built-in demo application under test (disable with DEMO_ENABLED=false)
  if (process.env.DEMO_ENABLED !== 'false') {
    // Salesforce look-alike for persona/permission tests (off in production unless SALESFORCE_SIMULATOR=true)
    if (process.env.NODE_ENV !== 'production' || process.env.SALESFORCE_SIMULATOR === 'true') {
      app.use('/demo/salesforce', salesforceSimulator());
    }
    app.use('/demo', demoRouter());
  }

  // Run screenshots
  mkdirSync(ARTIFACTS_PATH, { recursive: true });
  app.use('/artifacts', verifyArtifactSignature, express.static(ARTIFACTS_PATH, { fallthrough: false, maxAge: '1h' }));

  // OpenAPI spec + interactive docs (public)
  app.get(`${API_PREFIX}/openapi.json`, (req, res) => {
    res.json(buildOpenApi(`${req.protocol}://${req.get('host')}${API_PREFIX}`));
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(undefined, {
    customSiteTitle: 'AI Test Agent Builder API',
    swaggerOptions: { url: `${API_PREFIX}/openapi.json`, persistAuthorization: true },
  }));

  app.use(API_PREFIX, rateLimiters.default);
  app.use(API_PREFIX, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
