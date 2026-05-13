/**
 * Test Runs Controller
 */
import { OrchestratorService } from '../../modules/orchestration/services/orchestrator.service.js';
import { RunRepository } from '../../core/repositories/run.repository.js';
import logger from '../../infra/logger/index.js';
export class RunsController {
    orchestrator = new OrchestratorService();
    runRepo = new RunRepository();
    async startRun(req, res) {
        try {
            const input = req.body;
            if (!input.agentId) {
                res.status(400).json({ error: 'agentId is required' });
                return;
            }
            const run = await this.orchestrator.startRun(input);
            res.status(201).json(run);
        }
        catch (error) {
            logger.error('Run start failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async getRun(req, res) {
        try {
            const { id } = req.params;
            const run = await this.orchestrator.getRunStatus(id);
            if (!run) {
                res.status(404).json({ error: 'Run not found' });
                return;
            }
            res.json(run);
        }
        catch (error) {
            logger.error('Failed to fetch run', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async cancelRun(req, res) {
        try {
            const { id } = req.params;
            await this.orchestrator.cancelRun(id);
            res.status(204).send();
        }
        catch (error) {
            logger.error('Run cancellation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async listRuns(req, res) {
        try {
            const { agentId } = req.query;
            const limit = parseInt(req.query.limit) || 50;
            if (agentId) {
                const runs = await this.runRepo.findByAgentId(agentId, limit);
                res.json(runs);
            }
            else {
                res.status(400).json({ error: 'agentId query parameter is required' });
            }
        }
        catch (error) {
            logger.error('Failed to list runs', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=runs.controller.js.map