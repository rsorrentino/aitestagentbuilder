/**
 * Metrics and Monitoring Service
 */
export declare class MetricsService {
    private register;
    private httpRequestCounter;
    private httpRequestDuration;
    private httpRequestSize;
    private dbQueryDuration;
    private dbConnectionPool;
    private testRunCounter;
    private testResultCounter;
    private activeTestRuns;
    private memoryUsage;
    private cpuUsage;
    constructor();
    /**
     * Record HTTP request
     */
    recordHttpRequest(method: string, route: string, status: number, duration: number, size?: number): void;
    /**
     * Record database query
     */
    recordDbQuery(operation: string, table: string, duration: number): void;
    /**
     * Update connection pool metrics
     */
    updateConnectionPool(active: number, idle: number, total: number): void;
    /**
     * Record test run
     */
    recordTestRun(status: string, agentId: string): void;
    /**
     * Record test result
     */
    recordTestResult(status: string): void;
    /**
     * Update active test runs
     */
    updateActiveTestRuns(count: number): void;
    /**
     * Get metrics in Prometheus format
     */
    getMetrics(): Promise<string>;
    /**
     * Start system metrics collection
     */
    private startSystemMetricsCollection;
}
export declare function getMetricsService(): MetricsService;
//# sourceMappingURL=metrics.service.d.ts.map