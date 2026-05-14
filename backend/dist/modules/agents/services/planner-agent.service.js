/**
 * Planner Agent Service
 * Selects and orders tests to run based on agent configuration
 */
import { TestCaseRepository } from '../../../core/repositories/test-case.repository.js';
export class PlannerAgentService {
    testCaseRepo = new TestCaseRepository();
    /**
     * Create a test plan based on agent configuration
     */
    async createTestPlan(agentConfig) {
        const { test_selection } = agentConfig;
        // Fetch matching test cases
        const testCases = await this.selectTestCases(test_selection);
        // Order tests
        const orderedTests = this.orderTests(testCases);
        // Generate strategy description
        const strategy = this.generateStrategy(test_selection, orderedTests.length);
        // Estimate duration (rough estimate: 30 seconds per test)
        const estimatedDuration = orderedTests.length * 30000;
        return {
            tests: orderedTests.map(tc => tc.id),
            strategy,
            estimatedDuration,
            order: agentConfig.max_parallel_tests && agentConfig.max_parallel_tests > 1 ? 'parallel' : 'sequential',
        };
    }
    async selectTestCases(selection) {
        let testCases = [];
        // If specific test IDs are provided, fetch those
        if (selection.testIds && selection.testIds.length > 0) {
            const fetched = await Promise.all(selection.testIds.map(id => this.testCaseRepo.findById(id)));
            testCases = fetched.filter((tc) => tc !== null);
        }
        else {
            // Fetch all tests and filter
            testCases = await this.testCaseRepo.findAll(1000, 0);
        }
        // Apply filters
        if (selection.module && selection.module.length > 0) {
            testCases = testCases.filter(tc => selection.module.includes(tc.module));
        }
        if (selection.priority && selection.priority.length > 0) {
            testCases = testCases.filter(tc => selection.priority.includes(tc.priority));
        }
        if (selection.tags && selection.tags.length > 0) {
            testCases = testCases.filter(tc => tc.tags && tc.tags.some(tag => selection.tags.includes(tag)));
        }
        if (selection.type && selection.type.length > 0) {
            testCases = testCases.filter(tc => tc.type && selection.type.includes(tc.type));
        }
        return testCases;
    }
    orderTests(testCases) {
        // Priority ordering: Critical > High > Medium > Low
        const priorityOrder = {
            'Critical': 4,
            'High': 3,
            'Medium': 2,
            'Low': 1,
        };
        return [...testCases].sort((a, b) => {
            // First by priority
            const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
            if (priorityDiff !== 0)
                return priorityDiff;
            // Then by module
            if (a.module !== b.module) {
                return a.module.localeCompare(b.module);
            }
            // Finally by title
            return a.title.localeCompare(b.title);
        });
    }
    generateStrategy(selection, count) {
        const parts = [];
        if (selection.module && selection.module.length > 0) {
            parts.push(`module:${selection.module.join(',')}`);
        }
        if (selection.priority && selection.priority.length > 0) {
            parts.push(`priority:${selection.priority.join(',')}`);
        }
        if (selection.tags && selection.tags.length > 0) {
            parts.push(`tags:${selection.tags.join(',')}`);
        }
        if (selection.type && selection.type.length > 0) {
            parts.push(`type:${selection.type.join(',')}`);
        }
        return `${parts.join(' + ')} (${count} tests)`;
    }
}
//# sourceMappingURL=planner-agent.service.js.map