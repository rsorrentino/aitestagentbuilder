/**
 * User administration (system administrators only).
 */

import { Response } from 'express';
import { AuthenticatedRequest, invalidateAccountCache } from '../../infra/auth/auth.middleware.js';
import { UserRepository } from '../../core/repositories/user.repository.js';
import { PROJECT_ROLES, ProjectRepository } from '../../core/repositories/project.repository.js';
import { checkPassword, generateTemporaryPassword } from '../../infra/security/password-policy.js';
import logger from '../../infra/logger/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UsersController {
  private users = new UserRepository();
  private projects = new ProjectRepository();

  async list(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json(await this.users.list());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /admin/users { email, name?, role?, password?, projects?: [{ projectId, role }] }
   * Without a password a temporary one is generated and returned once; the
   * user must change it at first login.
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { email, name, role = 'user', password, projects = [] } = req.body ?? {};
      if (!email || !EMAIL_RE.test(String(email))) {
        res.status(400).json({ error: 'A valid email is required' });
        return;
      }
      if (!['admin', 'user'].includes(role)) {
        res.status(400).json({ error: 'role must be "admin" or "user"' });
        return;
      }
      if (!Array.isArray(projects) || projects.some((p: any) => !p?.projectId || !PROJECT_ROLES.includes(p.role))) {
        res.status(400).json({ error: `projects must be a list of { projectId, role } with role in ${PROJECT_ROLES.join(', ')}` });
        return;
      }
      if (await this.users.findByEmailWithHash(String(email))) {
        res.status(409).json({ error: `A user with email ${email} already exists` });
        return;
      }
      if (password !== undefined) {
        const problems = checkPassword(password, String(email));
        if (problems.length) {
          res.status(400).json({ error: problems.join('; ') });
          return;
        }
      }
      for (const p of projects) {
        if (!(await this.projects.findById(p.projectId))) {
          res.status(400).json({ error: `Project not found: ${p.projectId}` });
          return;
        }
      }

      const temporaryPassword = password === undefined ? generateTemporaryPassword() : undefined;
      const user = await this.users.create({
        email: String(email), name, role, password: password ?? temporaryPassword!, mustChangePassword: true,
      });
      for (const p of projects) await this.projects.setMember(p.projectId, user.id, p.role);

      res.locals.audit = { entityId: user.id, details: { email: user.email, role, projects } };
      res.status(201).json({ user, ...(temporaryPassword ? { temporaryPassword } : {}) });
    } catch (error: any) {
      logger.error('User creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /** PATCH /admin/users/:id { name?, role?, active? } */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { name, role, active } = req.body ?? {};
      if (role !== undefined && !['admin', 'user'].includes(role)) {
        res.status(400).json({ error: 'role must be "admin" or "user"' });
        return;
      }
      const existing = await this.users.findById(id);
      if (!existing || id === 'local') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // Never leave the installation without an active administrator
      const demoting = existing.role === 'admin' && existing.active && (role === 'user' || active === false);
      if (demoting && (await this.users.countActiveAdmins()) <= 1) {
        res.status(409).json({ error: 'Cannot remove the last active administrator' });
        return;
      }
      if (id === req.user!.userId && active === false) {
        res.status(409).json({ error: 'You cannot deactivate your own account' });
        return;
      }

      const user = await this.users.update(id, { name, role, active });
      invalidateAccountCache(id);
      res.locals.audit = { details: { name, role, active } };
      res.json(user);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /admin/users/:id/reset-password → returns a temporary password */
  async resetPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = await this.users.findById(req.params.id);
      if (!user || user.id === 'local') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const temporaryPassword = generateTemporaryPassword();
      await this.users.setPassword(user.id, temporaryPassword, true);
      invalidateAccountCache(user.id);
      res.json({ temporaryPassword, message: 'The user must change this password at next login.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async unlock(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = await this.users.findById(req.params.id);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      await this.users.unlock(user.id);
      res.json({ message: 'Account unlocked' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
