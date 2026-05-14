/**
 * Metrics and Monitoring Service
 */
import { Counter, Histogram, Gauge, Registry } from 'prom-client';
export class MetricsService {
    register;
    // HTTP Metrics
    httpRequestCounter;
    httpRequestDuration;
    httpRequestSize;
    // Database Metrics
    dbQueryDuration;
    dbConnectionPool;
    // Test Execution Metrics
    testRunCounter;
    testResultCounter;
    activeTestRuns;
    // System Metrics
    memoryUsage;
    cpuUsage;
    constructor() {
        this.register = new Registry();
        // HTTP Metrics
        this.httpRequestCounter = new Counter({
            name: 'http_requests_total',
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'route', 'status'],
            registers: [this.register],
        });
        this.httpRequestDuration = new Histogram({
            name: 'http_request_duration_seconds',
            help: 'Duration of HTTP requests in seconds',
            labelNames: ['method', 'route'],
            buckets: [0.1, 0.5, 1, 2, 5, 10],
            registers: [this.register],
        });
        this.httpRequestSize = new Histogram({
            name: 'http_request_size_bytes',
            help: 'Size of HTTP requests in bytes',
            labelNames: ['method', 'route'],
            registers: [this.register],
        });
        // Database Metrics
        this.dbQueryDuration = new Histogram({
            name: 'db_query_duration_seconds',
            help: 'Duration of database queries in seconds',
            labelNames: ['operation', 'table'],
            buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
            registers: [this.register],
        });
        this.dbConnectionPool = new Gauge({
            name: 'db_connection_pool_size',
            help: 'Database connection pool size',
            labelNames: ['state'],
            registers: [this.register],
        });
        // Test Execution Metrics
        this.testRunCounter = new Counter({
            name: 'test_runs_total',
            help: 'Total number of test runs',
            labelNames: ['status', 'agent'],
            registers: [this.register],
        });
        this.testResultCounter = new Counter({
            name: 'test_results_total',
            help: 'Total number of test results',
            labelNames: ['status'],
            registers: [this.register],
        });
        this.activeTestRuns = new Gauge({
            name: 'active_test_runs',
            help: 'Number of currently active test runs',
            registers: [this.register],
        });
        // System Metrics
        this.memoryUsage = new Gauge({
            name: 'memory_usage_bytes',
            help: 'Memory usage in bytes',
            labelNames: ['type'],
            registers: [this.register],
        });
        this.cpuUsage = new Gauge({
            name: 'cpu_usage_percent',
            help: 'CPU usage percentage',
            registers: [this.register],
        });
        // Start system metrics collection
        this.startSystemMetricsCollection();
    }
    /**
     * Record HTTP request
     */
    recordHttpRequest(method, route, status, duration, size) {
        this.httpRequestCounter.inc({ method, route, status: status.toString() });
        this.httpRequestDuration.observe({ method, route }, duration / 1000);
        if (size) {
            this.httpRequestSize.observe({ method, route }, size);
        }
    }
    /**
     * Record database query
     */
    recordDbQuery(operation, table, duration) {
        this.dbQueryDuration.observe({ operation, table }, duration / 1000);
    }
    /**
     * Update connection pool metrics
     */
    updateConnectionPool(active, idle, total) {
        this.dbConnectionPool.set({ state: 'active' }, active);
        this.dbConnectionPool.set({ state: 'idle' }, idle);
        this.dbConnectionPool.set({ state: 'total' }, total);
    }
    /**
     * Record test run
     */
    recordTestRun(status, agentId) {
        this.testRunCounter.inc({ status, agent: agentId });
    }
    /**
     * Record test result
     */
    recordTestResult(status) {
        this.testResultCounter.inc({ status });
    }
    /**
     * Update active test runs
     */
    updateActiveTestRuns(count) {
        this.activeTestRuns.set(count);
    }
    /**
     * Get metrics in Prometheus format
     */
    async getMetrics() {
        return await this.register.metrics();
    }
    /**
     * Start system metrics collection
     */
    startSystemMetricsCollection() {
        setInterval(() => {
            const usage = process.memoryUsage();
            this.memoryUsage.set({ type: 'heapUsed' }, usage.heapUsed);
            this.memoryUsage.set({ type: 'heapTotal' }, usage.heapTotal);
            this.memoryUsage.set({ type: 'rss' }, usage.rss);
            this.memoryUsage.set({ type: 'external' }, usage.external);
            // CPU usage (simplified)
            const cpuUsage = process.cpuUsage();
            const totalCpu = cpuUsage.user + cpuUsage.system;
            this.cpuUsage.set(totalCpu / 1000000); // Convert to percentage approximation
        }, 5000); // Update every 5 seconds
    }
}
// Singleton instance
let metricsService = null;
export function getMetricsService() {
    if (!metricsService) {
        metricsService = new MetricsService();
    }
    return metricsService;
}
//# sourceMappingURL=metrics.service.js.map