/**
 * Agents Controller
 */

import { Request, Response } from 'express';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { AgentCreateInput } from '../../core/domain/agent.js';
import logger from '../../infra/logger/index.js';

export class AgentsController {
  private agentRepo = new AgentRepository();

  async createAgent(req: Request, res: Response): Promise<void> {
    try {
      const input: AgentCreateInput = req.body;
      
      // Validate required fields
      if (!input.name || !input.config) {
        res.status(400).json({ error: 'Name and config are required' });
        return;
      }

      const agent = await this.agentRepo.create(input);
      res.status(201).json(agent);
    } catch (error: any) {
      logger.error('Agent creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async getAgent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const agent = await this.agentRepo.findById(id);
      
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json(agent);
    } catch (error: any) {
      logger.error('Failed to fetch agent', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async listAgents(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      
      const agents = await this.agentRepo.findAll(limit, offset);
      res.json(agents);
    } catch (error: any) {
      logger.error('Failed to list agents', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async updateAgent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const agent = await this.agentRepo.update(id, req.body);
      
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json(agent);
    } catch (error: any) {
      logger.error('Agent update failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async deleteAgent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const deleted = await this.agentRepo.delete(id);
      
      if (!deleted) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.status(204).send();
    } catch (error: any) {
      logger.error('Agent deletion failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}

