/**
 * AI Test Generator Service
 *
 * Given a target URL and a natural-language description of what to test,
 * this service:
 *   1. Calls the executor to capture a DOM/screenshot snapshot of the page.
 *   2. Sends the snapshot + description to the LLM (Claude preferred).
 *   3. Parses the LLM response into structured TestCase objects.
 */

import axios from 'axios';
import { getLLMRouter } from '../../../infra/llm/router.js';
import logger from '../../../infra/logger/index.js';
import {
  TestCaseCreateInput,
} from '../../../core/domain/test-case.js';

export interface GenerateTestsInput {
  targetUrl: string;
  description: string;
  /** How many test cases to generate (default: 5) */
  count?: number;
  /** Salesforce-specific: org base URL for relative navigation */
  salesforceBaseUrl?: string;
  /** Modules / areas to focus on */
  modules?: string[];
}

export interface GeneratedTest extends TestCaseCreateInput {
  generatedById?: string; // agent ID
}

export class AiTestGeneratorService {
  private router = getLLMRouter();
  /** Base URL of the executor service (used to capture DOM snapshots) */
  private executorUrl = process.env.EXECUTOR_URL || 'http://localhost:8001';

  /**
   * Generate test cases for a given URL and description.
   */
  async generateTests(input: GenerateTestsInput): Promise<GeneratedTest[]> {
    const count = input.count ?? 5;

    // 1. Capture a DOM snapshot of the target page
    const domSnapshot = await this.captureDomSnapshot(input.targetUrl);

    // 2. Build the prompt
    const prompt = this.buildPrompt(input, domSnapshot, count);

    // 3. Call LLM (extraction task → Claude preferred)
    const response = await this.router.chat(
      [
        {
          role: 'system',
          content:
            'You are a senior QA engineer and test automation expert. ' +
            'You generate precise, executable Playwright-compatible test cases in JSON format.',
        },
        { role: 'user', content: prompt },
      ],
      'extraction',
    );

    // 4. Parse LLM response into TestCase objects
    const tests = this.parseResponse(response.content, input);
    logger.info('AI test generation complete', {
      url: input.targetUrl,
      provider: response.provider,
      count: tests.length,
    });

    return tests;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async captureDomSnapshot(url: string): Promise<string> {
    try {
      const res = await axios.post(
        `${this.executorUrl}/snapshot`,
        { url },
        { timeout: 30000 },
      );
      return (res.data?.dom as string) ?? '';
    } catch (err: any) {
      logger.warn('Could not capture DOM snapshot, continuing without it', { error: err.message });
      return '';
    }
  }

  private buildPrompt(input: GenerateTestsInput, domSnapshot: string, count: number): string {
    const domSection = domSnapshot
      ? `\n\nPage DOM snapshot (truncated):\n\`\`\`html\n${domSnapshot.substring(0, 6000)}\n\`\`\``
      : '';

    const moduleFocus = input.modules?.length
      ? `\nFocus on these modules/areas: ${input.modules.join(', ')}.`
      : '';

    return (
      `Generate ${count} Playwright-ready test cases for the following scenario:\n\n` +
      `URL: ${input.targetUrl}\n` +
      `Description: ${input.description}` +
      moduleFocus +
      domSection +
      `\n\nReturn a JSON array of test cases. Each test case MUST follow this exact schema:\n` +
      `\`\`\`json
[
  {
    "title": "string",
    "module": "string",
    "description": "string",
    "priority": "Low|Medium|High|Critical",
    "type": "Functional|Regression|Integration|Smoke|E2E",
    "tags": ["string"],
    "preconditions": ["string"],
    "steps": [
      {
        "action": "navigate|click|fill|select|wait|screenshot|get text|salesforce_login|wait_for_lightning",
        "target": "CSS selector or URL",
        "data": { "value": "optional value" },
        "expectedResult": "optional assertion"
      }
    ],
    "expectedResults": ["string"]
  }
]
\`\`\`\n\nReturn ONLY the JSON array. No markdown, no explanations.`
    );
  }

  private parseResponse(content: string, input: GenerateTestsInput): GeneratedTest[] {
    // Strip markdown code fences if present
    const cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    let raw: any[];
    try {
      raw = JSON.parse(cleaned);
    } catch {
      // Try to extract JSON array from response
      const match = cleaned.match(/\[[\s\S]+\]/);
      if (!match) {
        logger.error('LLM response did not contain a valid JSON array', { content });
        return [];
      }
      try {
        raw = JSON.parse(match[0]);
      } catch {
        logger.error('Failed to parse extracted JSON from LLM response');
        return [];
      }
    }

    if (!Array.isArray(raw)) return [];

    return raw.map((item: any): GeneratedTest => ({
      title: String(item.title || 'Untitled test'),
      module: String(item.module || input.modules?.[0] || 'General'),
      description: item.description,
      priority: item.priority ?? 'Medium',
      type: item.type ?? 'Functional',
      tags: Array.isArray(item.tags) ? item.tags : ['ai-generated'],
      preconditions: Array.isArray(item.preconditions) ? item.preconditions : [],
      steps: Array.isArray(item.steps)
        ? item.steps.map((s: any, idx: number) => ({
            stepId: idx + 1,
            action: String(s.action || ''),
            target: s.target,
            data: s.data,
            expectedResult: s.expectedResult,
          }))
        : [],
      expectedResults: Array.isArray(item.expectedResults)
        ? item.expectedResults
        : ['Test completes successfully'],
      metadata: {
        extractedAt: new Date(),
        author: 'ai-generator',
        version: '1.0.0',
      },
    }));
  }
}
