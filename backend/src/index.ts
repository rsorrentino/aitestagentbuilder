/**
 * Server entry point.
 */

import { createServer } from 'http';
import './infra/config/env.js';
import { createApp, API_PREFIX } from './app.js';
import logger from './infra/logger/index.js';
import getDatabaseClient from './infra/db/client.js';
import { runMigrations } from './infra/db/migrate.js';
import { initializeWebSocket } from './infra/websocket/server.js';
import { seedAdminUser } from './api/controllers/auth.controller.js';
import { RunRepository } from './core/repositories/run.repository.js';
import { OrchestratorService } from './modules/orchestration/services/orchestrator.service.js';
import { getLLMRouter } from './infra/llm/router.js';
import { CopilotClient } from './infra/llm/copilot.js';
import { isAuthEnabled } from './infra/config/env.js';

const PORT = parseInt(process.env.PORT || '3000');

async function start(): Promise<void> {
  const db = getDatabaseClient();
  if (!(await db.healthCheck())) {
    logger.error(
      'Cannot connect to PostgreSQL. Check DATABASE_URL (or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD) and that the database is running. ' +
      'Quick start: docker compose up -d postgres',
    );
    process.exit(1);
  }

  const { vector } = await runMigrations(db);
  logger.info(`Database ready${vector ? ' (pgvector enabled)' : ''}`);

  await seedAdminUser();
  const interrupted = await new RunRepository().failInterruptedRuns();
  if (interrupted > 0) logger.warn(`Marked ${interrupted} interrupted run(s) as failed`);

  const app = createApp();
  const server = createServer(app);
  initializeWebSocket(server);

  server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use. Set PORT in .env to a free port.`);
    } else {
      logger.error('Server error', { error: error.message });
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    logger.info(`API listening on http://localhost:${PORT}${API_PREFIX}`);
    logger.info(`Auth ${isAuthEnabled() ? 'ENABLED' : 'disabled (local mode)'}`);
    const order = getLLMRouter().providerOrder('chat');
    if (order.length) logger.info(`AI providers: ${order.join(' → ')}`);
    else logger.warn('No AI provider configured — test runs work, but AI extraction/generation/chat are disabled. See .env.example.');
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    await OrchestratorService.get().shutdown();
    await CopilotClient.shutdown();
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});
