/**
 * Metrics and Monitoring Service
 */

import { Counter, Histogram, Gauge, Registry } from 'prom-client';

export class MetricsService {
  private register: Registry;
  
  // HTTP Metrics
  private httpRequestCounter: Counter<string>;
  private httpRequestDuration: Histogram<string>;
  private httpRequestSize: Histogram<string>;
  
  // Database Metrics
  private dbQueryDuration: Histogram<string>;
  private dbConnectionPool: Gauge<string>;
  
  // Test Execution Metrics
  private testRunCounter: Counter<string>;
  private testResultCounter: Counter<string>;
  private activeTestRuns: Gauge<string>;
  
  // System Metrics
  private memoryUsage: Gauge<string>;
  private cpuUsage: Gauge<string>;

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
  recordHttpRequest(method: string, route: string, status: number, duration: number, size?: number): void {
    this.httpRequestCounter.inc({ method, route, status: status.toString() });
    this.httpRequestDuration.observe({ method, route }, duration / 1000);
    if (size) {
      this.httpRequestSize.observe({ method, route }, size);
    }
  }

  /**
   * Record database query
   */
  recordDbQuery(operation: string, table: string, duration: number): void {
    this.dbQueryDuration.observe({ operation, table }, duration / 1000);
  }

  /**
   * Update connection pool metrics
   */
  updateConnectionPool(active: number, idle: number, total: number): void {
    this.dbConnectionPool.set({ state: 'active' }, active);
    this.dbConnectionPool.set({ state: 'idle' }, idle);
    this.dbConnectionPool.set({ state: 'total' }, total);
  }

  /**
   * Record test run
   */
  recordTestRun(status: string, agentId: string): void {
    this.testRunCounter.inc({ status, agent: agentId });
  }

  /**
   * Record test result
   */
  recordTestResult(status: string): void {
    this.testResultCounter.inc({ status });
  }

  /**
   * Update active test runs
   */
  updateActiveTestRuns(count: number): void {
    this.activeTestRuns.set(count);
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return await this.register.metrics();
  }

  /**
   * Start system metrics collection
   */
  private startSystemMetricsCollection(): void {
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
let metricsService: MetricsService | null = null;

export function getMetricsService(): MetricsService {
  if (!metricsService) {
    metricsService = new MetricsService();
  }
  return metricsService;
}

