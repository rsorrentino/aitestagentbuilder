/**
 * Health Check Service
 */

import getDatabaseClient from '../db/client.js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    database: HealthCheckResult;
    memory: HealthCheckResult;
    disk?: HealthCheckResult;
  };
  version: string;
  uptime: number;
}

export interface HealthCheckResult {
  status: 'ok' | 'warning' | 'error';
  message?: string;
  latency?: number;
}

export class HealthCheckService {
  private startTime: number = Date.now();

  /**
   * Perform health check
   */
  async checkHealth(): Promise<HealthStatus> {
    const checks = {
      database: await this.checkDatabase(),
      memory: this.checkMemory(),
    };

    const allHealthy = Object.values(checks).every(c => c.status === 'ok');
    const anyError = Object.values(checks).some(c => c.status === 'error');

    const status: HealthStatus['status'] = anyError 
      ? 'unhealthy' 
      : allHealthy 
      ? 'healthy' 
      : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      checks,
      version: process.env.npm_package_version || '1.0.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Check database connectivity
   */
  private async checkDatabase(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const db = getDatabaseClient();
      const healthy = await db.healthCheck();
      const latency = Date.now() - start;

      if (!healthy) {
        return {
          status: 'error',
          message: 'Database connection failed',
          latency,
        };
      }

      return {
        status: 'ok',
        latency,
      };
    } catch (error: any) {
      return {
        status: 'error',
        message: error.message,
        latency: Date.now() - start,
      };
    }
  }

  /**
   * Check memory usage
   */
  private checkMemory(): HealthCheckResult {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    const heapTotalMB = usage.heapTotal / 1024 / 1024;
    const heapUsagePercent = (heapUsedMB / heapTotalMB) * 100;

    // Warning if heap usage > 80%
    if (heapUsagePercent > 90) {
      return {
        status: 'error',
        message: `High memory usage: ${heapUsagePercent.toFixed(1)}%`,
      };
    }

    if (heapUsagePercent > 80) {
      return {
        status: 'warning',
        message: `Memory usage: ${heapUsagePercent.toFixed(1)}%`,
      };
    }

    return {
      status: 'ok',
      message: `Memory usage: ${heapUsagePercent.toFixed(1)}%`,
    };
  }

  /**
   * Get readiness status (for Kubernetes)
   */
  async getReadiness(): Promise<boolean> {
    const health = await this.checkHealth();
    return health.status !== 'unhealthy';
  }

  /**
   * Get liveness status (for Kubernetes)
   */
  getLiveness(): boolean {
    // Simple check - process is alive
    return true;
  }
}

