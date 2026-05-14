/**
 * Test Run Repository
 */
import { TestRun, TestRunCreateInput, TestRunUpdateInput, TestResult, TestResultCreateInput, TestResultUpdateInput } from '../domain/run.js';
export declare class RunRepository {
    private db;
    createRun(input: TestRunCreateInput): Promise<TestRun>;
    findRunById(id: string): Promise<TestRun | null>;
    updateRun(id: string, input: TestRunUpdateInput): Promise<TestRun | null>;
    updateRunStats(id: string): Promise<void>;
    createResult(input: TestResultCreateInput): Promise<TestResult>;
    updateResult(id: string, input: TestResultUpdateInput): Promise<TestResult | null>;
    findResultById(id: string): Promise<TestResult | null>;
    findResultsByRunId(runId: string): Promise<TestResult[]>;
    findByAgentId(agentId: string, limit?: number): Promise<TestRun[]>;
    private mapRowToRun;
    private mapRowToResult;
}
//# sourceMappingURL=run.repository.d.ts.map