/**
 * LLM Client Wrapper
 * Supports OpenAI, Azure OpenAI, and Anthropic
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export type LLMProvider = 'openai' | 'azure' | 'anthropic';

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

export class LLMClient {
  private config: LLMConfig;
  private openaiClient?: OpenAI;

  constructor(config?: Partial<LLMConfig>) {
    const provider = (config?.provider || process.env.LLM_PROVIDER || 'openai') as LLMProvider;
    
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
  }

  private getApiKey(provider: LLMProvider): string {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_API_KEY || '';
      case 'azure':
        return process.env.AZURE_OPENAI_API_KEY || '';
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY || '';
      default:
        return '';
    }
  }

  private getDefaultModel(provider: LLMProvider): string {
    switch (provider) {
      case 'openai':
        return 'gpt-4-turbo-preview';
      case 'azure':
        return 'gpt-4';
      case 'anthropic':
        return 'claude-3-opus-20240229';
      default:
        return 'gpt-4';
    }
  }

  /**
   * Generate a completion from messages
   */
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    if (this.config.provider === 'openai' || this.config.provider === 'azure') {
      return this.chatOpenAI(messages);
    } else if (this.config.provider === 'anthropic') {
      // TODO: Implement Anthropic client
      throw new Error('Anthropic provider not yet implemented');
    } else {
      throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  private async chatOpenAI(messages: LLMMessage[]): Promise<LLMResponse> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: this.config.model!,
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
    } catch (error: any) {
      console.error('LLM API error:', error);
      throw new Error(`LLM API error: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      return response.data[0].embedding;
    } catch (error: any) {
      console.error('Embedding generation error:', error);
      throw new Error(`Embedding generation error: ${error.message}`);
    }
  }
}

// Singleton instance
let llmClient: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClient) {
    llmClient = new LLMClient();
  }
  return llmClient;
}

export default getLLMClient;

