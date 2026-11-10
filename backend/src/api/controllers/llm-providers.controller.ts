/**
 * LLM Providers Controller
 */

import { Request, Response } from 'express';
import { getLLMRouter } from '../../infra/llm/router.js';
import { describeCopilotSetup, getCopilotMode } from '../../infra/llm/copilot.js';
import logger from '../../infra/logger/index.js';

export class LlmProvidersController {
  /**
   * GET /llm/providers[?check=true]
   * Configuration status of every provider; with check=true a tiny live
   * request verifies each configured provider's credentials.
   */
  async listProviders(req: Request, res: Response): Promise<void> {
    try {
      const check = req.query.check === 'true' || req.query.check === '1';
      const router = getLLMRouter();
      const statuses = await router.getProviderStatuses(check);
      res.json({
        providers: statuses.map((s) => ({
          ...s,
          ...(s.provider === 'copilot' ? { mode: getCopilotMode(), setup: describeCopilotSetup() } : {}),
        })),
        routing: {
          extraction: router.providerOrder('extraction'),
          chat: router.providerOrder('chat'),
          healing: router.providerOrder('healing'),
          codegen: router.providerOrder('codegen'),
        },
        anyConfigured: router.hasAnyProvider(),
      });
    } catch (error: any) {
      logger.error('Failed to fetch LLM provider statuses', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}
