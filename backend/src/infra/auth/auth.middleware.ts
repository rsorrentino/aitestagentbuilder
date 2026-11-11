/**
 * Authentication, project context and role-based authorization.
 *
 *   requireAuth       — identifies the caller (JWT, API key, or the local user when AUTH_ENABLED is off)
 *   projectContext    — resolves the current project (X-Project-Id header / ?projectId=, default "default")
 *                       and the caller's role in it
 *   requireProjectRole('editor') — minimum project role for a route
 *   requireSystemAdmin           — installation administrators only
 */

import { Request, Response, NextFunction } from 'express';
import { JWTService } from './jwt.service.js';
import { isAuthEnabled } from '../config/env.js';
import logger from '../logger/index.js';
import getDatabaseClient from '../db/client.js';
import { Project, ProjectRepository, ProjectRole, ROLE_RANK } from '../../core/repositories/project.repository.js';

export type SystemRole = 'admin' | 'user';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: SystemRole;
    mustChangePassword?: boolean;
  };
  apiKey?: {
    keyId: string;
    userId: string;
    projectId?: string;
    role?: ProjectRole;
  };
  project?: Project;
  projectRole?: ProjectRole;
}

/** Identity used for every request when AUTH_ENABLED is not "true". */
export const LOCAL_USER = { userId: 'local', email: 'local@localhost', role: 'admin' as SystemRole };

const jwtService = new JWTService();
const projectRepo = new ProjectRepository();

// ---------------------------------------------------------------------------
// Account lookup with a short cache, so deactivation / role changes apply fast.
// ---------------------------------------------------------------------------
interface AccountState { email: string; role: SystemRole; active: boolean; mustChangePassword: boolean }
const accountCache = new Map<string, { at: number; state: AccountState | null }>();
const ACCOUNT_CACHE_MS = 5000;

async function loadAccount(userId: string): Promise<AccountState | null> {
  const cached = accountCache.get(userId);
  if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.state;
  const result = await getDatabaseClient().query(
    'SELECT email, role, active, must_change_password FROM users WHERE id = $1', [userId]);
  const row = result.rows[0];
  const state = row
    ? { email: row.email, role: (row.role === 'admin' ? 'admin' : 'user') as SystemRole, active: row.active, mustChangePassword: !!row.must_change_password }
    : null;
  accountCache.set(userId, { at: Date.now(), state });
  return state;
}

export function invalidateAccountCache(userId?: string): void {
  if (userId) accountCache.delete(userId);
  else accountCache.clear();
}

/** Routes a user with a pending forced password change may still call. */
const PASSWORD_CHANGE_ALLOWED = ['/auth/me', '/auth/change-password', '/auth/config', '/auth/logout'];

/**
 * Resolve an Authorization header value ("Bearer <jwt>" or "ApiKey <key>")
 * to an active account. Shared by HTTP requests and WebSocket connections.
 */
export async function identify(authHeader: string | undefined): Promise<
  { user: NonNullable<AuthenticatedRequest['user']>; apiKey?: AuthenticatedRequest['apiKey'] } | { error: string }
> {
  if (!authHeader) return { error: 'Authentication required' };
  let userId: string;
  let apiKey: AuthenticatedRequest['apiKey'];
  try {
    if (authHeader.startsWith('Bearer ')) {
      userId = jwtService.verifyAccessToken(authHeader.substring(7)).userId;
    } else if (authHeader.startsWith('ApiKey ')) {
      apiKey = (await validateApiKey(authHeader.substring(7))) ?? undefined;
      if (!apiKey) return { error: 'Invalid or expired API key' };
      userId = apiKey.userId;
    } else {
      return { error: 'Invalid authentication format' };
    }
  } catch {
    return { error: 'Authentication failed: invalid or expired token' };
  }
  const account = await loadAccount(userId);
  if (!account || !account.active) return { error: 'Account is disabled or no longer exists' };
  return {
    user: { userId, email: account.email, role: account.role, mustChangePassword: account.mustChangePassword },
    apiKey,
  };
}

