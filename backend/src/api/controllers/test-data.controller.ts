/**
 * Test Data Controller
 */

import { Request, Response } from 'express';
import { TestDataRepository } from '../../core/repositories/test-data.repository.js';
import { TestDataCreateInput } from '../../core/domain/test-data.js';
import logger from '../../infra/logger/index.js';

export class TestDataController {
  private testDataRepo = new TestDataRepository();

  async createTestData(req: Request, res: Response): Promise<void> {
    try {
      const input: TestDataCreateInput = req.body;
      const testData = await this.testDataRepo.create(input);
      res.status(201).json(testData);
    } catch (error: any) {
      logger.error('Test data creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async getTestData(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const testData = await this.testDataRepo.findById(id);
      
      if (!testData) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }

      res.json(testData);
    } catch (error: any) {
      logger.error('Failed to fetch test data', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async listTestData(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const { environment } = req.query;

      let testData;
      if (environment) {
        testData = await this.testDataRepo.findByEnvironment(environment as string);
      } else {
        testData = await this.testDataRepo.findAll(limit, offset);
      }

      res.json(testData);
    } catch (error: any) {
      logger.error('Failed to list test data', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async updateTestData(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const testData = await this.testDataRepo.update(id, req.body);
      
      if (!testData) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }

      res.json(testData);
    } catch (error: any) {
      logger.error('Test data update failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async deleteTestData(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const deleted = await this.testDataRepo.delete(id);
      
      if (!deleted) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }

      res.status(204).send();
    } catch (error: any) {
      logger.error('Test data deletion failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}

