/**
 * LLM Client Wrapper
 * Supports OpenAI (and OpenAI-compatible endpoints), Azure OpenAI, Anthropic Claude, and GitHub Copilot.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import '../config/env.js';
import { CopilotClient, getCopilotGitHubToken, getCopilotModel } from './copilot.js';

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

/** Accepts the aliases used in the UI/agent configs ("claude", "github") */
export function normalizeProvider(value?: string | null): LLMProvider | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'claude' || v === 'anthropic') return 'anthropic';
  if (v === 'openai' || v === 'gpt') return 'openai';
  if (v === 'azure' || v === 'azure-openai') return 'azure';
  if (v === 'copilot' || v === 'github' || v === 'github-copilot') return 'copilot';
  return undefined;
}

export function getApiKeyFor(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY || '';
    case 'azure':
      return process.env.AZURE_OPENAI_API_KEY || '';
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || '';
    case 'copilot':
      return getCopilotGitHubToken();
    default:
      return '';
  }
}

export function getDefaultModel(provider: LLMProvider): string {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-4o';
    case 'azure':
      return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
    case 'copilot':
      return getCopilotModel();
    default:
      return 'gpt-4o';
  }
}

export class LLMClient {
  private config: LLMConfig;
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private copilotClient?: CopilotClient;

  constructor(config?: Partial<LLMConfig>) {
    const provider = (config?.provider || normalizeProvider(process.env.LLM_PROVIDER) || 'openai') as LLMProvider;

    this.config = {
      provider,
      apiKey: config?.apiKey || getApiKeyFor(provider),
      model: config?.model || getDefaultModel(provider),
      endpoint: config?.endpoint || process.env.AZURE_OPENAI_ENDPOINT,
      temperature: config?.temperature ?? 0.2,
      maxTokens: config?.maxTokens ?? parseInt(process.env.LLM_MAX_TOKENS || '16000'),
    };

    const timeout = parseInt(process.env.LLM_TIMEOUT_MS || '180000');

    if (provider === 'openai') {
      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
        timeout,
        ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      });
    }

    if (provider === 'azure') {
      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
        timeout,
        baseURL: `${(this.config.endpoint || '').replace(/\/$/, '')}/openai/deployments/${this.config.model}`,
        defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-06-01' },
        defaultHeaders: { 'api-key': this.config.apiKey },
      });
    }

    if (provider === 'copilot') {
      // GitHub Copilot via API, SDK or CLI (COPILOT_MODE) — see copilot.ts
      this.copilotClient = new CopilotClient();
    }

    if (provider === 'anthropic') {
      this.anthropicClient = new Anthropic({ apiKey: this.config.apiKey, timeout });
    }
  }

  async chat(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<LLMResponse> {
    switch (this.config.provider) {
      case 'openai':
      case 'azure':
        return this.chatOpenAI(messages, options);
      case 'copilot':
        return this.copilotClient!.chat(messages, options);
      case 'anthropic':
        return this.chatAnthropic(messages, options);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  private async chatOpenAI(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<LLMResponse> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: this.config.model!,
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        temperature: this.config.temperature,
        max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens!, 16000),
      });

      const content = response.choices[0]?.message?.content || '';
      const usage = response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined;

      return { content, usage };
    } catch (error: any) {
      throw new Error(`LLM API error (${this.config.provider}): ${error.message}`);
    }
  }

  private async chatAnthropic(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<LLMResponse> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    // System prompts go in the top-level `system` field; the conversation must
    // start with a user turn and must not end with an assistant turn (no prefill).
    const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const conversation = messages.filter(m => m.role !== 'system');
    while (conversation.length > 0 && conversation[0].role !== 'user') conversation.shift();
    if (conversation.length === 0) {
      throw new Error('Anthropic request needs at least one user message');
    }

    try {
      const response = await this.anthropicClient.messages.create({
        model: this.config.model!,
        max_tokens: options?.maxTokens ?? this.config.maxTokens!,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: conversation.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      if (response.stop_reason === 'refusal') {
        // Let the router fall back to another provider.
        throw new Error('the model declined this request (stop_reason: refusal)');
      }

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      const usage = response.usage ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      } : undefined;

      return { content, usage };
    } catch (error: any) {
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for text (OpenAI only — Anthropic does not expose an embeddings API)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const embeddingClient = this.config.provider === 'openai' && this.openaiClient
      ? this.openaiClient
      : new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    try {
      const response = await embeddingClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error: any) {
      throw new Error(`Embedding generation error: ${error.message}`);
    }
  }

  getProvider(): LLMProvider {
    return this.config.provider;
  }

  getModel(): string {
    if (this.copilotClient) return `${this.copilotClient.getModel()} (${this.copilotClient.getMode()})`;
    return this.config.model || '';
  }
}

let llmClient: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClient) {
    llmClient = new LLMClient();
  }
  return llmClient;
}

export default getLLMClient;
