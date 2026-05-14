/**
 * Health Check Service
 */
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
export declare class HealthCheckService {
    private startTime;
    /**
     * Perform health check
     */
    checkHealth(): Promise<HealthStatus>;
    /**
     * Check database connectivity
     */
    private checkDatabase;
    /**
     * Check memory usage
     */
    private checkMemory;
    /**
     * Get readiness status (for Kubernetes)
     */
    getReadiness(): Promise<boolean>;
    /**
     * Get liveness status (for Kubernetes)
     */
    getLiveness(): boolean;
}
//# sourceMappingURL=health-check.service.d.ts.map