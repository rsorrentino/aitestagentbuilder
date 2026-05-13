/**
 * Test Cases Controller
 */

import { Request, Response } from 'express';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { TestCaseCreateInput } from '../../core/domain/test-case.js';
import logger from '../../infra/logger/index.js';

export class TestCasesController {
  private testCaseRepo = new TestCaseRepository();

  async createTestCase(req: Request, res: Response): Promise<void> {
    try {
      const input: TestCaseCreateInput = req.body;
      const testCase = await this.testCaseRepo.create(input);
      res.status(201).json(testCase);
    } catch (error: any) {
      logger.error('Test case creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async getTestCase(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const testCase = await this.testCaseRepo.findById(id);
      
      if (!testCase) {
        res.status(404).json({ error: 'Test case not found' });
        return;
      }

      res.json(testCase);
    } catch (error: any) {
      logger.error('Failed to fetch test case', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async listTestCases(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const { module, priority } = req.query;

      let testCases;
      if (module) {
        testCases = await this.testCaseRepo.findByModule(module as string);
      } else if (priority) {
        testCases = await this.testCaseRepo.findByPriority(priority as string);
      } else {
        testCases = await this.testCaseRepo.findAll(limit, offset);
      }

      res.json(testCases);
    } catch (error: any) {
      logger.error('Failed to list test cases', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async updateTestCase(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const testCase = await this.testCaseRepo.update(id, req.body);
      
      if (!testCase) {
        res.status(404).json({ error: 'Test case not found' });
        return;
      }

      res.json(testCase);
    } catch (error: any) {
      logger.error('Test case update failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async deleteTestCase(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const deleted = await this.testCaseRepo.delete(id);
      
      if (!deleted) {
        res.status(404).json({ error: 'Test case not found' });
        return;
      }

      res.status(204).send();
    } catch (error: any) {
      logger.error('Test case deletion failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}

