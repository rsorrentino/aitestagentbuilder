/**
 * Projects and memberships.
 *
 * Listing shows the projects the caller belongs to (all for system admins).
 * Creating a project requires a system admin unless ALLOW_PROJECT_CREATION=true.
 * Member management requires the project "admin" role; only owners can grant
 * or remove "owner", archive or delete.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import { PROJECT_ROLES, ProjectRepository, ProjectRole, ROLE_RANK } from '../../core/repositories/project.repository.js';
import { UserRepository } from '../../core/repositories/user.repository.js';
import logger from '../../infra/logger/index.js';

export class ProjectsController {
  private projects = new ProjectRepository();
  private users = new UserRepository();

  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const includeArchived = req.query.archived === 'true';
      res.json(await this.projects.listForUser(req.user!.userId, req.user!.role === 'admin', includeArchived));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (req.user!.role !== 'admin' && process.env.ALLOW_PROJECT_CREATION !== 'true') {
        res.status(403).json({ error: 'Only administrators can create projects' });
        return;
      }
      const name = String(req.body?.name ?? '').trim();
      if (!name || name.length > 100) {
        res.status(400).json({ error: 'name is required (max 100 characters)' });
        return;
      }
      const project = await this.projects.create({ name, description: req.body?.description, slug: req.body?.slug, createdBy: req.user!.userId });
      await this.projects.setMember(project.id, req.user!.userId, 'owner');
      res.locals.audit = { entityId: project.id, projectId: project.id, details: { name } };
      res.status(201).json({ ...project, role: 'owner' });
    } catch (error: any) {
      logger.error('Project creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /** Operates on req.project (resolved by projectContext from :projectId). */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.json({ ...req.project, role: req.projectRole });
  }

  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name, description, archived } = req.body ?? {};
      if (archived !== undefined && req.projectRole !== 'owner') {
        res.status(403).json({ error: 'Only project owners can archive or restore a project' });
        return;
      }
      if (archived === true && req.project!.id === 'default') {
        res.status(409).json({ error: 'The Default project cannot be archived' });
        return;
      }
      const project = await this.projects.update(req.project!.id, {
        name: name !== undefined ? String(name).trim() : undefined, description, archived,
      });
      res.locals.audit = { entityId: req.project!.id, details: { name, description, archived } };
      res.json(project);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (req.project!.id === 'default') {
        res.status(409).json({ error: 'The Default project cannot be deleted' });
        return;
      }
      if (req.body?.confirm !== req.project!.slug && req.query.confirm !== req.project!.slug) {
        res.status(400).json({ error: `Deleting a project removes all its agents, tests and runs. Confirm with "confirm": "${req.project!.slug}"` });
        return;
      }
      await this.projects.delete(req.project!.id);
      res.locals.audit = { entityId: req.project!.id, details: { name: req.project!.name } };
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async listMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json(await this.projects.listMembers(req.project!.id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** PUT /projects/:projectId/members { email | userId, role } — add or change a member */
  async setMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { email, userId, role } = req.body ?? {};
      if (!PROJECT_ROLES.includes(role)) {
        res.status(400).json({ error: `role must be one of ${PROJECT_ROLES.join(', ')}` });
        return;
      }
      const target = userId
        ? await this.users.findById(String(userId))
        : email ? await this.users.findByEmailWithHash(String(email)) : null;
      if (!target || target.id === 'local') {
        res.status(404).json({ error: 'User not found — an administrator must create the account first' });
        return;
      }
      const current = await this.projects.memberRole(req.project!.id, target.id);
      const touchesOwner = role === 'owner' || current === 'owner';
      if (touchesOwner && req.projectRole !== 'owner') {
        res.status(403).json({ error: 'Only owners can grant or change the owner role' });
        return;
      }
      if (current === 'owner' && role !== 'owner' && (await this.projects.countOwners(req.project!.id)) <= 1) {
        res.status(409).json({ error: 'A project needs at least one owner' });
        return;
      }
      if (ROLE_RANK[role as ProjectRole] > ROLE_RANK[req.projectRole!]) {
        res.status(403).json({ error: 'You cannot grant a role higher than your own' });
        return;
      }
      await this.projects.setMember(req.project!.id, target.id, role);
      res.locals.audit = { entityId: target.id, details: { email: target.email, role, previousRole: current } };
      res.json({ userId: target.id, email: target.email, role });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async removeMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const current = await this.projects.memberRole(req.project!.id, userId);
      if (!current) {
        res.status(404).json({ error: 'Not a member of this project' });
        return;
      }
      if (current === 'owner') {
        if (req.projectRole !== 'owner') {
          res.status(403).json({ error: 'Only owners can remove an owner' });
          return;
        }
        if ((await this.projects.countOwners(req.project!.id)) <= 1) {
          res.status(409).json({ error: 'A project needs at least one owner' });
          return;
        }
      }
      await this.projects.removeMember(req.project!.id, userId);
      res.locals.audit = { entityId: userId, details: { previousRole: current } };
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
