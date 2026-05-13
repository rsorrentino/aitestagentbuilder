/**
 * Example Test Cases
 */

import { TestCase, validateTestCase } from '../core/domain/test-case.js';

describe('Test Case Validation', () => {
  it('should validate a complete test case', () => {
    const testCase: Partial<TestCase> = {
      id: 'TC-001',
      title: 'User Login',
      module: 'Authentication',
      steps: [
        {
          stepId: 1,
          action: 'Navigate to login page',
          target: '/login',
        },
        {
          stepId: 2,
          action: 'Enter username',
          target: '#username',
          data: { value: 'testuser' },
        },
        {
          stepId: 3,
          action: 'Enter password',
          target: '#password',
          data: { value: 'password123' },
        },
        {
          stepId: 4,
          action: 'Click login button',
          target: '#login-btn',
        },
      ],
      expectedResults: [
        'User is redirected to dashboard',
        'Welcome message is displayed',
      ],
      priority: 'High',
    };

    const validation = validateTestCase(testCase);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('should reject test case without required fields', () => {
    const testCase: Partial<TestCase> = {
      id: 'TC-002',
      // Missing title
      module: 'Authentication',
      steps: [],
      expectedResults: [],
      priority: 'High',
    };

    const validation = validateTestCase(testCase);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

