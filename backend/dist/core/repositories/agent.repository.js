/**
 * Agent Repository
 */
import getDatabaseClient from '../../infra/db/client.js';
export class AgentRepository {
    db = getDatabaseClient();
    async create(input) {
        const id = `AGENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        const query = `
      INSERT INTO agents (id, name, config, status, created_at, updated_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
        const result = await this.db.query(query, [
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
    async findById(id) {
        const query = 'SELECT * FROM agents WHERE id = $1';
        const result = await this.db.query(query, [id]);
        if (result.rows.length === 0)
            return null;
        return this.mapRowToAgent(result.rows[0]);
    }
    async findByName(name) {
        const query = 'SELECT * FROM agents WHERE name = $1';
        const result = await this.db.query(query, [name]);
        if (result.rows.length === 0)
            return null;
        return this.mapRowToAgent(result.rows[0]);
    }
    async findAll(limit = 100, offset = 0) {
        const query = 'SELECT * FROM agents ORDER BY created_at DESC LIMIT $1 OFFSET $2';
        const result = await this.db.query(query, [limit, offset]);
        return result.rows.map(row => this.mapRowToAgent(row));
    }
    async findByStatus(status) {
        const query = 'SELECT * FROM agents WHERE status = $1 ORDER BY created_at DESC';
        const result = await this.db.query(query, [status]);
        return result.rows.map(row => this.mapRowToAgent(row));
    }
    async update(id, input) {
        const updates = [];
        const values = [];
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
        const result = await this.db.query(query, values);
        if (result.rows.length === 0)
            return null;
        return this.mapRowToAgent(result.rows[0]);
    }
    async delete(id) {
        const query = 'DELETE FROM agents WHERE id = $1';
        const result = await this.db.query(query, [id]);
        return result.rowCount !== null && result.rowCount > 0;
    }
    mapRowToAgent(row) {
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
//# sourceMappingURL=agent.repository.js.map