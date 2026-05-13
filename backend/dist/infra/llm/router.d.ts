/**
 * LLM Router
 *
 * Routes LLM calls to the optimal provider based on task type and falls back
 * to the next available provider on error.
 *
 * Task routing defaults:
 *   - "extraction"  → Claude (best for structured document understanding)
 *   - "codegen"     → Copilot (best for generating code/test scripts)
 *   - "embedding"   → OpenAI (only provider with an embeddings endpoint)
 *   - "chat"        → configured default provider
 *   - "healing"     → Claude (best multi-step reasoning)
 */
import { LLMMessage, LLMResponse, LLMProvider } from './client.js';
export type TaskType = 'extraction' | 'codegen' | 'chat' | 'embedding' | 'healing';
export interface ProviderStatus {
    provider: LLMProvider;
    model: string;
    configured: boolean;
    healthy: boolean;
    lastChecked?: Date;
    error?: string;
}
export declare class LLMRouter {
    /** Cache of LLMClient instances keyed by provider */
    private clients;
    /** Override primary provider at router level */
    private defaultProvider?;
    constructor(defaultProvider?: LLMProvider);
    /**
     * Route a chat completion to the best available provider for the given task.
     */
    chat(messages: LLMMessage[], task?: TaskType): Promise<LLMResponse & {
        provider: LLMProvider;
    }>;
    /**
     * Generate embeddings — always uses OpenAI.
     */
    generateEmbedding(text: string): Promise<number[]>;
    /**
     * Return health/configuration status for every known provider.
     */
    getProviderStatuses(): Promise<ProviderStatus[]>;
    private resolveRoute;
    private isConfigured;
    private getClient;
}
export declare function getLLMRouter(): LLMRouter;
export default getLLMRouter;
//# sourceMappingURL=router.d.ts.map