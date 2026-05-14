/**
 * Chat Controller
 * Handles conversational AI interactions for test authoring
 */
import { getLLMRouter } from '../../infra/llm/router.js';
import logger from '../../infra/logger/index.js';
export class ChatController {
    router = getLLMRouter();
    /**
     * POST /api/v1/chat
     * Body: { messages: LLMMessage[], task?: TaskType, context?: object }
     */
    async chat(req, res) {
        try {
            const { messages, task = 'chat', context } = req.body;
            if (!Array.isArray(messages) || messages.length === 0) {
                res.status(400).json({ error: 'messages array is required' });
                return;
            }
            // Optionally inject context into system message
            const enrichedMessages = context
                ? [
                    {
                        role: 'system',
                        content: 'You are an AI-powered QA engineer assistant integrated into the AI Test Agent Builder platform. ' +
                            'Help the user write, analyse, and improve test cases using natural language. ' +
                            `Current context: ${JSON.stringify(context)}`,
                    },
                    ...messages,
                ]
                : messages;
            const response = await this.router.chat(enrichedMessages, task);
            res.json({
                content: response.content,
                provider: response.provider,
                usage: response.usage,
            });
        }
        catch (error) {
            logger.error('Chat request failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=chat.controller.js.map