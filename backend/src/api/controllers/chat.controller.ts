/**
 * Chat Controller
 * Handles conversational AI interactions for test authoring
 */

import { Request, Response } from 'express';
import { getLLMRouter, TaskType } from '../../infra/llm/router.js';
import { LLMMessage } from '../../infra/llm/client.js';
import logger from '../../infra/logger/index.js';

export class ChatController {
  private router = getLLMRouter();

  /**
   * POST /api/v1/chat
   * Body: { messages: LLMMessage[], task?: TaskType, context?: object }
   */
  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { messages, task = 'chat', context } = req.body as {
        messages: LLMMessage[];
        task?: TaskType;
        context?: Record<string, any>;
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages array is required' });
        return;
      }

      // Optionally inject context into system message
      const enrichedMessages: LLMMessage[] = context
        ? [
            {
              role: 'system',
              content:
                'You are an AI-powered QA engineer assistant integrated into the AI Test Agent Builder platform. ' +
                'Help the user write, analyse, and improve test cases using natural language. ' +
                `Current context: ${JSON.stringify(context)}`,
            },
            ...messages,
          ]
        : messages;

      const response = await this.router.chat(enrichedMessages, task as TaskType);

      res.json({
        content: response.content,
        provider: response.provider,
        usage: response.usage,
      });
    } catch (error: any) {
      logger.error('Chat request failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}
