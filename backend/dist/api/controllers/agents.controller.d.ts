/**
 * Agents Controller
 */
import { Request, Response } from 'express';
export declare class AgentsController {
    private agentRepo;
    private testGenerator;
    createAgent(req: Request, res: Response): Promise<void>;
    getAgent(req: Request, res: Response): Promise<void>;
    listAgents(req: Request, res: Response): Promise<void>;
    updateAgent(req: Request, res: Response): Promise<void>;
    deleteAgent(req: Request, res: Response): Promise<void>;
    /**
     * POST /api/v1/agents/:id/generate-tests
     * Uses the configured LLM to generate test cases for the agent's target URL.
     */
    generateTests(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=agents.controller.d.ts.map