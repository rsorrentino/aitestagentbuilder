/**
 * Core Domain Model: Test Run and Results
 */

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TestResultStatus = 'passed' | 'failed' | 'skipped' | 'error' | 'timeout';

export interface TestResult {
  id: string;
  runId: string;
  testCaseId: string;
  status: TestResultStatus;
  startedAt: Date;
  finishedAt?: Date;
  duration?: number; // milliseconds
  logs?: string[];
  error?: string;
  evidence?: {
    screenshots?: string[];
    networkLogs?: any[];
    consoleLogs?: string[];
    video?: string;
  };
  validationResults?: ValidationResult[];
  metadata?: Record<string, any>;
}

export interface ValidationResult {
  stepId: number;
  expected: string;
  actual: string;
  passed: boolean;
  message?: string;
}

export interface TestRun {
  id: string;
  agentId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  duration?: number; // milliseconds
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  results: TestResult[];
  metadata?: {
    environment?: string;
    branch?: string;
    commit?: string;
    triggeredBy?: string;
  };
}

export interface TestRunCreateInput {
  agentId: string;
  metadata?: TestRun['metadata'];
}

export interface TestRunUpdateInput {
  status?: RunStatus;
  finishedAt?: Date;
  metadata?: Partial<TestRun['metadata']>;
}

export interface TestResultCreateInput {
  runId: string;
  testCaseId: string;
  status: TestResultStatus;
  startedAt: Date;
  logs?: string[];
  error?: string;
}

export interface TestResultUpdateInput {
  status?: TestResultStatus;
  finishedAt?: Date;
  duration?: number;
  logs?: string[];
  error?: string;
  evidence?: TestResult['evidence'];
  validationResults?: ValidationResult[];
}

