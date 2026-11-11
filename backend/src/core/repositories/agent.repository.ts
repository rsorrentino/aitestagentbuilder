/**
 * Agent Repository (project-scoped; secrets are encrypted before storage).
 */

import getDatabaseClient from '../../infra/db/client.js';
import { Agent, AgentCreateInput, AgentUpdateInput } from '../domain/agent.js';
import { sealAgentConfig } from '../domain/agent-secrets.js';

export class AgentRepository {
  private db = getDatabaseClient();

  async create(input: AgentCreateInput & { projectId: string }): Promise<Agent> {
    const id = `AGENT-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date();
    const result = await this.db.query(
      `INSERT INTO agents (id, name, config, status, created_at, updated_at, created_by, project_id)
       VALUES ($1, $2, $3, 'active', $4, $4, $5, $6) RETURNING *`,
      [id, input.name, JSON.stringify(sealAgentConfig(input.config)), now, input.createdBy || null, input.projectId],
    );
    return this.mapRowToAgent(result.rows[0]);
  }

  /** With `projectId`, only finds the agent inside that project. */
  async findById(id: string, projectId?: string): Promise<Agent | null> {
    const result = projectId
      ? await this.db.query('SELECT * FROM agents WHERE id = $1 AND project_id = $2', [id, projectId])
      : await this.db.query('SELECT * FROM agents WHERE id = $1', [id]);
    return result.rows.length ? this.mapRowToAgent(result.rows[0]) : null;
  }

  async findByName(name: string, projectId: string): Promise<Agent | null> {
    const result = await this.db.query('SELECT * FROM agents WHERE name = $1 AND project_id = $2', [name, projectId]);
    return result.rows.length ? this.mapRowToAgent(result.rows[0]) : null;
  }

  async findAll(projectId: string, limit: number = 100, offset: number = 0): Promise<Agent[]> {
    const result = await this.db.query(
      'SELECT * FROM agents WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [projectId, limit, offset],
    );
    return result.rows.map((row) => this.mapRowToAgent(row));
  }

  async update(id: string, input: AgentUpdateInput, projectId?: string): Promise<Agent | null> {
    const existing = await this.findById(id, projectId);
    if (!existing) return null;

    const updates: string[] = [];
    const values: any[] = [];
    const set = (column: string, value: any) => { values.push(value); updates.push(`${column} = $${values.length}`); };

    if (input.name !== undefined) set('name', input.name);
    if (input.config !== undefined) set('config', JSON.stringify(sealAgentConfig(input.config, existing.config)));
    if (input.status !== undefined) set('status', input.status);
    if (updates.length === 0) return existing;

    set('updated_at', new Date());
    values.push(id);
    const result = await this.db.query(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    return result.rows.length ? this.mapRowToAgent(result.rows[0]) : null;
  }

  async delete(id: string, projectId?: string): Promise<boolean> {
    const result = projectId
      ? await this.db.query('DELETE FROM agents WHERE id = $1 AND project_id = $2', [id, projectId])
      : await this.db.query('DELETE FROM agents WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** All agents (any project) — used by the startup secret re-encryption. */
  async findAllUnscoped(): Promise<Agent[]> {
    const result = await this.db.query('SELECT * FROM agents');
    return result.rows.map((row) => this.mapRowToAgent(row));
  }

  private mapRowToAgent(row: any): Agent {
    return {
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }
}
