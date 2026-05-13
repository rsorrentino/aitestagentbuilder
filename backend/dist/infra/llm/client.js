/**
 * LLM Client Wrapper
 * Supports OpenAI, Azure OpenAI, Anthropic Claude, and GitHub Copilot
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();
export class LLMClient {
    config;
    openaiClient;
    anthropicClient;
    constructor(config) {
        const provider = (config?.provider || process.env.LLM_PROVIDER || 'openai');
        this.config = {
            provider,
            apiKey: config?.apiKey || this.getApiKey(provider),
            model: config?.model || this.getDefaultModel(provider),
            endpoint: config?.endpoint || process.env.AZURE_OPENAI_ENDPOINT,
            temperature: config?.temperature ?? 0.7,
            maxTokens: config?.maxTokens ?? 2000,
        };
        if (this.config.provider === 'openai' || this.config.provider === 'azure') {
            this.openaiClient = new OpenAI({
                apiKey: this.config.apiKey,
                ...(this.config.provider === 'azure' && this.config.endpoint ? {
                    baseURL: `${this.config.endpoint}/openai/deployments/${this.config.model}`,
                    defaultQuery: { 'api-version': '2023-05-15' },
                    defaultHeaders: { 'api-key': this.config.apiKey },
                } : {}),
            });
        }
        if (this.config.provider === 'copilot') {
            // GitHub Copilot exposes an OpenAI-compatible chat completions endpoint
            this.openaiClient = new OpenAI({
                apiKey: this.config.apiKey,
                baseURL: 'https://api.githubcopilot.com',
            });
        }
        if (this.config.provider === 'anthropic') {
            this.anthropicClient = new Anthropic({ apiKey: this.config.apiKey });
        }
    }
    getApiKey(provider) {
        switch (provider) {
            case 'openai':
                return process.env.OPENAI_API_KEY || '';
            case 'azure':
                return process.env.AZURE_OPENAI_API_KEY || '';
            case 'anthropic':
                return process.env.ANTHROPIC_API_KEY || '';
            case 'copilot':
                return process.env.GITHUB_TOKEN || '';
            default:
                return '';
        }
    }
    getDefaultModel(provider) {
        switch (provider) {
            case 'openai':
                return 'gpt-4o';
            case 'azure':
                return 'gpt-4';
            case 'anthropic':
                return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
            case 'copilot':
                return 'gpt-4o';
            default:
                return 'gpt-4o';
        }
    }
    /**
     * Generate a completion from messages
     */
    async chat(messages) {
        switch (this.config.provider) {
            case 'openai':
            case 'azure':
            case 'copilot':
                return this.chatOpenAI(messages);
            case 'anthropic':
                return this.chatAnthropic(messages);
            default:
                throw new Error(`Unsupported provider: ${this.config.provider}`);
        }
    }
    async chatOpenAI(messages) {
        if (!this.openaiClient) {
            throw new Error('OpenAI client not initialized');
        }
        try {
            const response = await this.openaiClient.chat.completions.create({
                model: this.config.model,
                messages: messages.map(msg => ({
                    role: msg.role,
                    content: msg.content,
                })),
                temperature: this.config.temperature,
                max_tokens: this.config.maxTokens,
            });
            const content = response.choices[0]?.message?.content || '';
            const usage = response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : undefined;
            return { content, usage };
        }
        catch (error) {
            throw new Error(`LLM API error (${this.config.provider}): ${error.message}`);
        }
    }
    async chatAnthropic(messages) {
        if (!this.anthropicClient) {
            throw new Error('Anthropic client not initialized');
        }
        try {
            // Separate system message from conversation messages
            const systemMessages = messages.filter(m => m.role === 'system');
            const conversationMessages = messages.filter(m => m.role !== 'system');
            const systemPrompt = systemMessages.map(m => m.content).join('\n');
            const response = await this.anthropicClient.messages.create({
                model: this.config.model,
                max_tokens: this.config.maxTokens,
                ...(systemPrompt ? { system: systemPrompt } : {}),
                messages: conversationMessages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
            });
            const content = response.content
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('');
            const usage = response.usage ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.input_tokens + response.usage.output_tokens,
            } : undefined;
            return { content, usage };
        }
        catch (error) {
            throw new Error(`Anthropic API error: ${error.message}`);
        }
    }
    /**
     * Generate embeddings for text (OpenAI only — Anthropic does not expose an embeddings API)
     */
    async generateEmbedding(text) {
        // Always use OpenAI for embeddings regardless of the active chat provider
        const embeddingClient = this.openaiClient ?? new OpenAI({
            apiKey: process.env.OPENAI_API_KEY || '',
        });
        try {
            const response = await embeddingClient.embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
            });
            return response.data[0].embedding;
        }
        catch (error) {
            throw new Error(`Embedding generation error: ${error.message}`);
        }
    }
    /** Return the active provider name */
    getProvider() {
        return this.config.provider;
    }
    /** Return the active model name */
    getModel() {
        return this.config.model || '';
    }
}
// Singleton instance
let llmClient = null;
export function getLLMClient() {
    if (!llmClient) {
        llmClient = new LLMClient();
    }
    return llmClient;
}
export default getLLMClient;
//# sourceMappingURL=client.js.map