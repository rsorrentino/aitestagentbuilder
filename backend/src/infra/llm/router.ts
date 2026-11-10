/**
 * LLM Router
 *
 * Routes LLM calls to the best configured provider for a task type and falls
 * back to the next configured provider on error.
 *
 * Task routing defaults:
 *   - "extraction"  → Claude (structured document understanding)
 *   - "codegen"     → Copilot
 *   - "embedding"   → OpenAI (only provider with an embeddings endpoint)
 *   - "chat"        → Claude
 *   - "healing"     → Claude
 *
 * LLM_PROVIDER (openai | anthropic/claude | copilot | azure) overrides the
 * primary provider for every task.
 */

import { LLMClient, LLMMessage, LLMResponse, LLMProvider, normalizeProvider } from './client.js';
import { isCopilotConfigured } from './copilot.js';
import logger from '../logger/index.js';

export type TaskType = 'extraction' | 'codegen' | 'chat' | 'embedding' | 'healing';

export interface ProviderStatus {
  provider: LLMProvider;
  model: string;
  configured: boolean;
  healthy: boolean | null;
  lastChecked?: Date;
  error?: string;
}

interface RouteConfig {
  primary: LLMProvider;
  fallback: LLMProvider[];
}

const ALL_PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'copilot', 'azure'];

const TASK_ROUTES: Record<TaskType, RouteConfig> = {
  extraction: { primary: 'anthropic', fallback: ['openai', 'azure', 'copilot'] },
  codegen:    { primary: 'copilot',   fallback: ['openai', 'anthropic', 'azure'] },
  embedding:  { primary: 'openai',    fallback: [] },
  chat:       { primary: 'anthropic', fallback: ['openai', 'azure', 'copilot'] },
  healing:    { primary: 'anthropic', fallback: ['openai', 'azure', 'copilot'] },
};

export class NoLLMProviderError extends Error {
  constructor() {
    super(
      'No AI provider is configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
      'GITHUB_TOKEN / COPILOT_MODE=cli|sdk (GitHub Copilot) or AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT in your .env and restart the backend.'
    );
    this.name = 'NoLLMProviderError';
  }
}

export function isProviderConfigured(provider: LLMProvider): boolean {
  switch (provider) {
    case 'openai':    return !!process.env.OPENAI_API_KEY;
    case 'azure':     return !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'copilot':   return isCopilotConfigured();
    default:          return false;
  }
}

export class LLMRouter {
  private clients: Map<LLMProvider, LLMClient> = new Map();
  private defaultProvider?: LLMProvider;

  constructor(defaultProvider?: LLMProvider) {
    this.defaultProvider = defaultProvider;
  }

  /** True when at least one provider has credentials. */
  hasAnyProvider(): boolean {
    return ALL_PROVIDERS.some(isProviderConfigured);
  }

  /**
   * Route a chat completion to the best available provider for the given task.
   * `preferred` (e.g. from an agent's config) is tried first when configured.
   */
  async chat(
    messages: LLMMessage[],
    task: TaskType = 'chat',
    options?: { preferred?: string; maxTokens?: number },
  ): Promise<LLMResponse & { provider: LLMProvider }> {
    const providers = this.providerOrder(task, normalizeProvider(options?.preferred));
    if (providers.length === 0) {
      throw new NoLLMProviderError();
    }

    const errors: string[] = [];
    for (const provider of providers) {
      const client = this.getClient(provider)!;
      try {
        const response = await client.chat(messages, { maxTokens: options?.maxTokens });
        return { ...response, provider };
      } catch (err: any) {
        errors.push(`${provider}: ${err.message}`);
        logger.warn(`LLM provider ${provider} failed for task ${task}`, { error: err.message });
      }
    }

    throw new Error(`All configured AI providers failed — ${errors.join(' | ')}`);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const client = this.getClient('openai');
    if (!client) throw new Error('OpenAI not configured — required for embeddings');
    return client.generateEmbedding(text);
  }

  /**
   * Configuration status for every provider. With `check=true` a tiny live
   * request is sent to each configured provider to verify the credentials.
   */
  async getProviderStatuses(check = false): Promise<ProviderStatus[]> {
    return Promise.all(ALL_PROVIDERS.map(async (provider): Promise<ProviderStatus> => {
      const configured = isProviderConfigured(provider);
      const client = configured ? this.getClient(provider) : undefined;
      const status: ProviderStatus = {
        provider,
        model: client?.getModel() ?? '',
        configured,
        healthy: configured ? null : false,
      };

      if (configured && check) {
        status.lastChecked = new Date();
        try {
          await withTimeout(client!.chat([{ role: 'user', content: 'Reply with the single word: pong' }], { maxTokens: 16 }), 30000);
          status.healthy = true;
        } catch (err: any) {
          status.healthy = false;
          status.error = err.message;
        }
      }
      return status;
    }));
  }

  /** Providers to try, in order, that actually have credentials. */
  providerOrder(task: TaskType, preferred?: LLMProvider): LLMProvider[] {
    const base = TASK_ROUTES[task] ?? TASK_ROUTES.chat;
    const ordered = [preferred, this.defaultProvider, base.primary, ...base.fallback]
      .filter((p): p is LLMProvider => !!p);
    if (task !== 'embedding') ordered.push(...ALL_PROVIDERS);
    return [...new Set(ordered)].filter(isProviderConfigured);
  }

  private getClient(provider: LLMProvider): LLMClient | undefined {
    if (!isProviderConfigured(provider)) return undefined;
    if (!this.clients.has(provider)) {
      this.clients.set(provider, new LLMClient({ provider }));
    }
    return this.clients.get(provider);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

let routerInstance: LLMRouter | null = null;

export function getLLMRouter(): LLMRouter {
  if (!routerInstance) {
    routerInstance = new LLMRouter(normalizeProvider(process.env.LLM_PROVIDER));
  }
  return routerInstance;
}

export default getLLMRouter;
