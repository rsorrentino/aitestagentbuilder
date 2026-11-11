/**
 * Planner Agent Service
 * Selects and orders the test cases an agent will run.
 */

import { TestCase } from '../../../core/domain/test-case.js';
import { AgentConfig, TestSelection } from '../../../core/domain/agent.js';
import { TestCaseRepository } from '../../../core/repositories/test-case.repository.js';

export interface TestPlan {
  tests: string[]; // Test case IDs, in execution order
  testCases: TestCase[];
  strategy: string;
  estimatedDuration?: number; // milliseconds
  order: 'sequential' | 'parallel' | 'priority';
}

const PRIORITY_ORDER: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export class PlannerAgentService {
  private testCaseRepo = new TestCaseRepository();

  async createTestPlan(agentConfig: AgentConfig, projectId: string): Promise<TestPlan> {
    const selection: TestSelection = agentConfig.test_selection ?? {};
    const testCases = this.orderTests(await this.selectTestCases(selection, projectId));

    return {
      tests: testCases.map(tc => tc.id),
      testCases,
      strategy: this.describe(selection, testCases.length),
      estimatedDuration: testCases.length * 15000,
      order: 'priority',
    };
  }

  private async selectTestCases(selection: TestSelection, projectId: string): Promise<TestCase[]> {
    const nonEmpty = (v?: string[]) => (v && v.length > 0 ? v : undefined);
    return this.testCaseRepo.search({
      projectId,
      ids: nonEmpty(selection.testIds),
      module: nonEmpty(selection.module),
      priority: nonEmpty(selection.priority),
      type: nonEmpty(selection.type),
      tags: nonEmpty(selection.tags),
      limit: 1000,
    });
  }

  private orderTests(testCases: TestCase[]): TestCase[] {
    return [...testCases].sort((a, b) => {
      const priorityDiff = (PRIORITY_ORDER[b.priority] ?? 0) - (PRIORITY_ORDER[a.priority] ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      if (a.module !== b.module) return a.module.localeCompare(b.module);
      return a.title.localeCompare(b.title);
    });
  }

  private describe(selection: TestSelection, count: number): string {
    const parts: string[] = [];
    if (selection.testIds?.length) parts.push(`${selection.testIds.length} selected test(s)`);
    if (selection.module?.length) parts.push(`module: ${selection.module.join(', ')}`);
    if (selection.priority?.length) parts.push(`priority: ${selection.priority.join(', ')}`);
    if (selection.tags?.length) parts.push(`tags: ${selection.tags.join(', ')}`);
    if (selection.type?.length) parts.push(`type: ${selection.type.join(', ')}`);
    return `${parts.length ? parts.join(' + ') : 'all test cases'} (${count} tests)`;
  }
}
