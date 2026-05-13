/**
 * LLM Providers Controller
 * Exposes health/status information for configured AI providers
 */

import { Request, Response } from 'express';
import { getLLMRouter } from '../../infra/llm/router.js';
import logger from '../../infra/logger/index.js';

export class LlmProvidersController {
  private router = getLLMRouter();

  /**
   * GET /api/v1/llm/providers
   * Returns health status of all configured LLM providers.
   */
  async listProviders(_req: Request, res: Response): Promise<void> {
    try {
      const statuses = await this.router.getProviderStatuses();
      res.json({ providers: statuses });
    } catch (error: any) {
      logger.error('Failed to fetch LLM provider statuses', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}
