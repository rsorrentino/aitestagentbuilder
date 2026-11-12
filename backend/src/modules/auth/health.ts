/**
 * Sign-in health: for every login profile and Salesforce persona of a project,
 * whether runs can sign it in unattended, and the state of its saved session.
 * A session saved by a person ("sign in once") that cannot be renewed by
 * itself is the one to watch: the project's channels are warned before it
 * expires (event auth.session_expiring).
 */

import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { decryptAgentConfig } from '../../core/domain/agent-secrets.js';
import { getNotificationService } from '../automation/notification.service.js';
import { SessionInfo, SessionVault } from './session-vault.js';

export type Unattended = 'yes' | 'maybe' | 'no';

export interface IdentityHealth {
  agentId: string;
  agentName: string;
  kind: 'app' | 'salesforce';
  identity: string;
  /** Can a run sign in without a person: yes (credentials + MFA answer), maybe (no MFA answer configured), no */
  unattended: Unattended;
  how: string;
  session: 'ok' | 'expiring' | 'expired' | 'none';
  expiresAt?: string;
  capturedBy?: string;
  /** Needs attention: tests will fail (or may) without a person */
  attention: boolean;
  hint?: string;
}

const EXPIRING_MS = 24 * 3_600_000;

/** How an identity signs in by itself (pure). */
export function unattendedOf(kind: 'app' | 'salesforce', x: any): { unattended: Unattended; how: string } {
  const codes = x?.codes?.source ? `codes from ${x.codes.source}` : '';
  if (kind === 'salesforce') {
    if (x.auth_method === 'jwt') return { unattended: 'yes', how: 'JWT bearer (no MFA in the UI)' };
    if (x.auth_method === 'oauth_password') return { unattended: 'yes', how: 'OAuth password flow' };
    if (x.auth_method === 'login_as') return { unattended: 'yes', how: `"Log in as" via ${x.login_as_via}` };
    if (!x.password) return { unattended: 'no', how: 'no password stored' };
    if (x.totp_secret || codes) return { unattended: 'yes', how: ['password', x.totp_secret ? 'authenticator key' : '', codes].filter(Boolean).join(' + ') };
    return { unattended: 'maybe', how: 'password only (works if Salesforce does not ask for a code)' };
  }
  if (!x.username || !x.password) return { unattended: 'no', how: 'no user name / password stored' };
  if (x.totp_secret || codes) return { unattended: 'yes', how: ['password', x.totp_secret ? 'authenticator key' : '', codes].filter(Boolean).join(' + ') };
  return { unattended: 'maybe', how: 'password only (works if the application does not ask for MFA)' };
}

function sessionState(s?: SessionInfo): IdentityHealth['session'] {
  if (!s) return 'none';
  const left = new Date(s.expiresAt).getTime() - Date.now();
  const lifetime = new Date(s.expiresAt).getTime() - new Date(s.capturedAt).getTime();
  return left <= 0 ? 'expired' : left < Math.min(EXPIRING_MS, lifetime / 2) ? 'expiring' : 'ok';
}

export async function authHealth(projectId: string): Promise<IdentityHealth[]> {
  const agents = await new AgentRepository().findAll(projectId, 1000, 0);
  const vault = new SessionVault();
  const out: IdentityHealth[] = [];
  for (const agent of agents) {
    const config = decryptAgentConfig(agent.config);
    const identities: Array<{ kind: 'app' | 'salesforce'; x: any }> = [
      ...(config.auth?.profiles ?? []).map((x: any) => ({ kind: 'app' as const, x })),
      ...(config.salesforce?.personas ?? []).map((x: any) => ({ kind: 'salesforce' as const, x })),
    ];
    if (!identities.length) continue;
    const sessions = await vault.list(agent.id);
    for (const { kind, x } of identities) {
      const s = sessions.find((y) => y.kind === kind && y.identity === x.name);
      const { unattended, how } = unattendedOf(kind, x);
      const session = sessionState(s);
      const attention = unattended !== 'yes' && session !== 'ok';
      out.push({
        agentId: agent.id, agentName: agent.name, kind, identity: x.name, unattended, how, session,
        ...(s ? { expiresAt: s.expiresAt, capturedBy: s.capturedBy } : {}),
        attention,
        ...(attention ? {
          hint: unattended === 'no'
            ? 'Runs cannot sign in by themselves: use "Sign in once…" (and again before the session expires), or store the credentials'
            : session === 'none'
              ? 'Check it with "Test sign-in"; if MFA is asked, add an authenticator key or a mailbox for codes, or sign in once'
              : 'The session will be renewed by signing in again; if MFA is asked, add an authenticator key or a mailbox for codes',
        } : {}),
      });
    }
  }
  return out.sort((a, b) => Number(b.attention) - Number(a.attention) || a.agentName.localeCompare(b.agentName) || a.identity.localeCompare(b.identity));
}

/**
 * Warn once about each session saved by a person when less than half of its lifetime (at most 24 h) is left
 * (hourly background job).
 * Returns the number of sessions warned about.
 */
export async function warnExpiringSessions(projectId?: string): Promise<number> {
  const db = getDatabaseClient();
  const res = await db.query(
    `SELECT s.agent_id, s.kind, s.identity, s.expires_at, a.name AS agent_name, a.project_id, a.config
       FROM auth_sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.captured_by = 'interactive' AND s.warned_at IS NULL
        AND s.expires_at > CURRENT_TIMESTAMP
        -- warn when less than half of the session's lifetime is left, at most 24 hours before it expires
        AND s.expires_at <= CURRENT_TIMESTAMP + LEAST(INTERVAL '24 hours', (s.expires_at - s.captured_at) / 2)
        AND ($1::text IS NULL OR a.project_id = $1)`, [projectId ?? null]);
  let warned = 0;
  for (const row of res.rows) {
    try {
      const config = decryptAgentConfig(typeof row.config === 'string' ? JSON.parse(row.config) : row.config);
      const list = row.kind === 'salesforce' ? config.salesforce?.personas ?? [] : config.auth?.profiles ?? [];
      const x = list.find((p: any) => p.name === row.identity);
      const unattended = x ? unattendedOf(row.kind, x).unattended === 'yes' : false;
      await db.query('UPDATE auth_sessions SET warned_at = CURRENT_TIMESTAMP WHERE agent_id = $1 AND kind = $2 AND identity = $3', [row.agent_id, row.kind, row.identity]);
      await getNotificationService().onSessionExpiring({
        projectId: row.project_id, agentId: row.agent_id, agentName: row.agent_name, kind: row.kind, identity: row.identity,
        expiresAt: new Date(row.expires_at), unattended,
      });
      warned++;
    } catch (e: any) {
      logger.warn('Session expiry warning failed', { agentId: row.agent_id, identity: row.identity, error: e.message });
    }
  }
  return warned;
}
