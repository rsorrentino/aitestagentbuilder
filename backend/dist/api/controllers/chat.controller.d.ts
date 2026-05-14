/**
 * Chat Controller
 * Handles conversational AI interactions for test authoring
 */
import { Request, Response } from 'express';
export declare class ChatController {
    private router;
    /**
     * POST /api/v1/chat
     * Body: { messages: LLMMessage[], task?: TaskType, context?: object }
     */
    chat(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=chat.controller.d.ts.map