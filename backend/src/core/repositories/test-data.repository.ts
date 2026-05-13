/**
 * Test Data Repository
 */

import getDatabaseClient from '../../infra/db/client.js';
import { TestDataSet, TestDataCreateInput, TestDataUpdateInput } from '../domain/test-data.js';

export class TestDataRepository {
  private db = getDatabaseClient();

  async create(input: TestDataCreateInput): Promise<TestDataSet> {
    const id = `DATA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    // First, ensure test_data table exists
    await this.ensureTableExists();

    const query = `
      INSERT INTO test_data (
        id, name, description, data, tags, environment, created_at, updated_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const result = await this.db.query(query, [
      id,
      input.name,
      input.description || null,
      JSON.stringify(input.data),
      input.tags ? JSON.stringify(input.tags) : null,
      input.environment || null,
      now,
      now,
      input.createdBy || null,
    ]);

    return this.mapRowToDataSet(result.rows[0]);
  }

  async findById(id: string): Promise<TestDataSet | null> {
    await this.ensureTableExists();
    const query = 'SELECT * FROM test_data WHERE id = $1';
    const result = await this.db.query(query, [id]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToDataSet(result.rows[0]);
  }

  async findByName(name: string): Promise<TestDataSet | null> {
    await this.ensureTableExists();
    const query = 'SELECT * FROM test_data WHERE name = $1';
    const result = await this.db.query(query, [name]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToDataSet(result.rows[0]);
  }

  async findByEnvironment(environment: string): Promise<TestDataSet[]> {
    await this.ensureTableExists();
    const query = 'SELECT * FROM test_data WHERE environment = $1 ORDER BY created_at DESC';
    const result = await this.db.query(query, [environment]);
    return result.rows.map(row => this.mapRowToDataSet(row));
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<TestDataSet[]> {
    await this.ensureTableExists();
    const query = 'SELECT * FROM test_data ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    const result = await this.db.query(query, [limit, offset]);
    return result.rows.map(row => this.mapRowToDataSet(row));
  }

  async update(id: string, input: TestDataUpdateInput): Promise<TestDataSet | null> {
    await this.ensureTableExists();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(input.description);
    }
    if (input.data !== undefined) {
      updates.push(`data = $${paramCount++}`);
      values.push(JSON.stringify(input.data));
    }
    if (input.tags !== undefined) {
      updates.push(`tags = $${paramCount++}`);
      values.push(input.tags ? JSON.stringify(input.tags) : null);
    }
    if (input.environment !== undefined) {
      updates.push(`environment = $${paramCount++}`);
      values.push(input.environment);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push(`updated_at = $${paramCount++}`);
    values.push(new Date());
    values.push(id);

    const query = `
      UPDATE test_data 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await this.db.query(query, values);
    if (result.rows.length === 0) return null;
    return this.mapRowToDataSet(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureTableExists();
    const query = 'DELETE FROM test_data WHERE id = $1';
    const result = await this.db.query(query, [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  private async ensureTableExists(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS test_data (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        data JSONB NOT NULL,
        tags JSONB,
        environment VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_test_data_name ON test_data(name);
      CREATE INDEX IF NOT EXISTS idx_test_data_environment ON test_data(environment);
    `;
    await this.db.query(createTableQuery);
  }

  private mapRowToDataSet(row: any): TestDataSet {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : undefined,
      environment: row.environment,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }
}

