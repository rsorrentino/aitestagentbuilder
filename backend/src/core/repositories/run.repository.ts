/**
 * Test Run Repository
 */

import getDatabaseClient from '../../infra/db/client.js';
import { TestRun, TestRunCreateInput, TestRunUpdateInput, TestResult, TestResultCreateInput, TestResultUpdateInput } from '../domain/run.js';

export class RunRepository {
  private db = getDatabaseClient();

  async createRun(input: TestRunCreateInput): Promise<TestRun> {
    const id = `RUN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const query = `
      INSERT INTO runs (
        id, agent_id, status, started_at, total_tests, passed_tests, failed_tests, skipped_tests, metadata, project_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      input.projectId || 'default',
    ]);

    return this.mapRowToRun(result.rows[0], []);
  }

  async findRunById(id: string, projectId?: string): Promise<TestRun | null> {
    const runQuery = 'SELECT r.*, a.name AS agent_name FROM runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = $1'
      + (projectId ? ' AND r.project_id = $2' : '');
    const runResult = await this.db.query(runQuery, projectId ? [id, projectId] : [id]);
    
    if (runResult.rows.length === 0) return null;

    const results = await this.findResultsByRunId(id);
    return this.mapRowToRun(runResult.rows[0], results);
  }

  async updateRun(id: string, input: TestRunUpdateInput): Promise<TestRun | null> {
    const updates: string[] = [];
    const values: any[] = [];
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
      // merge with existing metadata
      updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${paramCount++}::jsonb`);
      values.push(JSON.stringify(input.metadata));
    }
    if (input.totalTests !== undefined) {
      updates.push(`total_tests = $${paramCount++}`);
      values.push(input.totalTests);
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
      if (result.rows.length === 0) return null;
      
      const results = await this.findResultsByRunId(id);
      return this.mapRowToRun(result.rows[0], results);
    }

    return this.findRunById(id);
  }

  /**
   * Recompute pass/fail counters from the latest attempt of each test case.
   * total_tests keeps the planned count when it is larger.
   */
  async updateRunStats(id: string): Promise<void> {
    const statsQuery = `
      WITH latest AS (
        SELECT DISTINCT ON (test_case_id) status
        FROM results
        WHERE run_id = $1
        ORDER BY test_case_id, started_at DESC
      )
      SELECT
        COUNT(*) as total_tests,
        COUNT(*) FILTER (WHERE status = 'passed') as passed_tests,
        COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'timeout')) as failed_tests,
        COUNT(*) FILTER (WHERE status = 'skipped') as skipped_tests
      FROM latest
    `;
    const stats = await this.db.query(statsQuery, [id]);
    const row = stats.rows[0];
    await this.db.query(
      `UPDATE runs SET total_tests = GREATEST(total_tests, $1), passed_tests = $2, failed_tests = $3, skipped_tests = $4 WHERE id = $5`,
      [
        parseInt(row.total_tests),
        parseInt(row.passed_tests),
        parseInt(row.failed_tests),
        parseInt(row.skipped_tests),
        id,
      ]
    );
  }

  async createResult(input: TestResultCreateInput): Promise<TestResult> {
    const id = `RESULT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const query = `
      INSERT INTO results (
        id, run_id, test_case_id, status, started_at, logs, error, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]);

    return this.mapRowToResult(result.rows[0]);
  }

  async updateResult(id: string, input: TestResultUpdateInput): Promise<TestResult | null> {
    const updates: string[] = [];
    const values: any[] = [];
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
    if (input.metadata !== undefined) {
      updates.push(`metadata = $${paramCount++}`);
      values.push(JSON.stringify(input.metadata));
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
    if (result.rows.length === 0) return null;
    return this.mapRowToResult(result.rows[0]);
  }

  async findResultById(id: string): Promise<TestResult | null> {
    const query = 'SELECT * FROM results WHERE id = $1';
    const result = await this.db.query(query, [id]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToResult(result.rows[0]);
  }

  async findResultsByRunId(runId: string): Promise<TestResult[]> {
    const query = 'SELECT * FROM results WHERE run_id = $1 ORDER BY started_at ASC';
    const result = await this.db.query(query, [runId]);
    return result.rows.map(row => this.mapRowToResult(row));
  }

  /** Run summaries (without per-test results), newest first. */
  async findByAgentId(agentId: string, limit: number = 50): Promise<TestRun[]> {
    const result = await this.db.query(
      `SELECT r.*, a.name AS agent_name FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.agent_id = $1 ORDER BY r.started_at DESC LIMIT $2`,
      [agentId, limit],
    );
    return result.rows.map(row => this.mapRowToRun(row, []));
  }

  /** Run summaries (without per-test results), newest first. */
  async findAll(projectId: string, limit: number = 50): Promise<TestRun[]> {
    const result = await this.db.query(
      `SELECT r.*, a.name AS agent_name FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.project_id = $2 ORDER BY r.started_at DESC LIMIT $1`,
      [limit, projectId],
    );
    return result.rows.map(row => this.mapRowToRun(row, []));
  }

  /** Runs left in pending/running state by a previous process are marked failed. */
  async failInterruptedRuns(): Promise<number> {
    const result = await this.db.query(
      `UPDATE runs SET status = 'failed', finished_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || '{"error": "Interrupted: the server restarted while the run was in progress"}'::jsonb
        WHERE status IN ('pending', 'running')`,
    );
    await this.db.query(`UPDATE results SET status = 'error', error = 'Interrupted by server restart', finished_at = NOW() WHERE status = 'running'`);
    return result.rowCount ?? 0;
  }

  private mapRowToRun(row: any, results: TestResult[]): TestRun {
    const finishedAt = row.finished_at ? new Date(row.finished_at) : undefined;
    const startedAt = new Date(row.started_at);
    const duration = finishedAt ? finishedAt.getTime() - startedAt.getTime() : Date.now() - startedAt.getTime();

    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name ?? undefined,
      projectId: row.project_id,
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

  private mapRowToResult(row: any): TestResult {
    const finishedAt = row.finished_at ? new Date(row.finished_at) : undefined;
    const startedAt = new Date(row.started_at);
    const duration = (row.duration !== null && row.duration !== undefined ? Number(row.duration) : undefined) ?? (finishedAt ? finishedAt.getTime() - startedAt.getTime() : undefined);

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

