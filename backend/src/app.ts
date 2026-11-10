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
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(metricsMiddleware);

  app.get('/', (_req, res) => {
    res.json({ name: 'AI Test Agent Builder API', api: API_PREFIX, health: '/health/ready' });
  });

  // Health and metrics (no auth)
  app.use('/health', healthRoutes);

  // Built-in demo application under test (disable with DEMO_ENABLED=false)
  if (process.env.DEMO_ENABLED !== 'false') {
    app.use('/demo', demoRouter());
  }

  // Run screenshots
  mkdirSync(ARTIFACTS_PATH, { recursive: true });
  app.use('/artifacts', express.static(ARTIFACTS_PATH, { fallthrough: false, maxAge: '1h' }));

  app.use(API_PREFIX, rateLimiters.default);
  app.use(API_PREFIX, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
