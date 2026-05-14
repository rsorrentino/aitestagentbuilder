/**
 * Parser Agent Service
 * Uses LLM to extract structured test cases from parsed document text
 */
import { TestCase } from '../../../core/domain/test-case.js';
export interface ExtractionResult {
    testCases: TestCase[];
    metadata: {
        extractedAt: Date;
        extractionMethod: 'llm';
        confidence: number;
        totalExtracted: number;
    };
}
export declare class ParserAgentService {
    private llm;
    /**
     * Extract test cases from parsed document text using LLM
     */
    extractTestCases(text: string, documentId: string, options?: {
        module?: string;
        priority?: string;
    }): Promise<ExtractionResult>;
    private getSystemPrompt;
    private buildExtractionPrompt;
    private parseLLMResponse;
}
//# sourceMappingURL=parser-agent.service.d.ts.map