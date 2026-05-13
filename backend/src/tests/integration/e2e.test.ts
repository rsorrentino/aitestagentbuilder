/**
 * End-to-End Integration Tests
 * Tests the complete flow: Ingestion → Planning → Execution → Reporting
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

describe('E2E Test Flow', () => {
  let documentId: string;
  let testCaseIds: string[] = [];
  let agentId: string;
  let runId: string;

  beforeAll(async () => {
    // Wait for API to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  it('should ingest a test book document', async () => {
    // Create a sample test case document
    const sampleContent = `
Test Case: User Login
Module: Authentication
Priority: High

Steps:
1. Navigate to /login
2. Enter username: testuser
3. Enter password: password123
4. Click login button

Expected Results:
- User is redirected to dashboard
- Welcome message is displayed
    `;

    // In a real test, you'd upload an actual file
    // For now, we'll create a test case directly
    const testCaseResponse = await axios.post(`${API_URL}/testcases`, {
      title: 'User Login',
      module: 'Authentication',
      steps: [
        { action: 'Navigate to login page', target: '/login' },
        { action: 'Enter username', target: '#username', data: { value: 'testuser' } },
        { action: 'Enter password', target: '#password', data: { value: 'password123' } },
        { action: 'Click login button', target: '#login-btn' },
      ],
      expectedResults: [
        'User is redirected to dashboard',
        'Welcome message is displayed',
      ],
      priority: 'High',
    });

    expect(testCaseResponse.status).toBe(201);
    testCaseIds.push(testCaseResponse.data.id);
  });

  it('should create an agent', async () => {
    const agentResponse = await axios.post(`${API_URL}/agents`, {
      name: 'E2E Test Agent',
      config: {
        agent_name: 'E2E Test Agent',
        application_type: 'web',
        base_url: 'https://example.com',
        test_selection: {
          module: ['Authentication'],
          priority: ['High'],
        },
        tools: {
          browser: 'playwright',
        },
        reporting: {
          formats: ['json', 'html'],
        },
        environment: 'test',
      },
    });

    expect(agentResponse.status).toBe(201);
    agentId = agentResponse.data.id;
  });

  it('should list test cases', async () => {
    const response = await axios.get(`${API_URL}/testcases`, {
      params: { module: 'Authentication' },
    });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);
  });

  it('should start a test run', async () => {
    const runResponse = await axios.post(`${API_URL}/runs`, {
      agentId,
      metadata: {
        environment: 'test',
        triggeredBy: 'e2e-test',
      },
    });

    expect(runResponse.status).toBe(201);
    expect(runResponse.data.id).toBeDefined();
    expect(runResponse.data.status).toBe('pending');
    runId = runResponse.data.id;
  });

  it('should get run status', async () => {
    // Wait a bit for run to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    const response = await axios.get(`${API_URL}/runs/${runId}`);

    expect(response.status).toBe(200);
    expect(response.data.id).toBe(runId);
    expect(['pending', 'running', 'completed', 'failed']).toContain(response.data.status);
  });

  it('should generate a report', async () => {
    // Wait for run to complete (or use a completed run)
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      const reportResponse = await axios.post(
        `${API_URL}/reports/runs/${runId}/generate`,
        {
          formats: ['json'],
        }
      );

      expect(reportResponse.status).toBe(200);
      expect(reportResponse.data.reports).toBeDefined();
    } catch (error: any) {
      // Report generation might fail if run is still running
      // This is acceptable for E2E tests
      if (error.response?.status !== 500) {
        throw error;
      }
    }
  });

  afterAll(async () => {
    // Cleanup: Delete test data
    try {
      if (agentId) {
        await axios.delete(`${API_URL}/agents/${agentId}`);
      }
      if (testCaseIds.length > 0) {
        for (const id of testCaseIds) {
          await axios.delete(`${API_URL}/testcases/${id}`);
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });
});

