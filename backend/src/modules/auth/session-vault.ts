/**
 * Session vault: browser sessions of login profiles and Salesforce personas
 * (cookies and local storage), encrypted at rest and reused across runs.
 *
 * Reusing the session avoids a login per test, and keeps the "remember this
 * device" cookies that make applications stop asking for MFA. A session is
 * used until it expires (max age of the profile) or the application shows
 * its sign-in page again; then the login runs and the new session is saved.
 */

import type { BrowserContext } from 'playwright';
import getDatabaseClient from '../../infra/db/client.js';
import { decryptSecret, encryptSecret } from '../../infra/security/secrets.js';

export type IdentityKind = 'app' | 'salesforce';

export interface StoredState {
  cookies: Array<Record<string, any>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface SessionInfo {
  agentId: string;
  kind: IdentityKind;
  identity: string;
  capturedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  capturedBy: 'auto' | 'interactive';
  capturedByUser?: string;
  cookies: number;
  expired: boolean;
}

export interface SavedSession extends SessionInfo {
  state: StoredState;
}

const toInfo = (row: any): SessionInfo => ({
  agentId: row.agent_id,
  kind: row.kind,
  identity: row.identity,
  capturedAt: new Date(row.captured_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
  ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).toISOString() } : {}),
  capturedBy: row.captured_by,
  ...(row.captured_by_user ? { capturedByUser: row.captured_by_user } : {}),
  cookies: Number(row.cookies ?? 0),
  expired: new Date(row.expires_at).getTime() <= Date.now(),
});

export class SessionVault {
  private db = getDatabaseClient();

  /** A session that has not expired, or null. */
  async load(agentId: string, kind: IdentityKind, identity: string): Promise<SavedSession | null> {
    const res = await this.db.query(
      `UPDATE auth_sessions SET last_used_at = CURRENT_TIMESTAMP
        WHERE agent_id = $1 AND kind = $2 AND identity = $3 AND expires_at > CURRENT_TIMESTAMP
        RETURNING *`,
      [agentId, kind, identity]);
    const row = res.rows[0];
    if (!row) return null;
    try {
      return { ...toInfo(row), state: JSON.parse(decryptSecret(row.state)) };
    } catch {
      // Unreadable (e.g. the secrets key changed): drop it, a new login replaces it
      await this.forget(agentId, kind, identity);
      return null;
    }
  }

  async save(agentId: string, kind: IdentityKind, identity: string, state: StoredState, opts: { maxAgeHours: number; capturedBy?: 'auto' | 'interactive'; user?: string }): Promise<SessionInfo> {
    const expires = new Date(Date.now() + opts.maxAgeHours * 3600_000);
    const res = await this.db.query(
      `INSERT INTO auth_sessions (agent_id, kind, identity, state, cookies, captured_at, expires_at, captured_by, captured_by_user)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8)
       ON CONFLICT (agent_id, kind, identity) DO UPDATE SET state = EXCLUDED.state, cookies = EXCLUDED.cookies,
         captured_at = EXCLUDED.captured_at, expires_at = EXCLUDED.expires_at, captured_by = EXCLUDED.captured_by,
         captured_by_user = EXCLUDED.captured_by_user, last_used_at = NULL, warned_at = NULL
       RETURNING *`,
      [agentId, kind, identity, encryptSecret(JSON.stringify(state)), state.cookies.length, expires, opts.capturedBy ?? 'auto', opts.user ?? null]);
    return toInfo(res.rows[0]);
  }

  async forget(agentId: string, kind?: IdentityKind, identity?: string): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM auth_sessions WHERE agent_id = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR identity = $3)`,
      [agentId, kind ?? null, identity ?? null]);
    return res.rowCount ?? 0;
  }

  /** Sessions of an agent, without their contents. */
  async list(agentId: string): Promise<SessionInfo[]> {
    const res = await this.db.query(
      `SELECT agent_id, kind, identity, captured_at, expires_at, last_used_at, captured_by, captured_by_user, cookies
         FROM auth_sessions WHERE agent_id = $1 ORDER BY kind, identity`, [agentId]);
    return res.rows.map(toInfo);
  }
}

/** Put a saved session into a browser context: cookies now, local storage when its origin loads. */
export async function applyState(context: BrowserContext, state: StoredState): Promise<void> {
  if (state.cookies?.length) await context.addCookies(state.cookies as any);
  const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
  if (origins.length) {
    await context.addInitScript({
      content: `(() => { const all = ${JSON.stringify(origins)};
        const mine = all.find((o) => o.origin === location.origin);
        if (!mine || sessionStorage.getItem('__atab_ls_restored')) return;
        try { for (const i of mine.localStorage) localStorage.setItem(i.name, i.value); sessionStorage.setItem('__atab_ls_restored', '1'); } catch (e) {}
      })();`,
    });
  }
}

/** The context's session, for the vault. */
export async function captureState(context: BrowserContext): Promise<StoredState> {
  const s = await context.storageState();
  return { cookies: s.cookies as any, origins: s.origins as any };
}
