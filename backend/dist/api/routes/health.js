/**
 * Health Check Routes
 */
import { Router } from 'express';
import { HealthCheckService } from '../../infra/monitoring/health-check.service.js';
import { getMetricsService } from '../../infra/monitoring/metrics.service.js';
import { BackupService } from '../../infra/backup/backup.service.js';
const router = Router();
const healthCheck = new HealthCheckService();
const backupService = new BackupService();
/**
 * Health check endpoint
 */
router.get('/health', async (_req, res) => {
    const health = await healthCheck.checkHealth();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
});
/**
 * Readiness probe (for Kubernetes)
 */
router.get('/ready', async (_req, res) => {
    const ready = await healthCheck.getReadiness();
    res.status(ready ? 200 : 503).json({ ready });
});
/**
 * Liveness probe (for Kubernetes)
 */
router.get('/live', (_req, res) => {
    const alive = healthCheck.getLiveness();
    res.status(alive ? 200 : 503).json({ alive });
});
/**
 * Metrics endpoint (Prometheus format)
 */
router.get('/metrics', async (_req, res) => {
    try {
        const metrics = getMetricsService();
        const metricsText = await metrics.getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metricsText);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
/**
 * Backup management endpoints
 */
router.post('/backup', async (_req, res) => {
    try {
        const result = await backupService.createBackup();
        if (result.success) {
            res.json(result);
        }
        else {
            res.status(500).json(result);
        }
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/backups', async (_req, res) => {
    try {
        const backups = await backupService.listBackups();
        res.json(backups);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
export default router;
//# sourceMappingURL=health.js.map