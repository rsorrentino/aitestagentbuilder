/**
 * AI Test Generator Service
 *
 * Given a target URL and a natural-language description, this service:
 *   1. Opens the page in a headless browser and captures a compact DOM outline.
 *   2. Sends the outline + description to the LLM.
 *   3. Normalizes the response into executable test cases.
 */

import { getLLMRouter } from '../../../infra/llm/router.js';
import { extractJsonArray } from '../../../infra/llm/json.js';
import { TestCaseCreateInput } from '../../../core/domain/test-case.js';
import { normalizeTestCaseInput } from '../../../core/domain/normalize.js';
import { STEP_ACTIONS_DOC } from '../../ingestion/services/parser-agent.service.js';
import { capturePageOutline } from '../../execution/browser.js';
import logger from '../../../infra/logger/index.js';

export interface GenerateTestsInput {
  targetUrl: string;
  description: string;
  count?: number;
  modules?: string[];
  preferredProvider?: string;
  tags?: string[];
}

export class AiTestGeneratorService {
  private router = getLLMRouter();

  async generateTests(input: GenerateTestsInput): Promise<{ tests: TestCaseCreateInput[]; provider: string; pageCaptured: boolean }> {
    const count = Math.min(Math.max(input.count ?? 5, 1), 20);

    let outline = '';
    try {
      outline = await capturePageOutline(input.targetUrl);
    } catch (err: any) {
      logger.warn('Could not capture page outline, generating without it', { url: input.targetUrl, error: err.message });
    }

    const response = await this.router.chat(
      [
        {
          role: 'system',
          content:
            'You are a senior QA automation engineer. You write precise, executable browser test cases as JSON.\n\n' +
            STEP_ACTIONS_DOC,
        },
        { role: 'user', content: this.buildPrompt(input, outline, count) },
      ],
      'extraction',
      { preferred: input.preferredProvider },
    );

    const tests = extractJsonArray(response.content)
      .map((item) => normalizeTestCaseInput(item, {
        module: input.modules?.[0],
        author: `ai-generator (${response.provider})`,
        tags: ['ai-generated', ...(input.tags ?? [])],
      }))
      .filter((t): t is TestCaseCreateInput => t !== null && t.steps.length > 0);

    logger.info('AI test generation complete', { url: input.targetUrl, provider: response.provider, count: tests.length });
    return { tests, provider: response.provider, pageCaptured: !!outline };
  }

  private buildPrompt(input: GenerateTestsInput, outline: string, count: number): string {
    const pageSection = outline
      ? `\n\nPage outline captured from ${input.targetUrl} (interactive elements with their selectors):\n${outline}`
      : '\n\n(The page could not be loaded; infer reasonable selectors.)';
    const moduleFocus = input.modules?.length ? `\nFocus on these modules/areas: ${input.modules.join(', ')}.` : '';

    return (
      `Generate ${count} test cases for this application.\n\n` +
      `Base URL: ${input.targetUrl}\n` +
      `What to test: ${input.description}` +
      moduleFocus +
      pageSection +
      `\n\nUse paths relative to the base URL for "navigate" (e.g. "/" or "/login"). ` +
      `Only use selectors that appear in the outline when one is available. ` +
      `Every test must start with a navigate step and end with at least one assert_* step.\n\n` +
      `Return a JSON array of objects with: title, module, description, priority (Low|Medium|High|Critical), ` +
      `type (Functional|Regression|Integration|Smoke|E2E), tags, preconditions, steps (action, target, data, expectedResult), expectedResults. ` +
      `Return ONLY the JSON array.`
    );
  }
}