export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await identify(req.headers.authorization);
    if ('error' in result) {
      res.status(401).json({ error: result.error });
      return;
    }
    req.user = result.user;
    if (result.apiKey) req.apiKey = result.apiKey;

    if (result.user.mustChangePassword && !req.apiKey && !PASSWORD_CHANGE_ALLOWED.some((p) => req.path.endsWith(p))) {
      res.status(403).json({ error: 'You must change your password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
      return;
    }
    next();
  } catch (error: any) {
    logger.debug('Authentication failed', { error: error.message });
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/** Effective role of a user in a project (null = no access). */
export async function projectRoleFor(
  user: NonNullable<AuthenticatedRequest['user']>,
  projectId: string,
  apiKey?: AuthenticatedRequest['apiKey'],
): Promise<ProjectRole | null> {
  if (apiKey?.projectId && apiKey.projectId !== projectId) return null;
  let role: ProjectRole | null = user.role === 'admin' ? 'owner' : await projectRepo.memberRole(projectId, user.userId);
  if (role && apiKey?.role && ROLE_RANK[apiKey.role] < ROLE_RANK[role]) role = apiKey.role;
  return role;
}

/**
 * Real authentication when AUTH_ENABLED=true; otherwise every request runs
 * as the local administrator (API keys are still honoured when sent).
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (isAuthEnabled() || req.headers.authorization?.startsWith('ApiKey ')) {
    return authenticate(req, res, next);
  }
  req.user = { ...LOCAL_USER };
  next();
}

/** Resolves the current project and the caller's role in it. */
export async function projectContext(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const requested = String(req.header('x-project-id') || req.query.projectId || req.apiKey?.projectId || 'default');
    if (req.apiKey?.projectId && req.apiKey.projectId !== requested) {
      res.status(403).json({ error: 'This API key is restricted to another project' });
      return;
    }

    const project = await projectRepo.findById(requested);
    if (!project) {
      res.status(404).json({ error: `Project not found: ${requested}` });
      return;
    }

    const role = await projectRoleFor(req.user!, project.id, req.apiKey);
    if (!role) {
      res.status(403).json({ error: `You are not a member of project "${project.name}"` });
      return;
    }

    req.project = project;
    req.projectRole = role;
    next();
  } catch (error: any) {
    logger.error('Project context failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
}

export function requireProjectRole(minimum: ProjectRole) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.projectRole || ROLE_RANK[req.projectRole] < ROLE_RANK[minimum]) {
      res.status(403).json({ error: `This action requires the "${minimum}" role in project "${req.project?.name ?? '?'}"` });
      return;
    }
    if (req.project?.archived && ROLE_RANK[minimum] >= ROLE_RANK.editor && req.method !== 'GET') {
      res.status(409).json({ error: `Project "${req.project.name}" is archived (read-only)` });
      return;
    }
    next();
  };
}

export function requireSystemAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin' || (req.apiKey && req.apiKey.projectId)) {
    res.status(403).json({ error: 'Administrator access required' });
    return;
  }
  next();
}

/** Legacy helper kept for compatibility: system-level role check. */
export function authorize(...allowedRoles: SystemRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (allowedRoles.includes(req.user.role)) return next();
    res.status(403).json({ error: 'Insufficient permissions' });
  };
}

async function validateApiKey(apiKey: string): Promise<AuthenticatedRequest['apiKey'] | null> {
  try {
    const result = await getDatabaseClient().query(
      `UPDATE api_keys SET last_used_at = NOW()
        WHERE key_hash = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id, user_id, project_id, role`,
      [jwtService.hashApiKey(apiKey)],
    );
    if (result.rows.length === 0) return null;
    const key = result.rows[0];
    return { keyId: key.id, userId: key.user_id, projectId: key.project_id ?? undefined, role: key.role ?? undefined };
  } catch (error: any) {
    logger.error('API key validation failed', { error: error.message });
    return null;
  }
}
