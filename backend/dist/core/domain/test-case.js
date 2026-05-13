/**
 * Core Domain Model: TestCase
 *
 * Canonical schema for representing structured test cases
 * across all subsystems.
 */
/**
 * Validates a test case structure
 */
export function validateTestCase(testCase) {
    const errors = [];
    if (!testCase.id)
        errors.push('Test case must have an id');
    if (!testCase.title || testCase.title.trim().length === 0) {
        errors.push('Test case must have a non-empty title');
    }
    if (!testCase.module || testCase.module.trim().length === 0) {
        errors.push('Test case must have a module');
    }
    if (!testCase.steps || testCase.steps.length === 0) {
        errors.push('Test case must have at least one step');
    }
    if (!testCase.expectedResults || testCase.expectedResults.length === 0) {
        errors.push('Test case must have at least one expected result');
    }
    if (!testCase.priority) {
        errors.push('Test case must have a priority');
    }
    // Validate steps
    if (testCase.steps) {
        testCase.steps.forEach((step, index) => {
            if (!step.action || step.action.trim().length === 0) {
                errors.push(`Step ${index + 1} must have an action`);
            }
            if (step.stepId !== index + 1) {
                errors.push(`Step ${index + 1} has incorrect stepId: ${step.stepId}`);
            }
        });
    }
    return {
        valid: errors.length === 0,
        errors
    };
}
/**
 * Generates a unique test case ID
 */
export function generateTestCaseId(prefix = 'TC') {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${prefix}-${timestamp}-${random}`;
}
/**
 * Generate version number
 */
export function generateVersion(currentVersion) {
    if (!currentVersion) {
        return '1.0.0';
    }
    const parts = currentVersion.split('.');
    const minor = parseInt(parts[1] || '0') + 1;
    return `${parts[0]}.${minor}.0`;
}
//# sourceMappingURL=test-case.js.map