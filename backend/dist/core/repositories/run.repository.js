/**
 * Test Run Repository
 */
import getDatabaseClient from '../../infra/db/client.js';
export class RunRepository {
    db = getDatabaseClient();
    async createRun(input) {
        const id = `RUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        const query = `
      INSERT INTO runs (
        id, agent_id, status, started_at, total_tests, passed_tests, failed_tests, skipped_tests, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
        const result = await this.db.query(query, [
            id,
            input.agentId,
            'pending',
            now,
            0,
            0,
            0,
            0,
            input.metadata ? JSON.stringify(input.metadata) : null,
        ]);
        return this.mapRowToRun(result.rows[0], []);
    }
    async findRunById(id) {
        const runQuery = 'SELECT * FROM runs WHERE id = $1';
        const runResult = await this.db.query(runQuery, [id]);
        if (runResult.rows.length === 0)
            return null;
        const results = await this.findResultsByRunId(id);
        return this.mapRowToRun(runResult.rows[0], results);
    }
    async updateRun(id, input) {
        const updates = [];
        const values = [];
        let paramCount = 1;
        if (input.status !== undefined) {
            updates.push(`status = $${paramCount++}`);
            values.push(input.status);
        }
        if (input.finishedAt !== undefined) {
            updates.push(`finished_at = $${paramCount++}`);
            values.push(input.finishedAt);
        }
        if (input.metadata !== undefined) {
            updates.push(`metadata = $${paramCount++}`);
            values.push(JSON.stringify(input.metadata));
        }
        if (updates.length > 0) {
            values.push(id);
            const query = `
        UPDATE runs 
        SET ${updates.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;
            const result = await this.db.query(query, values);
            if (result.rows.length === 0)
                return null;
            const results = await this.findResultsByRunId(id);
            return this.mapRowToRun(result.rows[0], results);
        }
        return this.findRunById(id);
    }
    async updateRunStats(id) {
        const statsQuery = `
      SELECT 
        COUNT(*) as total_tests,
        COUNT(*) FILTER (WHERE status = 'passed') as passed_tests,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'error') as failed_tests,
        COUNT(*) FILTER (WHERE status = 'skipped') as skipped_tests
      FROM results
      WHERE run_id = $1
    `;
        const stats = await this.db.query(statsQuery, [id]);
        if (stats.rows.length > 0) {
            const row = stats.rows[0];
            await this.db.query(`UPDATE runs SET total_tests = $1, passed_tests = $2, failed_tests = $3, skipped_tests = $4 WHERE id = $5`, [
                parseInt(row.total_tests),
                parseInt(row.passed_tests),
                parseInt(row.failed_tests),
                parseInt(row.skipped_tests),
                id,
            ]);
        }
    }
    async createResult(input) {
        const id = `RESULT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const query = `
      INSERT INTO results (
        id, run_id, test_case_id, status, started_at, logs, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
        const result = await this.db.query(query, [
            id,
            input.runId,
            input.testCaseId,
            input.status,
            input.startedAt,
            input.logs ? JSON.stringify(input.logs) : null,
            input.error || null,
        ]);
        return this.mapRowToResult(result.rows[0]);
    }
    async updateResult(id, input) {
        const updates = [];
        const values = [];
        let paramCount = 1;
        if (input.status !== undefined) {
            updates.push(`status = $${paramCount++}`);
            values.push(input.status);
        }
        if (input.finishedAt !== undefined) {
            updates.push(`finished_at = $${paramCount++}`);
            values.push(input.finishedAt);
        }
        if (input.duration !== undefined) {
            updates.push(`duration = $${paramCount++}`);
            values.push(input.duration);
        }
        if (input.logs !== undefined) {
            updates.push(`logs = $${paramCount++}`);
            values.push(JSON.stringify(input.logs));
        }
        if (input.error !== undefined) {
            updates.push(`error = $${paramCount++}`);
            values.push(input.error);
        }
        if (input.evidence !== undefined) {
            updates.push(`evidence = $${paramCount++}`);
            values.push(JSON.stringify(input.evidence));
        }
        if (input.validationResults !== undefined) {
            updates.push(`validation_results = $${paramCount++}`);
            values.push(JSON.stringify(input.validationResults));
        }
        if (updates.length === 0) {
            return this.findResultById(id);
        }
        values.push(id);
        const query = `
      UPDATE results 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
        const result = await this.db.query(query, values);
        if (result.rows.length === 0)
            return null;
        return this.mapRowToResult(result.rows[0]);
    }
    async findResultById(id) {
        const query = 'SELECT * FROM results WHERE id = $1';
        const result = await this.db.query(query, [id]);
        if (result.rows.length === 0)
            return null;
        return this.mapRowToResult(result.rows[0]);
    }
    async findResultsByRunId(runId) {
        const query = 'SELECT * FROM results WHERE run_id = $1 ORDER BY started_at ASC';
        const result = await this.db.query(query, [runId]);
        return result.rows.map(row => this.mapRowToResult(row));
    }
    async findByAgentId(agentId, limit = 50) {
        const query = 'SELECT * FROM runs WHERE agent_id = $1 ORDER BY started_at DESC LIMIT $2';
        const result = await this.db.query(query, [agentId, limit]);
        const runs = [];
        for (const row of result.rows) {
            const results = await this.findResultsByRunId(row.id);
            runs.push(this.mapRowToRun(row, results));
        }
        return runs;
    }
    async findAll(limit = 50) {
        const query = 'SELECT * FROM runs ORDER BY started_at DESC LIMIT $1';
        const result = await this.db.query(query, [limit]);
        const runs = [];
        for (const row of result.rows) {
            const results = await this.findResultsByRunId(row.id);
            runs.push(this.mapRowToRun(row, results));
        }
        return runs;
    }
    mapRowToRun(row, results) {
        const finishedAt = row.finished_at ? new Date(row.finished_at) : undefined;
        const startedAt = new Date(row.started_at);
        const duration = finishedAt ? finishedAt.getTime() - startedAt.getTime() : undefined;
        return {
            id: row.id,
            agentId: row.agent_id,
            status: row.status,
            startedAt,
            finishedAt,
            duration,
            totalTests: row.total_tests,
            passedTests: row.passed_tests,
            failedTests: row.failed_tests,
            skippedTests: row.skipped_tests,
            results,
            metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
        };
    }
    mapRowToResult(row) {
        const finishedAt = row.finished_at ? new Date(row.finished_at) : undefined;
        const startedAt = new Date(row.started_at);
        const duration = row.duration || (finishedAt ? finishedAt.getTime() - startedAt.getTime() : undefined);
        return {
            id: row.id,
            runId: row.run_id,
            testCaseId: row.test_case_id,
            status: row.status,
            startedAt,
            finishedAt,
            duration,
            logs: row.logs ? (typeof row.logs === 'string' ? JSON.parse(row.logs) : row.logs) : undefined,
            error: row.error,
            evidence: row.evidence ? (typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence) : undefined,
            validationResults: row.validation_results
                ? (typeof row.validation_results === 'string' ? JSON.parse(row.validation_results) : row.validation_results)
                : undefined,
            metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
        };
    }
}
//# sourceMappingURL=run.repository.js.map