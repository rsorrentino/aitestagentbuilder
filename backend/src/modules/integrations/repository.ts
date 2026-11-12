/**
 * Storage of integrations (secrets encrypted), test ↔ issue links, and the
 * defects filed for failures.
 */

import crypto from 'crypto';
import getDatabaseClient from '../../infra/db/client.js';
import { decryptSecret, REDACTED, sealSecret } from '../../infra/security/secrets.js';
import { Integration, INTEGRATION_SECRETS, IntegrationType } from './types.js';

const newId = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

function seal(type: IntegrationType, next: Record<string, any>, previous?: Record<string, any>): Record<string, any> {
  const out = { ...(previous ?? {}), ...next };
  for (const key of INTEGRATION_SECRETS[type] ?? []) {
    const v = sealSecret(next[key], previous?.[key]);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  return out;
}

export function redactIntegration(i: Integration): Integration {
  const config = { ...i.config };
  for (const key of INTEGRATION_SECRETS[i.type] ?? []) if (config[key]) config[key] = REDACTED;
  return { ...i, config };
}

export class IntegrationRepository {
  private db = getDatabaseClient();

  private map(row: any, decrypt: boolean): Integration & { lastCheck?: any } {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    if (decrypt) for (const key of INTEGRATION_SECRETS[row.type as IntegrationType] ?? []) if (config[key]) config[key] = decryptSecret(String(config[key]));
    return {
      id: row.id, projectId: row.project_id, type: row.type, name: row.name, config, enabled: row.enabled,
      createdAt: row.created_at, createdBy: row.created_by ?? undefined, ...(row.last_check ? { lastCheck: row.last_check } : {}),
    };
  }

  async create(input: { projectId: string; type: IntegrationType; name: string; config: Record<string, any>; createdBy?: string }): Promise<Integration> {
    const res = await this.db.query(
      `INSERT INTO integrations (id, project_id, type, name, config, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId('INT'), input.projectId, input.type, input.name, JSON.stringify(seal(input.type, input.config)), input.createdBy ?? null]);
    return this.map(res.rows[0], false);
  }

  async update(id: string, projectId: string, input: { name?: string; config?: Record<string, any>; enabled?: boolean }): Promise<Integration | null> {
    const row = (await this.db.query('SELECT * FROM integrations WHERE id = $1 AND project_id = $2', [id, projectId])).rows[0];
    if (!row) return null;
    const config = input.config ? seal(row.type, input.config, row.config) : row.config;
    const res = await this.db.query(
      `UPDATE integrations SET name = $1, config = $2, enabled = $3 WHERE id = $4 RETURNING *`,
      [input.name ?? row.name, JSON.stringify(config), input.enabled ?? row.enabled, id]);
    return this.map(res.rows[0], false);
  }

  async get(id: string, projectId?: string, decrypt = false): Promise<(Integration & { lastCheck?: any }) | null> {
    const res = await this.db.query(`SELECT * FROM integrations WHERE id = $1 ${projectId ? 'AND project_id = $2' : ''}`, projectId ? [id, projectId] : [id]);
    return res.rows[0] ? this.map(res.rows[0], decrypt) : null;
  }

  async list(projectId: string, decrypt = false): Promise<Array<Integration & { lastCheck?: any }>> {
    const res = await this.db.query('SELECT * FROM integrations WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return res.rows.map((r) => this.map(r, decrypt));
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM integrations WHERE id = $1 AND project_id = $2', [id, projectId])).rowCount ?? 0) > 0;
  }

  async setCheck(id: string, check: Record<string, any>): Promise<void> {
    await this.db.query('UPDATE integrations SET last_check = $1 WHERE id = $2', [JSON.stringify({ ...check, at: new Date().toISOString() }), id]);
  }
}

export interface TestLink { testCaseId: string; integrationId: string; key: string; url?: string; title?: string }

export class TestLinkRepository {
  private db = getDatabaseClient();

  async add(link: TestLink): Promise<void> {
    await this.db.query(
      `INSERT INTO test_links (test_case_id, integration_id, issue_key, issue_url, issue_title) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (test_case_id, integration_id, issue_key) DO UPDATE SET issue_url = EXCLUDED.issue_url, issue_title = EXCLUDED.issue_title`,
      [link.testCaseId, link.integrationId, link.key, link.url ?? null, link.title ?? null]);
  }

  async remove(testCaseId: string, integrationId: string, key: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM test_links WHERE test_case_id = $1 AND integration_id = $2 AND issue_key = $3', [testCaseId, integrationId, key])).rowCount ?? 0) > 0;
  }

  async forTests(testCaseIds: string[]): Promise<TestLink[]> {
    if (!testCaseIds.length) return [];
    const res = await this.db.query('SELECT * FROM test_links WHERE test_case_id = ANY($1) ORDER BY issue_key', [testCaseIds]);
    return res.rows.map((r) => ({ testCaseId: r.test_case_id, integrationId: r.integration_id, key: r.issue_key, url: r.issue_url ?? undefined, title: r.issue_title ?? undefined }));
  }

  /** Requirement coverage: every linked issue of the project with its tests and their latest result. */
  async coverage(projectId: string): Promise<Array<{ integrationId: string; key: string; url?: string; title?: string; tests: Array<{ id: string; title: string; status: string | null; at: string | null; runId: string | null }> }>> {
    const res = await this.db.query(
      `SELECT l.integration_id, l.issue_key, l.issue_url, l.issue_title, tc.id AS test_id, tc.title AS test_title, last.status, last.started_at, last.run_id
         FROM test_links l
         JOIN integrations i ON i.id = l.integration_id AND i.project_id = $1
         JOIN test_cases tc ON tc.id = l.test_case_id
         LEFT JOIN LATERAL (
           SELECT r.status, r.started_at, r.run_id FROM results r WHERE r.test_case_id = tc.id AND r.status <> 'running'
           ORDER BY r.started_at DESC LIMIT 1
         ) last ON true
        ORDER BY l.issue_key, tc.title`, [projectId]);
    const out = new Map<string, any>();
    for (const r of res.rows) {
      const k = `${r.integration_id}|${r.issue_key}`;
      if (!out.has(k)) out.set(k, { integrationId: r.integration_id, key: r.issue_key, url: r.issue_url ?? undefined, title: r.issue_title ?? undefined, tests: [] });
      out.get(k).tests.push({ id: r.test_id, title: r.test_title, status: r.status ?? null, at: r.started_at ? new Date(r.started_at).toISOString() : null, runId: r.run_id ?? null });
    }
    return [...out.values()];
  }
}

export interface Defect {
  id: string; projectId: string; integrationId: string; agentId: string; signature: string; key: string; url?: string; title?: string;
  status: 'open' | 'resolved'; tests: Array<{ testCaseId: string; title: string }>; firstRunId?: string; lastRunId?: string; occurrences: number;
  lastCommentedAt?: string; createdAt: string; resolvedAt?: string;
}

export class DefectRepository {
  private db = getDatabaseClient();

  private map(r: any): Defect {
    return {
      id: r.id, projectId: r.project_id, integrationId: r.integration_id, agentId: r.agent_id, signature: r.signature, key: r.issue_key,
      url: r.issue_url ?? undefined, title: r.title ?? undefined, status: r.status, tests: r.tests ?? [], firstRunId: r.first_run_id ?? undefined,
      lastRunId: r.last_run_id ?? undefined, occurrences: r.occurrences, lastCommentedAt: r.last_commented_at ? new Date(r.last_commented_at).toISOString() : undefined,
      createdAt: new Date(r.created_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
    };
  }

  async open(integrationId: string, agentId: string): Promise<Defect[]> {
    const res = await this.db.query(`SELECT * FROM defects WHERE integration_id = $1 AND agent_id = $2 AND status = 'open'`, [integrationId, agentId]);
    return res.rows.map((r) => this.map(r));
  }

  async create(d: Omit<Defect, 'id' | 'status' | 'occurrences' | 'createdAt'>): Promise<Defect> {
    const res = await this.db.query(
      `INSERT INTO defects (id, project_id, integration_id, agent_id, signature, issue_key, issue_url, title, tests, first_run_id, last_run_id, last_commented_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, CURRENT_TIMESTAMP) RETURNING *`,
      [newId('DEF'), d.projectId, d.integrationId, d.agentId, d.signature, d.key, d.url ?? null, d.title ?? null, JSON.stringify(d.tests), d.firstRunId ?? null]);
    return this.map(res.rows[0]);
  }

  async seenAgain(id: string, runId: string, tests: Defect['tests'], commented: boolean): Promise<void> {
    await this.db.query(
      `UPDATE defects SET occurrences = occurrences + 1, last_run_id = $2, tests = $3 ${commented ? ', last_commented_at = CURRENT_TIMESTAMP' : ''} WHERE id = $1`,
      [id, runId, JSON.stringify(tests)]);
  }

  async resolve(id: string, runId: string): Promise<void> {
    await this.db.query(`UPDATE defects SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, last_run_id = $2 WHERE id = $1`, [id, runId]);
  }

  async list(projectId: string, opts: { status?: string; agentId?: string; limit?: number } = {}): Promise<Defect[]> {
    const res = await this.db.query(
      `SELECT * FROM defects WHERE project_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY created_at DESC LIMIT $4`, [projectId, opts.status ?? null, opts.agentId ?? null, opts.limit ?? 200]);
    return res.rows.map((r) => this.map(r));
  }

  async forRun(runId: string): Promise<Defect[]> {
    const res = await this.db.query(`SELECT * FROM defects WHERE first_run_id = $1 OR last_run_id = $1 ORDER BY created_at`, [runId]);
    return res.rows.map((r) => this.map(r));
  }
}
