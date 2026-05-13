/**
 * Test Cases Controller
 */
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import logger from '../../infra/logger/index.js';
export class TestCasesController {
    testCaseRepo = new TestCaseRepository();
    async createTestCase(req, res) {
        try {
            const input = req.body;
            const testCase = await this.testCaseRepo.create(input);
            res.status(201).json(testCase);
        }
        catch (error) {
            logger.error('Test case creation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async getTestCase(req, res) {
        try {
            const { id } = req.params;
            const testCase = await this.testCaseRepo.findById(id);
            if (!testCase) {
                res.status(404).json({ error: 'Test case not found' });
                return;
            }
            res.json(testCase);
        }
        catch (error) {
            logger.error('Failed to fetch test case', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async listTestCases(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const offset = parseInt(req.query.offset) || 0;
            const { module, priority } = req.query;
            let testCases;
            if (module) {
                testCases = await this.testCaseRepo.findByModule(module);
            }
            else if (priority) {
                testCases = await this.testCaseRepo.findByPriority(priority);
            }
            else {
                testCases = await this.testCaseRepo.findAll(limit, offset);
            }
            res.json(testCases);
        }
        catch (error) {
            logger.error('Failed to list test cases', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async updateTestCase(req, res) {
        try {
            const { id } = req.params;
            const testCase = await this.testCaseRepo.update(id, req.body);
            if (!testCase) {
                res.status(404).json({ error: 'Test case not found' });
                return;
            }
            res.json(testCase);
        }
        catch (error) {
            logger.error('Test case update failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    async deleteTestCase(req, res) {
        try {
            const { id } = req.params;
            const deleted = await this.testCaseRepo.delete(id);
            if (!deleted) {
                res.status(404).json({ error: 'Test case not found' });
                return;
            }
            res.status(204).send();
        }
        catch (error) {
            logger.error('Test case deletion failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=testcases.controller.js.map