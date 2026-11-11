/**
 * Authentication: login (with lockout), refresh, current user, password
 * change, and API keys (optionally limited to one project and a maximum role).
 */

import { Request, Response } from 'express';
import { JWTService, verifyPassword } from '../../infra/auth/jwt.service.js';
import getDatabaseClient from '../../infra/db/client.js';
import { AuthenticatedRequest, invalidateAccountCache } from '../../infra/auth/auth.middleware.js';
import { isAuthEnabled } from '../../infra/config/env.js';
import { UserRepository } from '../../core/repositories/user.repository.js';
import { PROJECT_ROLES, ProjectRepository, ProjectRole } from '../../core/repositories/project.repository.js';
import { checkPassword, passwordPolicy } from '../../infra/security/password-policy.js';
import { recordAudit, requestMeta } from '../../infra/audit/audit.js';
import logger from '../../infra/logger/index.js';

const jwtService = new JWTService();
const users = new UserRepository();
const projects = new ProjectRepository();
const db = getDatabaseClient();

/**
 * Create the bootstrap admin from ADMIN_EMAIL / ADMIN_PASSWORD if it does not
 * exist, and the local identity used when auth is disabled.
 */
export async function seedAdminUser(): Promise<void> {
  await users.ensureLocalUser();
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    if (isAuthEnabled()) {
      logger.warn('AUTH_ENABLED=true but ADMIN_EMAIL/ADMIN_PASSWORD are not set — nobody can log in unless users exist.');
    }
    return;
  }
  if (await users.findByEmailWithHash(email)) return;
  const user = await users.create({ email, password, role: 'admin', name: 'Administrator' });
  await projects.setMember('default', user.id, 'owner');
  logger.info('Bootstrap admin user created', { email });
}

export class AuthController {
  async config(_req: Request, res: Response): Promise<void> {
    res.json({ authEnabled: isAuthEnabled(), passwordMinLength: passwordPolicy.minLength() });
  }

  /** Current user plus the projects they can access. */
  async me(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const u = req.user!;
      const account = await users.findById(u.userId);
      const list = await projects.listForUser(u.userId, u.role === 'admin');
      res.json({
        authEnabled: isAuthEnabled(),
        user: {
          id: u.userId,
          email: u.email,
          name: account?.name,
          role: u.role,
          mustChangePassword: account?.mustChangePassword ?? false,
        },
        apiKey: req.apiKey ? { id: req.apiKey.keyId, projectId: req.apiKey.projectId, role: req.apiKey.role } : undefined,
        projects: list.map((p) => ({ id: p.id, name: p.name, slug: p.slug, role: p.role, archived: p.archived })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async login(req: Request, res: Response): Promise<void> {
    const meta = requestMeta(req as AuthenticatedRequest);
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      const user = await users.findByEmailWithHash(String(email));
      // Same message for unknown user and wrong password (no account enumeration)
      const invalid = () => res.status(401).json({ error: 'Invalid email or password' });

      if (!user || user.id === 'local') {
        await recordAudit({ ...meta, action: 'auth.login.failed', details: { email: String(email).toLowerCase(), reason: 'unknown user' } });
        invalid();
        return;
      }
      if (!user.active) {
        await recordAudit({ ...meta, userId: user.id, userEmail: user.email, action: 'auth.login.failed', details: { reason: 'disabled' } });
        res.status(403).json({ error: 'Account is disabled' });
        return;
      }
      if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        await recordAudit({ ...meta, userId: user.id, userEmail: user.email, action: 'auth.login.failed', details: { reason: 'locked' } });
        res.status(423).json({ error: `Account locked after too many failed attempts. Try again after ${new Date(user.lockedUntil).toISOString()}` });
        return;
      }

      if (!verifyPassword(String(password), user.passwordHash)) {
        const { locked, lockedUntil } = await users.recordLoginFailure(user.id, passwordPolicy.maxFailedLogins(), passwordPolicy.lockoutMinutes());
        await recordAudit({
          ...meta, userId: user.id, userEmail: user.email,
          action: locked ? 'auth.account.locked' : 'auth.login.failed',
          details: { reason: 'wrong password', ...(locked ? { lockedUntil } : {}) },
        });
        if (locked) {
          res.status(423).json({ error: `Account locked after too many failed attempts. Try again after ${new Date(lockedUntil!).toISOString()}` });
        } else {
          invalid();
        }
        return;
      }

      await users.recordLoginSuccess(user.id);
      await recordAudit({ ...meta, userId: user.id, userEmail: user.email, action: 'auth.login' });
      const tokens = jwtService.generateTokens({ userId: user.id, email: user.email, role: user.role });
      res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword },
      });
    } catch (error: any) {
      logger.error('Login failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async refresh(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body ?? {};
      if (!refreshToken) {
        res.status(400).json({ error: 'Refresh token is required' });
        return;
      }
      const { userId } = jwtService.verifyRefreshToken(refreshToken);
      const user = await users.findById(userId);
      if (!user || !user.active) {
        res.status(401).json({ error: 'Invalid refresh token' });
        return;
      }
      res.json(jwtService.generateTokens({ userId: user.id, email: user.email, role: user.role }));
    } catch {
      res.status(401).json({ error: 'Invalid refresh token' });
    }
  }

