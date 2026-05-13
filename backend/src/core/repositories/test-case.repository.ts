/**
 * Test Case Repository
 * Data access layer for test cases
 */

import getDatabaseClient from '../../infra/db/client.js';
import { TestCase, TestCaseCreateInput, TestCaseUpdateInput } from '../domain/test-case.js';

export class TestCaseRepository {
  private db = getDatabaseClient();

  async create(input: TestCaseCreateInput): Promise<TestCase> {
    const id = `TC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const steps = input.steps.map((step, index) => ({
      stepId: index + 1,
      ...step,
    }));

    const query = `
      INSERT INTO test_cases (
        id, title, module, description, steps, expected_results,
        preconditions, postconditions, priority, tags, type, data, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const result = await this.db.query<TestCase>(query, [
      id,
      input.title,
      input.module,
      input.description || null,
      JSON.stringify(steps),
      JSON.stringify(input.expectedResults),
      input.preconditions ? JSON.stringify(input.preconditions) : null,
      input.postconditions ? JSON.stringify(input.postconditions) : null,
      input.priority,
      input.tags ? JSON.stringify(input.tags) : null,
      input.type || null,
      input.data ? JSON.stringify(input.data) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now,
    ]);

    return this.mapRowToTestCase(result.rows[0]);
  }

  async findById(id: string): Promise<TestCase | null> {
    const query = 'SELECT * FROM test_cases WHERE id = $1';
    const result = await this.db.query<TestCase>(query, [id]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToTestCase(result.rows[0]);
  }

  async findByModule(module: string): Promise<TestCase[]> {
    const query = 'SELECT * FROM test_cases WHERE module = $1 ORDER BY created_at DESC';
    const result = await this.db.query<TestCase>(query, [module]);
    return result.rows.map(row => this.mapRowToTestCase(row));
  }

  async findByPriority(priority: string): Promise<TestCase[]> {
    const query = 'SELECT * FROM test_cases WHERE priority = $1 ORDER BY created_at DESC';
    const result = await this.db.query<TestCase>(query, [priority]);
    return result.rows.map(row => this.mapRowToTestCase(row));
  }

  async findByTags(tags: string[]): Promise<TestCase[]> {
    const query = `
      SELECT * FROM test_cases 
      WHERE tags @> $1::jsonb
      ORDER BY created_at DESC
    `;
    const result = await this.db.query<TestCase>(query, [JSON.stringify(tags)]);
    return result.rows.map(row => this.mapRowToTestCase(row));
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<TestCase[]> {
    const query = 'SELECT * FROM test_cases ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    const result = await this.db.query<TestCase>(query, [limit, offset]);
    return result.rows.map(row => this.mapRowToTestCase(row));
  }

  async update(id: string, input: TestCaseUpdateInput): Promise<TestCase | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(input.title);
    }
    if (input.module !== undefined) {
      updates.push(`module = $${paramCount++}`);
      values.push(input.module);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(input.description);
    }
    if (input.steps !== undefined) {
      const steps = input.steps.map((step, index) => ({
        stepId: index + 1,
        ...step,
      }));
      updates.push(`steps = $${paramCount++}`);
      values.push(JSON.stringify(steps));
    }
    if (input.expectedResults !== undefined) {
      updates.push(`expected_results = $${paramCount++}`);
      values.push(JSON.stringify(input.expectedResults));
    }
    if (input.preconditions !== undefined) {
      updates.push(`preconditions = $${paramCount++}`);
      values.push(input.preconditions ? JSON.stringify(input.preconditions) : null);
    }
    if (input.postconditions !== undefined) {
      updates.push(`postconditions = $${paramCount++}`);
      values.push(input.postconditions ? JSON.stringify(input.postconditions) : null);
    }
    if (input.priority !== undefined) {
      updates.push(`priority = $${paramCount++}`);
      values.push(input.priority);
    }
    if (input.tags !== undefined) {
      updates.push(`tags = $${paramCount++}`);
      values.push(input.tags ? JSON.stringify(input.tags) : null);
    }
    if (input.type !== undefined) {
      updates.push(`type = $${paramCount++}`);
      values.push(input.type);
    }
    if (input.data !== undefined) {
      updates.push(`data = $${paramCount++}`);
      values.push(input.data ? JSON.stringify(input.data) : null);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push(`updated_at = $${paramCount++}`);
    values.push(new Date());
    values.push(id);

    const query = `
      UPDATE test_cases 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await this.db.query<TestCase>(query, values);
    if (result.rows.length === 0) return null;
    return this.mapRowToTestCase(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const query = 'DELETE FROM test_cases WHERE id = $1';
    const result = await this.db.query(query, [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async searchByEmbedding(embedding: number[], limit: number = 10): Promise<TestCase[]> {
    const query = `
      SELECT *, 1 - (embedding <=> $1::vector) as similarity
      FROM test_cases
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;
    const result = await this.db.query<TestCase & { similarity: number }>(query, [
      `[${embedding.join(',')}]`,
      limit,
    ]);
    return result.rows.map(row => this.mapRowToTestCase(row));
  }

  async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const query = 'UPDATE test_cases SET embedding = $1::vector WHERE id = $2';
    await this.db.query(query, [`[${embedding.join(',')}]`, id]);
  }

  private mapRowToTestCase(row: any): TestCase {
    return {
      id: row.id,
      title: row.title,
      module: row.module,
      description: row.description,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps,
      expectedResults: typeof row.expected_results === 'string' 
        ? JSON.parse(row.expected_results) 
        : row.expected_results,
      preconditions: row.preconditions 
        ? (typeof row.preconditions === 'string' ? JSON.parse(row.preconditions) : row.preconditions)
        : undefined,
      postconditions: row.postconditions
        ? (typeof row.postconditions === 'string' ? JSON.parse(row.postconditions) : row.postconditions)
        : undefined,
      priority: row.priority,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : undefined,
      type: row.type,
      data: row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : undefined,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
    };
  }
}

