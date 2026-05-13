/**
 * Planner Agent Service
 * Selects and orders tests to run based on agent configuration
 */
import { AgentConfig } from '../../../core/domain/agent.js';
export interface TestPlan {
    tests: string[];
    strategy: string;
    estimatedDuration?: number;
    order: 'sequential' | 'parallel' | 'priority';
}
export declare class PlannerAgentService {
    private testCaseRepo;
    /**
     * Create a test plan based on agent configuration
     */
    createTestPlan(agentConfig: AgentConfig): Promise<TestPlan>;
    private selectTestCases;
    private orderTests;
    private generateStrategy;
}
//# sourceMappingURL=planner-agent.service.d.ts.map