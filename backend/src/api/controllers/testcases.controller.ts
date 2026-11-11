/**
 * Test Cases Controller
 */

import { Request, Response } from 'express';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { normalizeStep, normalizeTestCaseInput, validateTestCaseInput } from '../../core/domain/normalize.js';
import logger from '../../infra/logger/index.js';

function listParam(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = arr.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

export class TestCasesController {
  private testCaseRepo = new TestCaseRepository();

  async createTestCase(req: Request, res: Response): Promise<void> {
    try {
      const errors = validateTestCaseInput(req.body);
      if (errors.length) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
      const input = normalizeTestCaseInput(req.body, { author: 'manual' })!;
      const testCase = await this.testCaseRepo.create(input);
      res.status(201).json(testCase);
    } catch (error: any) {
      logger.error('Test case creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async getTestCase(req: Request, res: Response): Promise<void> {
    try {
      const testCase = await this.testCaseRepo.findById(req.params.id);
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
      const testCases = await this.testCaseRepo.search({
        module: listParam(req.query.module),
        priority: listParam(req.query.priority),
        type: listParam(req.query.type),
        tags: listParam(req.query.tags),
        documentId: (req.query.documentId as string) || undefined,
        q: (req.query.q as string) || undefined,
        limit: Math.min(parseInt(req.query.limit as string) || 500, 2000),
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(testCases);
    } catch (error: any) {
      logger.error('Failed to list test cases', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async listModules(_req: Request, res: Response): Promise<void> {
    try {
      const all = await this.testCaseRepo.search({ limit: 5000 });
      const counts = new Map<string, number>();
      all.forEach((tc) => counts.set(tc.module, (counts.get(tc.module) ?? 0) + 1));
      res.json([...counts.entries()].map(([module, count]) => ({ module, count })).sort((a, b) => a.module.localeCompare(b.module)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async updateTestCase(req: Request, res: Response): Promise<void> {
    try {
      const errors = validateTestCaseInput(req.body, true);
      if (errors.length) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
      const body = { ...req.body };
      if (Array.isArray(body.steps)) {
        body.steps = body.steps.map(normalizeStep).filter(Boolean);
      }
      const testCase = await this.testCaseRepo.update(req.params.id, body);
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
      const deleted = await this.testCaseRepo.delete(req.params.id);
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
