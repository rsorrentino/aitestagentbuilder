/**
 * Users (authentication accounts).
 */

import getDatabaseClient from '../../infra/db/client.js';
import { hashPassword } from '../../infra/auth/jwt.service.js';

export type SystemRole = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  name?: string;
  role: SystemRole;
  active: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil?: Date;
  lastLogin?: Date;
  passwordChangedAt?: Date;
  createdAt: Date;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export class UserRepository {
  private db = getDatabaseClient();

  async create(input: { email: string; name?: string; password: string; role?: SystemRole; mustChangePassword?: boolean; id?: string }): Promise<User> {
    const id = input.id ?? `USER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, role, must_change_password, password_changed_at)
       VALUES ($1, LOWER($2), $3, $4, $5, $6, NOW()) RETURNING *`,
      [id, input.email.trim(), input.name ?? null, hashPassword(input.password), input.role ?? 'user', input.mustChangePassword ?? false],
    );
    return this.map(result.rows[0]);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  async findByEmailWithHash(email: string): Promise<UserWithHash | null> {
    const result = await this.db.query('SELECT * FROM users WHERE email = LOWER($1)', [email.trim()]);
    return result.rows.length ? { ...this.map(result.rows[0]), passwordHash: result.rows[0].password_hash } : null;
  }

  async findHashById(id: string): Promise<string | null> {
    const result = await this.db.query('SELECT password_hash FROM users WHERE id = $1', [id]);
    return result.rows[0]?.password_hash ?? null;
  }

  async list(): Promise<User[]> {
    const result = await this.db.query(`SELECT * FROM users WHERE id <> 'local' ORDER BY email`);
    return result.rows.map((r) => this.map(r));
  }

  async update(id: string, input: { name?: string; role?: SystemRole; active?: boolean }): Promise<User | null> {
    const updates: string[] = [];
    const values: any[] = [];
    const set = (c: string, v: any) => { values.push(v); updates.push(`${c} = $${values.length}`); };
    if (input.name !== undefined) set('name', input.name);
    if (input.role !== undefined) set('role', input.role);
    if (input.active !== undefined) set('active', input.active);
    if (!updates.length) return this.findById(id);
    set('updated_at', new Date());
    values.push(id);
    const result = await this.db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    return result.rows.length ? this.map(result.rows[0]) : null;
  }

  async setPassword(id: string, password: string, mustChange: boolean): Promise<void> {
    await this.db.query(
      `UPDATE users SET password_hash = $1, must_change_password = $2, password_changed_at = NOW(),
              failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $3`,
      [hashPassword(password), mustChange, id],
    );
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.db.query('UPDATE users SET last_login = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [id]);
  }

  /** Increments the failure counter; locks the account when `maxAttempts` is reached. */
  async recordLoginFailure(id: string, maxAttempts: number, lockMinutes: number): Promise<{ locked: boolean; lockedUntil?: Date }> {
    const result = await this.db.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1 RETURNING failed_login_count, locked_until`,
      [id, maxAttempts, String(lockMinutes)],
    );
    const row = result.rows[0];
    return { locked: !!row?.locked_until && new Date(row.locked_until) > new Date(), lockedUntil: row?.locked_until ?? undefined };
  }

  async unlock(id: string): Promise<void> {
    await this.db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [id]);
  }

  async countActiveAdmins(): Promise<number> {
    const result = await this.db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> 'local'`);
    return result.rows[0].n;
  }

  /** The identity used when AUTH_ENABLED is off; needed so API keys and memberships can reference it. */
  async ensureLocalUser(): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ('local', 'local@localhost', 'Local user', '!', 'admin')
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  private map(row: any): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name ?? undefined,
      role: row.role === 'admin' ? 'admin' : 'user',
      active: row.active,
      mustChangePassword: !!row.must_change_password,
      failedLoginCount: row.failed_login_count ?? 0,
      lockedUntil: row.locked_until ?? undefined,
      lastLogin: row.last_login ?? undefined,
      passwordChangedAt: row.password_changed_at ?? undefined,
      createdAt: row.created_at,
    };
  }
}
