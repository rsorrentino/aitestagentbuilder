/**
 * Parser Agent Service
 * Uses an LLM to extract structured, executable test cases from document text.
 */

import { getLLMRouter } from '../../../infra/llm/router.js';
import { extractJsonArray } from '../../../infra/llm/json.js';
import { TestCaseCreateInput } from '../../../core/domain/test-case.js';
import { normalizeTestCaseInput } from '../../../core/domain/normalize.js';
import logger from '../../../infra/logger/index.js';

export interface ExtractionResult {
  testCases: TestCaseCreateInput[];
  metadata: {
    extractedAt: Date;
    extractionMethod: 'llm';
    provider: string;
    totalExtracted: number;
    truncated: boolean;
  };
}

/** Characters of document text sent to the model in one request. */
const MAX_DOCUMENT_CHARS = parseInt(process.env.EXTRACTION_MAX_CHARS || '60000');

export class ParserAgentService {
  private router = getLLMRouter();

  async extractTestCases(
    text: string,
    documentId: string,
    options?: { module?: string; priority?: string; baseUrl?: string },
  ): Promise<ExtractionResult> {
    const cleaned = text.trim();
    if (!cleaned) {
      throw new Error('The document contains no readable text.');
    }

    const truncated = cleaned.length > MAX_DOCUMENT_CHARS;
    const body = truncated ? cleaned.slice(0, MAX_DOCUMENT_CHARS) : cleaned;
    if (truncated) {
      logger.warn('Document text truncated for extraction', { documentId, length: cleaned.length, limit: MAX_DOCUMENT_CHARS });
    }

    const response = await this.router.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: this.buildPrompt(body, options) },
      ],
      'extraction',
    );

    const raw = extractJsonArray(response.content);
    const testCases = raw
      .map((item) => normalizeTestCaseInput(item, {
        module: options?.module,
        documentId,
        author: `ai-extraction (${response.provider})`,
      }))
      .filter((tc): tc is TestCaseCreateInput => tc !== null);

    if (testCases.length === 0) {
      throw new Error('The AI did not find any test cases in this document.');
    }

    return {
      testCases,
      metadata: {
        extractedAt: new Date(),
        extractionMethod: 'llm',
        provider: response.provider,
        totalExtracted: testCases.length,
        truncated,
      },
    };
  }

  private buildPrompt(text: string, options?: { module?: string; priority?: string; baseUrl?: string }): string {
    let prompt = `Extract all test cases from the following document.\n\n<document>\n${text}\n</document>\n\n`;
    if (options?.module) prompt += `Use "${options.module}" as the module when the document does not name one.\n`;
    if (options?.priority) prompt += `Only include test cases with priority ${options.priority}.\n`;
    if (options?.baseUrl) prompt += `The application under test is at ${options.baseUrl}; use relative paths for navigation targets.\n`;
    prompt += '\nReturn only the JSON array.';
    return prompt;
  }
}

export const STEP_ACTIONS_DOC = `Allowed step actions (use exactly these words):
- "navigate"      target: URL or path (e.g. "/login")
- "click"         target: CSS selector or visible text, e.g. "#submit" or "text=Sign in"
- "fill"          target: input selector; data.value: text to type
- "select"        target: <select> selector; data.value: option value or label
- "check" / "uncheck"  target: checkbox selector
- "press"         data.value: key name, e.g. "Enter" (target optional)
- "hover"         target: selector
- "wait"          target: selector to wait for, or data.ms: milliseconds
- "assert_visible"  target: selector or "text=..." that must be visible
- "assert_text"   data.value: text that must appear (target optional: element to look in)
- "assert_url"    data.value: substring the current URL must contain
- "assert_title"  data.value: substring the page title must contain
- "screenshot"    take a screenshot
Prefer robust selectors: ids, name attributes, data-testid, roles, or "text=Visible label".`;

const SYSTEM_PROMPT = `You are a senior QA automation engineer. You turn test documentation into structured, executable browser test cases.

Each test case is a JSON object:
{
  "title": "string",
  "module": "functional area, e.g. Authentication",
  "description": "string",
  "priority": "Low" | "Medium" | "High" | "Critical",
  "type": "Functional" | "Regression" | "Integration" | "Smoke" | "E2E",
  "tags": ["string"],
  "preconditions": ["string"],
  "steps": [{ "action": "...", "target": "...", "data": { "value": "..." }, "expectedResult": "..." }],
  "expectedResults": ["string"]
}

${STEP_ACTIONS_DOC}

Every test must end with at least one assert_* step that checks the expected result.
Respond with a JSON array of test cases and nothing else.`;
