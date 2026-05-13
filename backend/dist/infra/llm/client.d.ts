/**
 * LLM Client Wrapper
 * Supports OpenAI, Azure OpenAI, Anthropic Claude, and GitHub Copilot
 */
export type LLMProvider = 'openai' | 'azure' | 'anthropic' | 'copilot';
export interface LLMConfig {
    provider: LLMProvider;
    apiKey: string;
    model?: string;
    endpoint?: string;
    temperature?: number;
    maxTokens?: number;
}
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface LLMResponse {
    content: string;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
}
export declare class LLMClient {
    private config;
    private openaiClient?;
    private anthropicClient?;
    constructor(config?: Partial<LLMConfig>);
    private getApiKey;
    private getDefaultModel;
    /**
     * Generate a completion from messages
     */
    chat(messages: LLMMessage[]): Promise<LLMResponse>;
    private chatOpenAI;
    private chatAnthropic;
    /**
     * Generate embeddings for text (OpenAI only — Anthropic does not expose an embeddings API)
     */
    generateEmbedding(text: string): Promise<number[]>;
    /** Return the active provider name */
    getProvider(): LLMProvider;
    /** Return the active model name */
    getModel(): string;
}
export declare function getLLMClient(): LLMClient;
export default getLLMClient;
//# sourceMappingURL=client.d.ts.map