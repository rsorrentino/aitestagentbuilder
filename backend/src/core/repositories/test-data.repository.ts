/**
 * Test Data Repository (project-scoped).
 */

import getDatabaseClient from '../../infra/db/client.js';
import { TestDataSet, TestDataCreateInput, TestDataUpdateInput } from '../domain/test-data.js';

export class TestDataRepository {
  private db = getDatabaseClient();

  async create(input: TestDataCreateInput & { projectId: string }): Promise<TestDataSet> {
    const id = `DATA-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO test_data (id, name, description, data, tags, environment, created_at, updated_at, created_by, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9) RETURNING *`,
      [
        id,
        input.name,
        input.description || null,
        JSON.stringify(input.data),
        input.tags ? JSON.stringify(input.tags) : null,
        input.environment || null,
        now,
        input.createdBy || null,
        input.projectId,
      ],
    );
    return this.map(result.rows[0]);
  }

  async findById(id: string, projectId: string): Promise<TestDataSet | null> {
    const result = await this.db.query('SELECT * FROM test_data WHERE id = $1 AND project_id = $2', [id, projectId]);
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  /** A data set by id, or by name (the newest; one for the environment first when given). */
  async findByIdOrName(ref: string, projectId: string, environment?: string): Promise<TestDataSet | null> {
    const byId = await this.findById(ref, projectId);
    if (byId) return byId;
    const result = await this.db.query(
      `SELECT * FROM test_data WHERE project_id = $1 AND name = $2
        ORDER BY (environment IS NOT DISTINCT FROM $3) DESC, (environment IS NULL) DESC, created_at DESC LIMIT 1`,
      [projectId, ref, environment ?? null],
    );
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  async findAll(projectId: string, opts: { environment?: string; limit?: number; offset?: number } = {}): Promise<TestDataSet[]> {
    const values: any[] = [projectId, opts.limit ?? 100, opts.offset ?? 0];
    let where = 'project_id = $1';
    if (opts.environment) {
      values.push(opts.environment);
      where += ` AND environment = $${values.length}`;
    }
    const result = await this.db.query(
      `SELECT * FROM test_data WHERE ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      values,
    );
    return result.rows.map((row) => this.map(row));
  }

  async update(id: string, input: TestDataUpdateInput, projectId: string): Promise<TestDataSet | null> {
    const updates: string[] = [];
    const values: any[] = [];
    const set = (col: string, v: any) => { values.push(v); updates.push(`${col} = $${values.length}`); };
    if (input.name !== undefined) set('name', input.name);
    if (input.description !== undefined) set('description', input.description);
    if (input.data !== undefined) set('data', JSON.stringify(input.data));
    if (input.tags !== undefined) set('tags', JSON.stringify(input.tags));
    if (input.environment !== undefined) set('environment', input.environment);
    if (updates.length === 0) return this.findById(id, projectId);
    set('updated_at', new Date());
    values.push(id, projectId);
    const result = await this.db.query(
      `UPDATE test_data SET ${updates.join(', ')} WHERE id = $${values.length - 1} AND project_id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM test_data WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (result.rowCount ?? 0) > 0;
  }

  private map(row: any): TestDataSet {
    const json = (v: any) => (v == null ? undefined : typeof v === 'string' ? JSON.parse(v) : v);
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      data: json(row.data) ?? {},
      tags: json(row.tags),
      environment: row.environment ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by ?? undefined,
    };
  }
}
