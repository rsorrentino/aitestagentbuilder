/**
 * Agents Controller (project-scoped). Secrets in agent configs are encrypted
 * at rest and never returned in plaintext.
 */

import { LOCALE_RE } from '../../modules/quality/test-data-gen.js';
import { validatePerformanceConfig } from '../../modules/quality/performance.js';
import { SessionVault } from '../../modules/auth/session-vault.js';
import { Response } from 'express';
import { AgentRepository } from '../../core/repositories/agent.repository.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { Agent, AgentConfig } from '../../core/domain/agent.js';
import { decryptAgentConfig, redactAgentConfig, secretValues } from '../../core/domain/agent-secrets.js';
import { maskSecrets } from '../../infra/security/secrets.js';
import { salesforceSettings } from '../../modules/salesforce/personas.js';
import { SalesforceSessions } from '../../modules/salesforce/session.js';
import { launchBrowser } from '../../modules/execution/browser.js';
import { AiTestGeneratorService } from '../../modules/agents/services/ai-test-generator.service.js';
import { OrchestratorService, RunValidationError } from '../../modules/orchestration/services/orchestrator.service.js';
import { NoLLMProviderError } from '../../infra/llm/router.js';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import logger from '../../infra/logger/index.js';

const APPLICATION_TYPES = ['web', 'api', 'mobile', 'hybrid'];

/**
 * Validates and fills defaults for an agent config. Returns errors or the config.
 */
export function buildAgentConfig(name: string, raw: any): { errors: string[]; config?: AgentConfig } {
  const errors: string[] = [];
  const cfg = raw && typeof raw === 'object' ? { ...raw } : {};

  const baseUrl = String(cfg.base_url ?? cfg.baseUrl ?? '').trim();
  if (!baseUrl) {
    errors.push('config.base_url is required');
  } else {
    try {
      const u = new URL(baseUrl);
      if (!/^https?:$/.test(u.protocol)) errors.push('config.base_url must start with http:// or https://');
    } catch {
      errors.push('config.base_url must be a valid URL, e.g. https://staging.example.com');
    }
  }
  const appType = cfg.application_type ?? 'web';
  if (!APPLICATION_TYPES.includes(appType)) errors.push(`config.application_type must be one of ${APPLICATION_TYPES.join(', ')}`);
  if (cfg.api_base_url !== undefined && cfg.api_base_url !== '') {
    try {
      if (!/^https?:$/.test(new URL(String(cfg.api_base_url)).protocol)) throw new Error();
    } catch {
      errors.push('config.api_base_url must be an http(s) URL, e.g. https://api.staging.example.com/v1/');
    }
  }
  errors.push(...validatePerformanceConfig(cfg.checks));
  if (cfg.test_data !== undefined && cfg.test_data !== null) {
    const td = cfg.test_data;
    if (typeof td !== 'object' || Array.isArray(td)) errors.push('config.test_data must be an object { locale, seed, environment }');
    else if (td.locale !== undefined && td.locale !== '' && !LOCALE_RE.test(String(td.locale))) {
      errors.push('config.test_data.locale must be a locale such as en, en_US, it, de, fr, es, pt_BR');
    }
  }
  if (cfg.secrets !== undefined && (typeof cfg.secrets !== 'object' || Array.isArray(cfg.secrets))) {
    errors.push('config.secrets must be an object of NAME: value');
  }
  if (errors.length) return { errors };

  const selection = cfg.test_selection ?? {};
  const list = (v: any) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
  delete cfg.baseUrl;

  return {
    errors,
    config: {
      ...cfg,
      agent_name: cfg.agent_name || name,
      application_type: appType,
      base_url: baseUrl,
      environment: cfg.environment || 'default',
      test_selection: {
        module: list(selection.module),
        priority: list(selection.priority),
        tags: list(selection.tags),
        type: list(selection.type),
        testIds: list(selection.testIds),
      },
      tools: cfg.tools ?? { browser: 'playwright', http: 'axios' },
      reporting: cfg.reporting ?? { formats: ['json', 'html', 'junit'], includeScreenshots: true, includeLogs: true },
      retries: Math.min(Math.max(Number(cfg.retries ?? 0) || 0, 0), 3),
      timeout: Number(cfg.timeout) || 60000,
      max_parallel_tests: Number(cfg.max_parallel_tests) || 1,
    } as AgentConfig,
  };
}

