/**
 * Test Data Controller (project-scoped named data sets).
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { TestDataRepository } from '../../core/repositories/test-data.repository.js';

export class TestDataController {
  private repo = new TestDataRepository();

  async createTestData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name, description, data, tags, environment } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        res.status(400).json({ error: 'data must be a JSON object' });
        return;
      }
      const created = await this.repo.create({
        name, description, data, tags, environment, createdBy: req.user?.email, projectId: req.project!.id,
      });
      res.locals.audit = { entityId: created.id, details: { name } };
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async getTestData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const item = await this.repo.findById(req.params.id, req.project!.id);
      if (!item) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async listTestData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json(await this.repo.findAll(req.project!.id, {
        environment: req.query.environment ? String(req.query.environment) : undefined,
        limit: parseInt(req.query.limit as string) || 100,
        offset: parseInt(req.query.offset as string) || 0,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async updateTestData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const updated = await this.repo.update(req.params.id, req.body ?? {}, req.project!.id);
      if (!updated) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async deleteTestData(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await this.repo.delete(req.params.id, req.project!.id))) {
        res.status(404).json({ error: 'Test data not found' });
        return;
      }
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