  async changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      const userId = req.user!.userId;
      if (userId === 'local') {
        res.status(400).json({ error: 'The local user has no password (authentication is disabled)' });
        return;
      }
      const hash = await users.findHashById(userId);
      if (!hash || !verifyPassword(String(currentPassword ?? ''), hash)) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }
      const problems = checkPassword(newPassword, req.user!.email);
      if (problems.length) {
        res.status(400).json({ error: problems.join('; ') });
        return;
      }
      if (verifyPassword(String(newPassword), hash)) {
        res.status(400).json({ error: 'The new password must be different from the current one' });
        return;
      }
      await users.setPassword(userId, String(newPassword), false);
      invalidateAccountCache(userId);
      res.locals.audit = { entityId: userId };
      res.json({ message: 'Password changed' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /auth/api-keys { name, projectId?, role?, expiresInDays? } */
  async createApiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name, projectId, role, expiresInDays } = req.body ?? {};
      const userId = req.user!.userId;

      if (role !== undefined && !PROJECT_ROLES.includes(role)) {
        res.status(400).json({ error: `role must be one of ${PROJECT_ROLES.join(', ')}` });
        return;
      }
      if (projectId) {
        const project = await projects.findById(projectId);
        const myRole = req.user!.role === 'admin' ? 'owner' : await projects.memberRole(projectId, userId);
        if (!project || !myRole) {
          res.status(404).json({ error: 'Project not found or you are not a member' });
          return;
        }
      }
      const days = expiresInDays === undefined ? undefined : Number(expiresInDays);
      if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
        res.status(400).json({ error: 'expiresInDays must be between 1 and 3650' });
        return;
      }

      const apiKey = jwtService.generateApiKey();
      const keyId = `KEY-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : null;
      await db.query(
        `INSERT INTO api_keys (id, user_id, key_hash, name, permissions, expires_at, project_id, role, key_prefix)
         VALUES ($1, $2, $3, $4, '["*"]', $5, $6, $7, $8)`,
        [keyId, userId, jwtService.hashApiKey(apiKey), name || 'API key', expiresAt, projectId || null, (role as ProjectRole) || null, apiKey.slice(0, 10)],
      );

      res.locals.audit = { entityId: keyId, details: { name: name || 'API key', projectId, role } };
      res.status(201).json({
        id: keyId,
        apiKey,
        name: name || 'API key',
        projectId: projectId || null,
        role: role || null,
        expiresAt,
        message: 'Store this API key securely. It will not be shown again.',
      });
    } catch (error: any) {
      logger.error('API key creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async listApiKeys(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await db.query(
        `SELECT k.id, k.name, k.key_prefix, k.project_id, p.name AS project_name, k.role, k.active, k.expires_at, k.last_used_at, k.created_at
           FROM api_keys k LEFT JOIN projects p ON p.id = k.project_id
          WHERE k.user_id = $1 ORDER BY k.created_at DESC`,
        [req.user!.userId],
      );
      res.json(result.rows.map((r) => ({
        id: r.id, name: r.name, prefix: r.key_prefix, projectId: r.project_id, projectName: r.project_name, role: r.role,
        active: r.active, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, createdAt: r.created_at,
      })));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async revokeApiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await db.query(
        'UPDATE api_keys SET active = false WHERE id = $1 AND (user_id = $2 OR $3)',
        [req.params.id, req.user!.userId, req.user!.role === 'admin'],
      );
      if (!result.rowCount) {
        res.status(404).json({ error: 'API key not found' });
        return;
      }
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