/** Agent as returned by the API: secrets replaced by a placeholder. */
export function publicAgent(agent: Agent): Agent {
  return { ...agent, config: redactAgentConfig(agent.config) };
}

const badSecret = (e: any) => /Invalid secret name|persona|salesforce\.|login profile|auth\./i.test(e?.message ?? '');

/** Identities whose saved session no longer fits (removed, or another user name / sign-in URL). */
function staleIdentities(before: any, after: any): Array<{ kind: 'app' | 'salesforce'; identity: string }> {
  const out: Array<{ kind: 'app' | 'salesforce'; identity: string }> = [];
  const check = (kind: 'app' | 'salesforce', prev: any[] = [], next: any[] = [], keys: string[]) => {
    for (const p of prev) {
      const n = next.find((x: any) => x?.name === p?.name);
      if (!n || keys.some((k) => (n[k] ?? '') !== (p[k] ?? ''))) out.push({ kind, identity: p.name });
    }
  };
  check('app', before?.auth?.profiles, after?.auth?.profiles, ['username', 'login_url']);
  check('salesforce', before?.salesforce?.personas, after?.salesforce?.personas, ['username', 'auth_method']);
  if ((before?.salesforce?.login_url ?? '') !== (after?.salesforce?.login_url ?? '')) {
    for (const p of before?.salesforce?.personas ?? []) if (!out.some((o) => o.kind === 'salesforce' && o.identity === p.name)) out.push({ kind: 'salesforce', identity: p.name });
  }
  return out;
}

export class AgentsController {
  private agentRepo = new AgentRepository();
  private testCaseRepo = new TestCaseRepository();
  private testGenerator = new AiTestGeneratorService();

