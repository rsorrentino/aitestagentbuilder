/**
 * Agents Controller
 */
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { AiTestGeneratorService } from '../../modules/agents/services/ai-test-generator.service.js';
import logger from '../../infra/logger/index.js';
export class AgentsController {
    agentRepo = new AgentRepository();
    testGenerator = new AiTestGeneratorService();
    async createAgent(req, res) {
        try {
            const input = req.body;
            // Validate required fields
            if (!input.name || !input.config) {
                res.status(400).json({ error: 'Name and config are required' });
                return;
            }
            const agent = await this.agentRepo.create(input);
            res.status(201).json(agent);
        }
        catch (error) {
            logger.error('Agent creation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async getAgent(req, res) {
        try {
            const { id } = req.params;
            const agent = await this.agentRepo.findById(id);
            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }
            res.json(agent);
        }
        catch (error) {
            logger.error('Failed to fetch agent', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async listAgents(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;
            const agents = await this.agentRepo.findAll(limit, offset);
            res.json(agents);
        }
        catch (error) {
            logger.error('Failed to list agents', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async updateAgent(req, res) {
        try {
            const { id } = req.params;
            const agent = await this.agentRepo.update(id, req.body);
            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }
            res.json(agent);
        }
        catch (error) {
            logger.error('Agent update failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async deleteAgent(req, res) {
        try {
            const { id } = req.params;
            const deleted = await this.agentRepo.delete(id);
            if (!deleted) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }
            res.status(204).send();
        }
        catch (error) {
            logger.error('Agent deletion failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * POST /api/v1/agents/:id/generate-tests
     * Uses the configured LLM to generate test cases for the agent's target URL.
     */
    async generateTests(req, res) {
        try {
            const { id } = req.params;
            const agent = await this.agentRepo.findById(id);
            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }
            const { description, count, modules } = req.body;
            const tests = await this.testGenerator.generateTests({
                targetUrl: agent.config.base_url,
                description: description || `Generate tests for ${agent.name}`,
                count: count ?? 5,
                modules: modules ?? agent.config.test_selection?.module,
            });
            res.json({ agentId: id, tests, count: tests.length });
        }
        catch (error) {
            logger.error('Test generation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=agents.controller.js.map