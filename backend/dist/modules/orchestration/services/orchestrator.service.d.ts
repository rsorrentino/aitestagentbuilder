/**
 * Orchestrator Service
 * Supervises the entire test execution workflow with improved concurrency
 */
import { TestRun, TestRunCreateInput } from '../../../core/domain/run.js';
export declare class OrchestratorService {
    private agentRepo;
    private runRepo;
    private plannerAgent;
    private environmentAgent;
    private concurrencyManager;
    constructor(maxConcurrentRuns?: number);
    /**
     * Start a test run with concurrency control
     */
    startRun(input: TestRunCreateInput): Promise<TestRun>;
    /**
     * Calculate priority for concurrency management
     */
    private calculatePriority;
    /**
     * Execute a test run
     */
    private executeRun;
    /**
     * Get run status
     */
    getRunStatus(runId: string): Promise<TestRun | null>;
    /**
     * Cancel a running test
     */
    cancelRun(runId: string): Promise<void>;
    /**
     * Get concurrency statistics
     */
    getConcurrencyStats(): {
        running: number;
        queued: number;
        maxConcurrent: number;
    };
}
//# sourceMappingURL=orchestrator.service.d.ts.map