  async createAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const projectId = req.project!.id;
      const name = String(req.body?.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const { errors, config } = buildAgentConfig(name, req.body?.config);
      if (errors.length) {
        res.status(400).json({ error: errors.join('; ') });
        return;
      }
      if (await this.agentRepo.findByName(name, projectId)) {
        res.status(409).json({ error: `An agent named "${name}" already exists in this project` });
        return;
      }

      const agent = await this.agentRepo.create({ name, config: config!, projectId, createdBy: req.user?.userId });
      res.locals.audit = { entityId: agent.id, details: { name, baseUrl: config!.base_url } };
      res.status(201).json(publicAgent(agent));
    } catch (error: any) {
      if (badSecret(error)) {
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error('Agent creation failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async getAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agent = await this.agentRepo.findById(req.params.id, req.project!.id);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(publicAgent(agent));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Log in as a Salesforce persona and report who Salesforce says it is
   * (profile, permission sets) compared with what the persona expects.
   */
  async verifyPersona(req: AuthenticatedRequest, res: Response): Promise<void> {
    const agent = await this.agentRepo.findById(req.params.id, req.project!.id).catch(() => null);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const config = decryptAgentConfig(agent.config);
    const settings = salesforceSettings(config);
    const mask = (t: string) => maskSecrets(t, secretValues(config));
    if (!settings || settings.personas.length === 0) {
      res.status(400).json({ error: 'This agent has no Salesforce personas' });
      return;
    }
    const sessions = new SalesforceSessions({ ...settings, reuseSessions: false });
    const name = req.params.name;
    let persona;
    try {
      persona = sessions.persona(name);
    } catch (error: any) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.locals.audit = { entityId: agent.id, details: { persona: persona.name, method: persona.auth_method } };

    const started = Date.now();
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const login = await sessions.login(page, persona.name);
      const identity = await sessions.identity(page, persona.name).catch((e: any) => ({ error: mask(e.message) }));
      const mismatches = 'error' in identity ? [] : SalesforceSessions.identityMismatches(persona, identity);
      res.json({
        ok: !('error' in identity) && mismatches.length === 0,
        persona: persona.name,
        authMethod: persona.auth_method,
        message: mask(login.message),
        landedUrl: page.url().split('?')[0],
        identity,
        mismatches,
        durationMs: Date.now() - started,
      });
    } catch (error: any) {
      res.status(200).json({ ok: false, persona: persona.name, authMethod: persona.auth_method, error: mask(String(error.message).split('\n')[0]), durationMs: Date.now() - started });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async listAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      res.json((await this.agentRepo.findAll(req.project!.id, limit, offset)).map(publicAgent));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async updateAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const projectId = req.project!.id;
      const existing = await this.agentRepo.findById(req.params.id, projectId);
      if (!existing) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
      if (!name) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      if (req.body?.status !== undefined && !['active', 'inactive', 'archived'].includes(req.body.status)) {
        res.status(400).json({ error: 'status must be active, inactive or archived' });
        return;
      }

      let config: AgentConfig | undefined;
      if (req.body?.config !== undefined) {
        const built = buildAgentConfig(name, { ...existing.config, ...req.body.config });
        if (built.errors.length) {
          res.status(400).json({ error: built.errors.join('; ') });
          return;
        }
        config = built.config;
      }

      const agent = await this.agentRepo.update(existing.id, {
        name: req.body?.name !== undefined ? name : undefined,
        config,
        status: req.body?.status,
      }, projectId);

      // A saved session belongs to a user name: forget it when the profile or persona changes
      const stale = config ? staleIdentities(existing.config, agent!.config) : [];
      if (stale.length) {
        const vault = new SessionVault();
        await Promise.all(stale.map((x) => vault.forget(existing.id, x.kind, x.identity).catch(() => 0)));
      }
      const changedSecrets = req.body?.config?.secrets !== undefined || req.body?.config?.salesforce !== undefined || req.body?.config?.auth !== undefined;
      res.locals.audit = {
        details: {
          fields: Object.keys(req.body ?? {}),
          ...(req.body?.config ? { configKeys: Object.keys(req.body.config) } : {}),
          ...(changedSecrets ? { secretsChanged: true } : {}),
        },
      };
      res.json(publicAgent(agent!));
    } catch (error: any) {
      if (badSecret(error)) {
        res.status(400).json({ error: error.message });
        return;
      }
      const conflict = /duplicate key/i.test(error.message);
      if (!conflict) logger.error('Agent update failed', { error: error.message });
      res.status(conflict ? 409 : 500).json({ error: conflict ? 'An agent with that name already exists in this project' : error.message });
    }
  }

  async deleteAgent(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const agent = await this.agentRepo.findById(req.params.id, req.project!.id);
      if (!agent || !(await this.agentRepo.delete(agent.id, req.project!.id))) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.locals.audit = { details: { name: agent.name } };
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /agents/:id/plan — the test cases a run of this agent would execute. */
  async getPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const plan = await OrchestratorService.get().previewPlan(req.params.id, req.project!.id);
      res.json({
        strategy: plan.strategy,
        estimatedDuration: plan.estimatedDuration,
        count: plan.tests.length,
        testCases: plan.testCases.map((tc) => ({
          id: tc.id, title: tc.title, module: tc.module, priority: tc.priority, steps: tc.steps.length, tags: tc.tags,
        })),
      });
    } catch (error: any) {
      const status = error instanceof RunValidationError ? error.statusCode : 500;
      res.status(status).json({ error: error.message });
    }
  }

  /**
   * POST /agents/:id/generate-tests  { description?, count?, modules?, save? }
   * Generates test cases with the LLM and (by default) saves them in the
   * project, tagged with `agent:<id>`.
   */
  async generateTests(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const projectId = req.project!.id;
      const agent = await this.agentRepo.findById(req.params.id, projectId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const { description, count, modules, save = true } = req.body ?? {};
      const cfg = agent.config as any;
      const { tests, provider, pageCaptured } = await this.testGenerator.generateTests({
        targetUrl: agent.config.base_url,
        description: description || `Core user journeys of ${agent.name}`,
        count: Number(count) || 5,
        modules: Array.isArray(modules) && modules.length ? modules : agent.config.test_selection?.module,
        preferredProvider: cfg.ai?.provider,
        tags: [`agent:${agent.id}`],
      });

      if (tests.length === 0) {
        res.status(502).json({ error: 'The AI did not return any usable test cases. Try a more specific description.' });
        return;
      }

      // Respect the agent's priority filter so the saved tests actually run.
      const priorities = agent.config.test_selection?.priority ?? [];
      const toSave = tests.map((t) => ({
        ...(priorities.length && !priorities.includes(t.priority) ? { ...t, priority: priorities[0] } : t),
        projectId,
      }));

      const saved = save ? await Promise.all(toSave.map((t) => this.testCaseRepo.create(t))) : toSave;
      res.locals.audit = { details: { generated: saved.length, provider, saved: !!save } };
      res.json({ agentId: agent.id, provider, pageCaptured, saved: !!save, count: saved.length, tests: saved });
    } catch (error: any) {
      logger.error('Test generation failed', { error: error.message });
      res.status(error instanceof NoLLMProviderError ? 503 : 500).json({ error: error.message });
    }
  }
}
