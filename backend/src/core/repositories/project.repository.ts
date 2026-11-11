/**
 * Projects and project membership.
 */

import getDatabaseClient from '../../infra/db/client.js';

export type ProjectRole = 'viewer' | 'editor' | 'admin' | 'owner';
export const PROJECT_ROLES: ProjectRole[] = ['viewer', 'editor', 'admin', 'owner'];
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  archived: boolean;
  createdAt: Date;
  createdBy?: string;
  /** Present when listed for a user */
  role?: ProjectRole;
  counts?: { agents: number; testCases: number; runs: number; members: number };
}

export interface ProjectMember {
  userId: string;
  email: string;
  name?: string;
  role: ProjectRole;
  addedAt: Date;
  active: boolean;
}

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}

export class ProjectRepository {
  private db = getDatabaseClient();

  async create(input: { name: string; description?: string; createdBy?: string; slug?: string }): Promise<Project> {
    let slug = input.slug ? slugify(input.slug) : slugify(input.name);
    const taken = await this.db.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (taken.rows.length) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const id = `PRJ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.db.query(
      `INSERT INTO projects (id, name, slug, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, input.name, slug, input.description ?? null, input.createdBy ?? null],
    );
    return this.map(result.rows[0]);
  }

  async findById(id: string): Promise<Project | null> {
    const result = await this.db.query('SELECT * FROM projects WHERE id = $1', [id]);
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  /** Projects visible to a user; system admins see all. */
  async listForUser(userId: string, isSystemAdmin: boolean, includeArchived = false): Promise<Project[]> {
    const counts = `
      (SELECT COUNT(*) FROM agents a WHERE a.project_id = p.id)::int AS agent_count,
      (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id)::int AS test_case_count,
      (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id)::int AS run_count,
      (SELECT COUNT(*) FROM project_members m2 WHERE m2.project_id = p.id)::int AS member_count`;
    const archived = includeArchived ? '' : 'AND NOT p.archived';
    const result = isSystemAdmin
      ? await this.db.query(
          `SELECT p.*, COALESCE(m.role, 'owner') AS role, ${counts} FROM projects p
             LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
            WHERE true ${archived} ORDER BY p.name`, [userId])
      : await this.db.query(
          `SELECT p.*, m.role, ${counts} FROM projects p
             JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
            WHERE true ${archived} ORDER BY p.name`, [userId]);
    return result.rows.map((r) => this.map(r));
  }

  async update(id: string, input: { name?: string; description?: string; archived?: boolean }): Promise<Project | null> {
    const updates: string[] = [];
    const values: any[] = [];
    const set = (c: string, v: any) => { values.push(v); updates.push(`${c} = $${values.length}`); };
    if (input.name !== undefined) set('name', input.name);
    if (input.description !== undefined) set('description', input.description);
    if (input.archived !== undefined) set('archived', input.archived);
    if (!updates.length) return this.findById(id);
    values.push(id);
    const result = await this.db.query(`UPDATE projects SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM projects WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async memberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
    const result = await this.db.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return result.rows[0]?.role ?? null;
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const result = await this.db.query(
      `SELECT m.user_id, m.role, m.added_at, u.email, u.name, u.active
         FROM project_members m JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1 ORDER BY u.email`, [projectId]);
    return result.rows.map((r) => ({
      userId: r.user_id, email: r.email, name: r.name ?? undefined, role: r.role, addedAt: r.added_at, active: r.active,
    }));
  }

  async setMember(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await this.db.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projectId, userId, role],
    );
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async countOwners(projectId: string): Promise<number> {
    const result = await this.db.query(`SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'`, [projectId]);
    return result.rows[0].n;
  }

  private map(row: any): Project {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      archived: row.archived,
      createdAt: row.created_at,
      createdBy: row.created_by ?? undefined,
      ...(row.role ? { role: row.role } : {}),
      ...(row.agent_count !== undefined
        ? { counts: { agents: row.agent_count, testCases: row.test_case_count, runs: row.run_count, members: row.member_count } }
        : {}),
    };
  }
}
