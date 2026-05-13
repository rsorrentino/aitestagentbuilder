/**
 * LLM Providers Controller
 * Exposes health/status information for configured AI providers
 */
import { Request, Response } from 'express';
export declare class LlmProvidersController {
    private router;
    /**
     * GET /api/v1/llm/providers
     * Returns health status of all configured LLM providers.
     */
    listProviders(_req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=llm-providers.controller.d.ts.map