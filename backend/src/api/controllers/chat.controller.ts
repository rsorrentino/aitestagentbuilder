/**
 * Chat Controller
 * Conversational AI for test authoring.
 */

import { Request, Response } from 'express';
import { getLLMRouter, NoLLMProviderError, TaskType } from '../../infra/llm/router.js';
import { LLMMessage } from '../../infra/llm/client.js';
import { STEP_ACTIONS_DOC } from '../../modules/ingestion/services/parser-agent.service.js';
import logger from '../../infra/logger/index.js';

const SYSTEM_PROMPT =
  'You are the QA assistant inside AI Test Agent Builder. Help the user design, analyse and improve automated browser tests.\n' +
  'When the user asks you to create tests, include a JSON array of test cases in a ```json code block with fields: ' +
  'title, module, description, priority (Low|Medium|High|Critical), type, tags, steps (action, target, data, expectedResult), expectedResults.\n\n' +
  STEP_ACTIONS_DOC;

const TASKS: TaskType[] = ['chat', 'extraction', 'codegen', 'healing'];

export class ChatController {
  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { messages, task = 'chat', context, provider } = req.body ?? {};

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages array is required' });
        return;
      }

      const conversation: LLMMessage[] = messages
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m: any) => ({ role: m.role, content: m.content }));
      if (!conversation.some((m) => m.role === 'user')) {
        res.status(400).json({ error: 'at least one user message is required' });
        return;
      }

      const system = context
        ? `${SYSTEM_PROMPT}\n\nCurrent context:\n${JSON.stringify(context).slice(0, 8000)}`
        : SYSTEM_PROMPT;

      const response = await getLLMRouter().chat(
        [{ role: 'system', content: system }, ...conversation],
        TASKS.includes(task) ? task : 'chat',
        { preferred: provider },
      );

      res.json({ content: response.content, provider: response.provider, usage: response.usage });
    } catch (error: any) {
      logger.error('Chat request failed', { error: error.message });
      res.status(error instanceof NoLLMProviderError ? 503 : 500).json({ error: error.message });
    }
  }
}
