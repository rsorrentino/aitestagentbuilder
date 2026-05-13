/**
 * LLM Providers Controller
 * Exposes health/status information for configured AI providers
 */
import { getLLMRouter } from '../../infra/llm/router.js';
import logger from '../../infra/logger/index.js';
export class LlmProvidersController {
    router = getLLMRouter();
    /**
     * GET /api/v1/llm/providers
     * Returns health status of all configured LLM providers.
     */
    async listProviders(_req, res) {
        try {
            const statuses = await this.router.getProviderStatuses();
            res.json({ providers: statuses });
        }
        catch (error) {
            logger.error('Failed to fetch LLM provider statuses', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=llm-providers.controller.js.map