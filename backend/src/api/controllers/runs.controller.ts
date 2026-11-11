/**
 * Test Runs Controller
 */

import { Request, Response } from 'express';
import { OrchestratorService, RunValidationError } from '../../modules/orchestration/services/orchestrator.service.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import logger from '../../infra/logger/index.js';

function sendError(res: Response, error: any, fallback: string): void {
  if (error instanceof RunValidationError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error(fallback, { error: error.message });
  res.status(500).json({ error: error.message });
}

export class RunsController {
  private runRepo = new RunRepository();

  private get orchestrator() {
    return OrchestratorService.get();
  }

  async startRun(req: Request, res: Response): Promise<void> {
    try {
      const { agentId, testIds, metadata } = req.body ?? {};
      if (!agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      const run = await this.orchestrator.startRun({
        agentId,
        testIds: Array.isArray(testIds) ? testIds : undefined,
        metadata,
      });
      res.status(201).json(run);
    } catch (error: any) {
      sendError(res, error, 'Run start failed');
    }
  }

  async getRun(req: Request, res: Response): Promise<void> {
    try {
      const run = await this.orchestrator.getRunStatus(req.params.id);
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json(run);
    } catch (error: any) {
      sendError(res, error, 'Failed to fetch run');
    }
  }

  async cancelRun(req: Request, res: Response): Promise<void> {
    try {
      res.json(await this.orchestrator.cancelRun(req.params.id));
    } catch (error: any) {
      sendError(res, error, 'Run cancellation failed');
    }
  }

  async listRuns(req: Request, res: Response): Promise<void> {
    try {
      const { agentId } = req.query;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const runs = agentId
        ? await this.runRepo.findByAgentId(agentId as string, limit)
        : await this.runRepo.findAll(limit);
      res.json(runs);
    } catch (error: any) {
      sendError(res, error, 'Failed to list runs');
    }
  }

  async stats(_req: Request, res: Response): Promise<void> {
    res.json(this.orchestrator.getConcurrencyStats());
  }
}
