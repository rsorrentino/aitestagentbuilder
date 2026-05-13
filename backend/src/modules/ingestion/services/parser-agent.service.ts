/**
 * Parser Agent Service
 * Uses LLM to extract structured test cases from parsed document text
 */

import getLLMClient from '../../../infra/llm/client.js';
import { TestCase } from '../../../core/domain/test-case.js';
import logger from '../../../infra/logger/index.js';

export interface ExtractionResult {
  testCases: TestCase[];
  metadata: {
    extractedAt: Date;
    extractionMethod: 'llm';
    confidence: number;
    totalExtracted: number;
  };
}

export class ParserAgentService {
  private llm = getLLMClient();

  /**
   * Extract test cases from parsed document text using LLM
   */
  async extractTestCases(
    text: string,
    documentId: string,
    options?: { module?: string; priority?: string }
  ): Promise<ExtractionResult> {
    const prompt = this.buildExtractionPrompt(text, options);
    
    try {
      const response = await this.llm.chat([
        {
          role: 'system',
          content: this.getSystemPrompt(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ]);

      const extracted = this.parseLLMResponse(response.content);
      
      // Add metadata to each test case and ensure required fields
      const testCases: TestCase[] = extracted.map((tc, index) => ({
        id: tc.id || `TC-${documentId}-${Date.now()}-${index}`,
        title: tc.title || `Test Case ${index + 1}`,
        module: tc.module || 'Unknown',
        steps: tc.steps || [],
        expectedResults: tc.expectedResults || [],
        priority: tc.priority || 'Medium',
        ...tc,
        metadata: {
          ...tc.metadata,
          sourceDocument: documentId,
          extractedAt: new Date(),
        },
      }));

      return {
        testCases,
        metadata: {
          extractedAt: new Date(),
          extractionMethod: 'llm',
          confidence: 0.85, // Could be calculated based on LLM response
          totalExtracted: testCases.length,
        },
      };
    } catch (error: any) {
      logger.error('Test case extraction failed', { error: error.message });
      throw new Error(`Failed to extract test cases: ${error.message}`);
    }
  }

  private getSystemPrompt(): string {
    return `You are a test case extraction assistant. Your goal is to extract structured test cases from raw text.

Each test case must include:
- id: A unique identifier (e.g., TC-001)
- title: A clear, descriptive title
- module: The functional module/area (e.g., "Authentication", "Checkout")
- description: Optional detailed description
- steps: Array of test steps, each with:
  - stepId: Sequential number starting from 1
  - action: The action to perform (e.g., "Click on login button", "Enter username")
  - target: Optional selector or element identifier
  - data: Optional data to use (e.g., {"username": "testuser"})
  - expectedResult: Optional expected result for this step
- expectedResults: Array of final expected outcomes
- preconditions: Optional array of prerequisites
- postconditions: Optional array of cleanup steps
- priority: One of "Low", "Medium", "High", "Critical"
- tags: Optional array of tags
- type: Optional type: "Functional", "Regression", "Integration", "Smoke", "E2E"

Respond with a valid JSON array of test cases. Example format:
[
  {
    "id": "TC-001",
    "title": "User Login",
    "module": "Authentication",
    "steps": [
      {"stepId": 1, "action": "Navigate to login page", "target": "/login"},
      {"stepId": 2, "action": "Enter username", "target": "#username", "data": {"value": "testuser"}},
      {"stepId": 3, "action": "Enter password", "target": "#password", "data": {"value": "password123"}},
      {"stepId": 4, "action": "Click login button", "target": "#login-btn"}
    ],
    "expectedResults": [
      "User is redirected to dashboard",
      "Welcome message is displayed"
    ],
    "priority": "High",
    "tags": ["login", "authentication"],
    "type": "Functional"
  }
]

Only return valid JSON, no additional text.`;
  }

  private buildExtractionPrompt(text: string, options?: { module?: string; priority?: string }): string {
    let prompt = `Extract all test cases from the following text:\n\n${text}\n\n`;

    if (options?.module) {
      prompt += `Focus on test cases related to module: ${options.module}\n`;
    }
    if (options?.priority) {
      prompt += `Filter by priority: ${options.priority}\n`;
    }

    prompt += '\nReturn a JSON array of extracted test cases.';

    return prompt;
  }

  private parseLLMResponse(content: string): Partial<TestCase>[] {
    try {
      // Try to extract JSON from response (might have markdown code blocks)
      let jsonStr = content.trim();
      
      // Remove markdown code blocks if present
      if (jsonStr.startsWith('```')) {
        const lines = jsonStr.split('\n');
        lines.shift(); // Remove first line (```json or ```)
        if (lines[lines.length - 1].trim() === '```') {
          lines.pop(); // Remove last line
        }
        jsonStr = lines.join('\n');
      }

      const parsed = JSON.parse(jsonStr);
      
      if (!Array.isArray(parsed)) {
        return [parsed];
      }
      
      return parsed;
    } catch (error: any) {
      logger.error('Failed to parse LLM response', { error: error.message, content });
      throw new Error(`Invalid JSON response from LLM: ${error.message}`);
    }
  }
}

