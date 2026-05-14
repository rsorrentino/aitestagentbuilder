/**
 * Core Domain Model: TestCase
 *
 * Canonical schema for representing structured test cases
 * across all subsystems.
 */
export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type TestType = 'Functional' | 'Regression' | 'Integration' | 'Smoke' | 'E2E';
export interface TestStep {
    stepId: number;
    action: string;
    target?: string;
    data?: Record<string, any>;
    expectedResult?: string;
}
export interface TestCaseVersion {
    version: string;
    createdAt: Date;
    createdBy?: string;
    changes?: string;
}
export interface TestCase {
    id: string;
    title: string;
    module: string;
    description?: string;
    steps: TestStep[];
    expectedResults: string[];
    preconditions?: string[];
    postconditions?: string[];
    priority: Priority;
    tags?: string[];
    type?: TestType;
    data?: Record<string, any>;
    metadata?: {
        sourceDocument?: string;
        extractedAt?: Date;
        version?: string;
        author?: string;
    };
    version?: string;
    versions?: TestCaseVersion[];
}
export interface TestCaseCreateInput {
    title: string;
    module: string;
    description?: string;
    steps: Omit<TestStep, 'stepId'>[];
    expectedResults: string[];
    preconditions?: string[];
    postconditions?: string[];
    priority: Priority;
    tags?: string[];
    type?: TestType;
    data?: Record<string, any>;
    metadata?: TestCase['metadata'];
}
export interface TestCaseUpdateInput {
    title?: string;
    module?: string;
    description?: string;
    steps?: Omit<TestStep, 'stepId'>[];
    expectedResults?: string[];
    preconditions?: string[];
    postconditions?: string[];
    priority?: Priority;
    tags?: string[];
    type?: TestType;
    data?: Record<string, any>;
}
/**
 * Validates a test case structure
 */
export declare function validateTestCase(testCase: Partial<TestCase>): {
    valid: boolean;
    errors: string[];
};
/**
 * Generates a unique test case ID
 */
export declare function generateTestCaseId(prefix?: string): string;
/**
 * Generate version number
 */
export declare function generateVersion(currentVersion?: string): string;
//# sourceMappingURL=test-case.d.ts.map