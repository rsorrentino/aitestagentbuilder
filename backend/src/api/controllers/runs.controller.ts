/**
 * Test Runs Controller
 */

import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { OrchestratorService, RunValidationError } from '../../modules/orchestration/services/orchestrator.service.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import logger from '../../infra/logger/index.js';
import { runEvents } from '../../modules/automation/run-events.js';
import { signRunArtifacts } from '../../infra/security/signed-urls.js';

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
  private agentRepo = new AgentRepository();

  private get orchestrator() {
    return OrchestratorService.get();
  }

  async startRun(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { agentId, testIds, metadata, baseUrl } = req.body ?? {};
      if (!agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      const run = await this.orchestrator.startRun({
        agentId,
        projectId: req.project!.id,
        testIds: Array.isArray(testIds) ? testIds : undefined,
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
        metadata: { ...(metadata ?? {}), triggeredBy: metadata?.triggeredBy ?? (req.apiKey ? 'api' : 'user'), startedBy: req.user?.email },
      });
      res.locals.audit = { entityId: run.id, details: { agentId, tests: run.totalTests } };

      // CI mode: block until the run finishes (or the timeout elapses)
      const wait = req.body?.wait === true || req.query.wait === 'true' || req.query.wait === '1';
      if (!wait) {
        res.status(201).json(run);
        return;
      }
      const timeoutSeconds = Math.min(Math.max(Number(req.body?.timeoutSeconds ?? req.query.timeoutSeconds ?? 1800) || 1800, 10), 7200);
      req.setTimeout(0);
      res.setTimeout(0);
      const finished = runEvents.waitForFinish(run.id, timeoutSeconds * 1000);
      const already = await this.runRepo.findRunById(run.id);
      const done = already && !['pending', 'running'].includes(already.status) ? already : await finished;
      if (!done) {
        const current = await this.runRepo.findRunById(run.id);
        res.status(202).json({ ...current, timedOut: true, passed: false });
        return;
      }
      const full = await this.runRepo.findRunById(run.id);
      res.status(200).json({ ...signRunArtifacts(full), passed: full?.status === 'completed' });
    } catch (error: any) {
      sendError(res, error, 'Run start failed');
    }
  }

  async getRun(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const run = await this.orchestrator.getRunStatus(req.params.id, req.project!.id);
      if (!run) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json(signRunArtifacts(run));
    } catch (error: any) {
      sendError(res, error, 'Failed to fetch run');
    }
  }

  async cancelRun(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json(await this.orchestrator.cancelRun(req.params.id, req.project!.id));
    } catch (error: any) {
      sendError(res, error, 'Run cancellation failed');
    }
  }

  async listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { agentId } = req.query;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      if (agentId && !(await this.agentRepo.findById(String(agentId), req.project!.id))) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const runs = agentId
        ? await this.runRepo.findByAgentId(agentId as string, limit)
        : await this.runRepo.findAll(req.project!.id, limit);
      res.json(runs);
    } catch (error: any) {
      sendError(res, error, 'Failed to list runs');
    }
  }

  async stats(_req: Request, res: Response): Promise<void> {
    res.json(this.orchestrator.getConcurrencyStats());
  }
}
