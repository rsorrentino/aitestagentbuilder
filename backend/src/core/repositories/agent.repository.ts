/**
 * Agent Repository
 */

import getDatabaseClient from '../../infra/db/client.js';
import { Agent, AgentCreateInput, AgentUpdateInput } from '../domain/agent.js';

export class AgentRepository {
  private db = getDatabaseClient();

  async create(input: AgentCreateInput): Promise<Agent> {
    const id = `AGENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const query = `
      INSERT INTO agents (id, name, config, status, created_at, updated_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const result = await this.db.query<Agent>(query, [
      id,
      input.name,
      JSON.stringify(input.config),
      'active',
      now,
      now,
      input.createdBy || null,
    ]);

    return this.mapRowToAgent(result.rows[0]);
  }

  async findById(id: string): Promise<Agent | null> {
    const query = 'SELECT * FROM agents WHERE id = $1';
    const result = await this.db.query<Agent>(query, [id]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToAgent(result.rows[0]);
  }

  async findByName(name: string): Promise<Agent | null> {
    const query = 'SELECT * FROM agents WHERE name = $1';
    const result = await this.db.query<Agent>(query, [name]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToAgent(result.rows[0]);
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Agent[]> {
    const query = 'SELECT * FROM agents ORDER BY created_at DESC LIMIT $1 OFFSET $2';
    const result = await this.db.query<Agent>(query, [limit, offset]);
    return result.rows.map(row => this.mapRowToAgent(row));
  }

  async findByStatus(status: string): Promise<Agent[]> {
    const query = 'SELECT * FROM agents WHERE status = $1 ORDER BY created_at DESC';
    const result = await this.db.query<Agent>(query, [status]);
    return result.rows.map(row => this.mapRowToAgent(row));
  }

  async update(id: string, input: AgentUpdateInput): Promise<Agent | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(input.name);
    }
    if (input.config !== undefined) {
      updates.push(`config = $${paramCount++}`);
      values.push(JSON.stringify(input.config));
    }
    if (input.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(input.status);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push(`updated_at = $${paramCount++}`);
    values.push(new Date());
    values.push(id);

    const query = `
      UPDATE agents 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await this.db.query<Agent>(query, values);
    if (result.rows.length === 0) return null;
    return this.mapRowToAgent(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const query = 'DELETE FROM agents WHERE id = $1';
    const result = await this.db.query(query, [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  private mapRowToAgent(row: any): Agent {
    return {
      id: row.id,
      name: row.name,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }
}

