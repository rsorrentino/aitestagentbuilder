/**
 * AI Test Generator Service
 *
 * Given a target URL and a natural-language description of what to test,
 * this service:
 *   1. Calls the executor to capture a DOM/screenshot snapshot of the page.
 *   2. Sends the snapshot + description to the LLM (Claude preferred).
 *   3. Parses the LLM response into structured TestCase objects.
 */
import { TestCaseCreateInput } from '../../../core/domain/test-case.js';
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
    generatedById?: string;
}
export declare class AiTestGeneratorService {
    private router;
    /** Base URL of the executor service (used to capture DOM snapshots) */
    private executorUrl;
    /**
     * Generate test cases for a given URL and description.
     */
    generateTests(input: GenerateTestsInput): Promise<GeneratedTest[]>;
    private captureDomSnapshot;
    private buildPrompt;
    private parseResponse;
}
//# sourceMappingURL=ai-test-generator.service.d.ts.map