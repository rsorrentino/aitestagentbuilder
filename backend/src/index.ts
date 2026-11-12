/**
 * Server entry point.
 */

import { DiscoveryRepository } from './modules/discovery/discovery.js';
import { createServer } from 'http';
import './infra/config/env.js';
import { createApp, API_PREFIX } from './app.js';
import logger from './infra/logger/index.js';
import getDatabaseClient from './infra/db/client.js';
import { runMigrations } from './infra/db/migrate.js';
import { initializeWebSocket } from './infra/websocket/server.js';
import { RecorderManager } from './modules/recorder/recorder.js';
import { SignInManager } from './modules/auth/interactive.js';
import { seedAdminUser } from './api/controllers/auth.controller.js';
import { RunRepository } from './core/repositories/run.repository.js';
import { OrchestratorService } from './modules/orchestration/services/orchestrator.service.js';
import { getLLMRouter } from './infra/llm/router.js';
import { CopilotClient } from './infra/llm/copilot.js';
import { isAuthEnabled } from './infra/config/env.js';
import { assertSecretsKey } from './infra/security/secrets.js';
import { hasPlaintextSecrets } from './core/domain/agent-secrets.js';
import { AgentRepository } from './core/repositories/agent.repository.js';
import { startBackgroundJobs, stopBackgroundJobs } from './modules/automation/background-jobs.js';

/** Encrypt secrets stored in plaintext by versions before encryption existed. */
async function encryptLegacySecrets(): Promise<number> {
  const repo = new AgentRepository();
  let count = 0;
  for (const agent of await repo.findAllUnscoped()) {
    const cfg: any = agent.config ?? {};
    if (hasPlaintextSecrets(cfg)) {
      await repo.update(agent.id, { config: cfg });
      count++;
    }
  }
  return count;
}

const PORT = parseInt(process.env.PORT || '3000');

async function start(): Promise<void> {
  assertSecretsKey();
  const db = getDatabaseClient();
  if (!(await db.healthCheck())) {
    logger.error(
      'Cannot connect to PostgreSQL. Check DATABASE_URL (or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD) and that the database is running. ' +
      'Quick start: docker compose up -d postgres',
    );
    process.exit(1);
  }

  const { vector, current, applied } = await runMigrations(db);
  logger.info(`Database ready at schema v${current}${applied.length ? ` (applied ${applied.join(', ')})` : ''}${vector ? ', pgvector enabled' : ''}`);

  await seedAdminUser();
  const encrypted = await encryptLegacySecrets();
  if (encrypted > 0) logger.info(`Encrypted plaintext secrets of ${encrypted} agent(s)`);
  const interrupted = await new RunRepository().failInterruptedRuns();
  await new DiscoveryRepository().failInterrupted().catch(() => undefined);
  if (interrupted.length > 0) logger.warn(`Marked ${interrupted.length} interrupted run(s) as failed`);

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
    // Unattended runs cut short by the restart are started again
    if (interrupted.length) {
      OrchestratorService.get().resumeInterruptedRuns(interrupted)
        .then((ids) => { if (ids.length) logger.warn(`Started ${ids.length} interrupted run(s) again`); })
        .catch((e) => logger.error('Resuming interrupted runs failed', { error: e.message }));
    }
    logger.info(`Auth ${isAuthEnabled() ? 'ENABLED' : 'disabled (local mode)'}`);
    const order = getLLMRouter().providerOrder('chat');
    if (order.length) logger.info(`AI providers: ${order.join(' → ')}`);
    else logger.warn('No AI provider configured — test runs work, but AI extraction/generation/chat are disabled. See .env.example.');
    startBackgroundJobs();
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopBackgroundJobs();
    await OrchestratorService.get().shutdown();
    await RecorderManager.get().shutdown();
    await SignInManager.get().shutdown();
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
