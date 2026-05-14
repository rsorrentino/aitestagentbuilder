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

import { LLMClient, LLMMessage, LLMResponse, LLMProvider } from './client.js';
import logger from '../logger/index.js';

export type TaskType = 'extraction' | 'codegen' | 'chat' | 'embedding' | 'healing';

export interface ProviderStatus {
  provider: LLMProvider;
  model: string;
  configured: boolean;
  healthy: boolean;
  lastChecked?: Date;
  error?: string;
}

interface RouteConfig {
  primary: LLMProvider;
  fallback: LLMProvider[];
}

const TASK_ROUTES: Record<TaskType, RouteConfig> = {
  extraction: { primary: 'anthropic', fallback: ['openai', 'copilot'] },
  codegen:    { primary: 'copilot',   fallback: ['openai', 'anthropic'] },
  embedding:  { primary: 'openai',    fallback: ['openai'] },
  chat:       { primary: 'anthropic', fallback: ['copilot', 'openai'] },
  healing:    { primary: 'anthropic', fallback: ['copilot', 'openai'] },
};

export class LLMRouter {
  /** Cache of LLMClient instances keyed by provider */
  private clients: Map<LLMProvider, LLMClient> = new Map();
  /** Override primary provider at router level */
  private defaultProvider?: LLMProvider;

  constructor(defaultProvider?: LLMProvider) {
    this.defaultProvider = defaultProvider;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Route a chat completion to the best available provider for the given task.
   */
  async chat(messages: LLMMessage[], task: TaskType = 'chat'): Promise<LLMResponse & { provider: LLMProvider }> {
    const route = this.resolveRoute(task);
    const providers = [route.primary, ...route.fallback];

    for (const provider of providers) {
      const client = this.getClient(provider);
      if (!client) continue;

      try {
        const response = await client.chat(messages);
        return { ...response, provider };
      } catch (err: any) {
        logger.warn(`LLM provider ${provider} failed for task ${task}, trying fallback`, {
          error: err.message,
        });
      }
    }

    throw new Error(`All LLM providers exhausted for task: ${task}`);
  }

  /**
   * Generate embeddings — always uses OpenAI.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const client = this.getClient('openai');
    if (!client) throw new Error('OpenAI not configured — required for embeddings');
    return client.generateEmbedding(text);
  }

  /**
   * Return health/configuration status for every known provider.
   */
  async getProviderStatuses(): Promise<ProviderStatus[]> {
    const providers: LLMProvider[] = ['openai', 'azure', 'anthropic', 'copilot'];
    const statuses: ProviderStatus[] = [];

    for (const provider of providers) {
      const configured = this.isConfigured(provider);
      let healthy = false;
      let error: string | undefined;
      let model = '';

      if (configured) {
        const client = this.getClient(provider);
        model = client?.getModel() ?? '';
        try {
          await client!.chat([{ role: 'user', content: 'ping' }]);
          healthy = true;
        } catch (err: any) {
          error = err.message;
        }
      }

      statuses.push({
        provider,
        model,
        configured,
        healthy,
        lastChecked: new Date(),
        error,
      });
    }

    return statuses;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private resolveRoute(task: TaskType): RouteConfig {
    const base = TASK_ROUTES[task] ?? TASK_ROUTES.chat;
    if (this.defaultProvider) {
      // Honour router-level override as primary, keep original primary as fallback
      const fallback = [base.primary, ...base.fallback].filter(p => p !== this.defaultProvider);
      return { primary: this.defaultProvider, fallback };
    }
    return base;
  }

  private isConfigured(provider: LLMProvider): boolean {
    switch (provider) {
      case 'openai':   return !!process.env.OPENAI_API_KEY;
      case 'azure':    return !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
      case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
      case 'copilot':  return !!process.env.GITHUB_TOKEN;
      default:         return false;
    }
  }

  private getClient(provider: LLMProvider): LLMClient | undefined {
    if (!this.isConfigured(provider)) return undefined;
    if (!this.clients.has(provider)) {
      this.clients.set(provider, new LLMClient({ provider }));
    }
    return this.clients.get(provider);
  }
}

// Singleton router instance
let routerInstance: LLMRouter | null = null;

export function getLLMRouter(): LLMRouter {
  if (!routerInstance) {
    const defaultProvider = (process.env.LLM_PROVIDER as LLMProvider) || undefined;
    routerInstance = new LLMRouter(defaultProvider);
  }
  return routerInstance;
}

export default getLLMRouter;
