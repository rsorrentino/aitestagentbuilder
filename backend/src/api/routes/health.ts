/**
 * Health Check Routes
 */

import { Router, Request, Response } from 'express';
import { HealthCheckService } from '../../infra/monitoring/health-check.service.js';
import { getMetricsService } from '../../infra/monitoring/metrics.service.js';
import { BackupService } from '../../infra/backup/backup.service.js';

const router = Router();
const healthCheck = new HealthCheckService();
const backupService = new BackupService();

/**
 * Health check endpoint
 */
router.get('/health', async (_req: Request, res: Response) => {
  const health = await healthCheck.checkHealth();
  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Readiness probe (for Kubernetes)
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const ready = await healthCheck.getReadiness();
  res.status(ready ? 200 : 503).json({ ready });
});

/**
 * Liveness probe (for Kubernetes)
 */
router.get('/live', (_req: Request, res: Response) => {
  const alive = healthCheck.getLiveness();
  res.status(alive ? 200 : 503).json({ alive });
});

/**
 * Metrics endpoint (Prometheus format)
 */
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = getMetricsService();
    const metricsText = await metrics.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metricsText);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Backup management endpoints
 */
router.post('/backup', async (_req: Request, res: Response) => {
  try {
    const result = await backupService.createBackup();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/backups', async (_req: Request, res: Response) => {
  try {
    const backups = await backupService.listBackups();
    res.json(backups);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

