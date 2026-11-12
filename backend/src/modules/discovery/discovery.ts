/**
 * App discovery: explore the application as a test user and map it.
 *
 * The crawler signs in (login profile or Salesforce persona, saved sessions reused), follows
 * same-site links breadth-first and records each screen once per URL pattern (/orders/123 and
 * /orders/456 are /orders/:id). It reads the page's accessibility tree, which reaches into web
 * components (Salesforce Lightning) and works for any front-end framework (React, Angular, Vue),
 * plus data-testid attributes. It never follows sign-out or destructive links (delete, remove,
 * cancel, unsubscribe …), files, other sites or Salesforce Setup.
 *
 * From the map it proposes library elements (Cart.CheckoutButton → role=button[name="Checkout"]
 * or [data-testid="checkout"]) and smoke tests for screens no test visits yet (with the AI, a few
 * functional tests as well).
 */

import crypto from 'crypto';
import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import type { Agent } from '../../core/domain/agent.js';
import type { TestStep } from '../../core/domain/test-case.js';

export interface AriaNode { role: string; name: string; url?: string; level?: number }
export interface DiscoveredElement { name: string; role: string; label: string; locator: string; alternatives?: string[] }
export interface DiscoveredPage {
  url: string; pattern: string; title: string; heading?: string; name: string; depth: number;
  elements: DiscoveredElement[]; links: number; covered?: boolean;
}
export interface ProposedTest { title: string; module: string; steps: Array<Omit<TestStep, 'stepId'>>; data?: Record<string, any>; page: string; source: 'rules' | 'ai'; elements: string[] }
export interface DiscoveryOptions { maxPages: number; maxDepth: number; loginAs?: string; startPaths: string[]; exclude: string[] }

export const DISCOVERY_LIMITS = { maxPages: 200, maxDepth: 6, minutes: 15 };

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

const ID_SEGMENT = [
  /^\d+$/, // 123
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/, // Salesforce 15/18-character ids
  /^(?=.*\d)[0-9a-f]{12,}$/i, // hashes, Mongo ids
];

/** /orders/123/edit → /orders/:id/edit; Salesforce record pages likewise (query and hash dropped). */
export function urlPattern(url: string): string {
  const u = new URL(url);
  const path = u.pathname.split('/').map((seg) => (seg && ID_SEGMENT.some((re) => re.test(decodeURIComponent(seg))) ? ':id' : seg)).join('/');
  return (path.replace(/\/+$/, '') || '/');
}

const DESTRUCTIVE = /\b(log ?out|sign ?out|log ?off|sign ?off|delete|remove|destroy|erase|purge|deactivate|disable|cancel (my )?(account|subscription|order)|unsubscribe|close (my )?account|reset (all|data)|wipe)\b/i;
const FILE = /\.(pdf|zip|gz|tar|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|mp4|mp3|exe|dmg|msi)$/i;

/** Why a link is not followed (or null to follow it). */
export function skipReason(href: string, text: string, base: string, exclude: string[] = []): string | null {
  if (/^(mailto|tel|javascript|data|blob):/i.test(href)) return 'not a page';
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return 'invalid';
  }
  const b = new URL(base);
  if (u.origin !== b.origin) return 'another site';
  if (DESTRUCTIVE.test(text) || DESTRUCTIVE.test(decodeURIComponent(u.pathname).replace(/[-_/]+/g, ' '))) return 'sign-out or destructive';
  if (FILE.test(u.pathname)) return 'a file';
  if (/^\/(lightning\/setup|_ui\/|secur\/|setup\/)/i.test(u.pathname) || /\/logout\b/i.test(u.pathname)) return 'Salesforce Setup or sign-out';
  if (exclude.some((p) => globMatch(p, u.pathname))) return 'excluded';
  return null;
}

export function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(path);
}

/** Parse Playwright's aria snapshot (YAML-like) into nodes; links carry their /url. */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  let lastLink: AriaNode | undefined;
  for (const line of snapshot.split('\n')) {
    const url = /^\s*-\s*\/url:\s*(.+)$/.exec(line);
    if (url && lastLink) {
      lastLink.url = url[1].trim().replace(/^"(.*)"$/, '$1');
      continue;
    }
    const m = /^\s*-\s*([a-z]+)\s+"((?:[^"\\]|\\.)*)"(.*)$/.exec(line);
    if (!m) continue;
    const node: AriaNode = { role: m[1], name: m[2].replace(/\\"/g, '"').trim() };
    const level = /\[level=(\d)\]/.exec(m[3]);
    if (level) node.level = Number(level[1]);
    nodes.push(node);
    lastLink = node.role === 'link' ? node : undefined;
  }
  return nodes;
}

const ROLE_SUFFIX: Record<string, string> = {
  button: 'Button', link: 'Link', textbox: 'Field', searchbox: 'Search', spinbutton: 'Field', combobox: 'Select', listbox: 'List',
  checkbox: 'Checkbox', radio: 'Option', switch: 'Switch', tab: 'Tab', menuitem: 'Menu', heading: 'Title',
};
export const INTERACTIVE = new Set(Object.keys(ROLE_SUFFIX));

/** "Account name *" → AccountName (letters and digits, words capitalised). */
export function ident(text: string, max = 40): string {
  const words = text.normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, max);
  return /^[A-Za-z]/.test(out) ? out : out ? `X${out}` : '';
}

/** Name of a screen: its heading, else its title, else its path. */
export function pageName(heading: string | undefined, title: string, pattern: string): string {
  const fromPath = pattern.split('/').filter((s) => s && s !== ':id').map((s) => ident(s)).join('') || 'Home';
  return ident(heading ?? '', 30) || ident(title, 30) || fromPath;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Elements of a screen worth naming: interactive ones and the main heading, with the steadiest locator. */
export function elementsOf(nodes: AriaNode[], testIds: Array<{ testId: string; name: string }>, screen: string): DiscoveredElement[] {
  const out: DiscoveredElement[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!INTERACTIVE.has(n.role) || !n.name || n.name.length > 80) continue;
    if (n.role === 'heading' && n.level !== 1) continue;
    const key = `${n.role}|${n.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = `${screen}.${ident(n.name, 30) || 'Item'}${ROLE_SUFFIX[n.role] && !ident(n.name).endsWith(ROLE_SUFFIX[n.role]) ? ROLE_SUFFIX[n.role] : ''}`;
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}${i}`;
    used.add(name.toLowerCase());
    const roleLocator = `role=${n.role}[name="${q(n.name)}"]`;
    const tid = testIds.find((t) => t.name && t.name.trim().toLowerCase() === n.name.trim().toLowerCase());
    out.push(tid
      ? { name, role: n.role, label: n.name, locator: `[data-testid="${q(tid.testId)}"]`, alternatives: [roleLocator] }
      : { name, role: n.role, label: n.name, locator: roleLocator });
  }
  return out;
}

/** Paths tests already visit (navigate targets), as patterns. */
export function coveredPatterns(tests: Array<{ steps: TestStep[] }>, baseUrl: string): Set<string> {
  const out = new Set<string>();
  for (const t of tests) {
    for (const s of t.steps ?? []) {
      if (!/^(navigate|go ?to|open|visit)/i.test(s.action) || !s.target || /\{\{/.test(s.target)) continue;
      try {
        out.add(urlPattern(new URL(s.target, baseUrl).toString()));
      } catch {
        // not a URL
      }
    }
    if (!(t.steps ?? []).some((s) => /^(navigate|go ?to|open|visit)/i.test(s.action))) out.add(urlPattern(baseUrl));
  }
  return out;
}

/** A smoke test per screen nobody tests yet: it opens and shows its main parts (pure). */
export function proposeSmokeTests(pages: DiscoveredPage[], baseUrl: string, loginAs?: string): ProposedTest[] {
  return pages.filter((p) => !p.covered).map((p) => {
    const path = new URL(p.url).pathname + new URL(p.url).search;
    const title = p.elements.find((e) => e.role === 'heading');
    const key = p.elements.filter((e) => ['button', 'textbox', 'combobox', 'searchbox', 'checkbox'].includes(e.role)).slice(0, 3);
    const steps: ProposedTest['steps'] = [{ action: 'navigate', target: path }];
    if (title) steps.push({ action: 'assert_visible', target: `{{el.${title.name}}}` });
    else if (p.title) steps.push({ action: 'assert_title', data: { value: p.title } });
    for (const e of key) steps.push({ action: 'assert_visible', target: `{{el.${e.name}}}` });
    return {
      title: `${p.heading || p.title || p.name} screen shows its main parts${p.pattern.includes(':id') ? ' (example record)' : ''}`,
      module: p.name, steps, page: p.pattern, source: 'rules' as const,
      elements: [title, ...key].filter(Boolean).map((e) => e!.name),
      ...(loginAs ? { data: { login_as: loginAs } } : {}),
    };
  }).filter((t) => t.steps.length > 1 && new URL(baseUrl).origin);
}

// ── crawling ─────────────────────────────────────────────────────────────────

/** In the page: elements with data-testid (also inside open shadow roots) and a name for each. */
const TESTID_SCRIPT = `() => {
  const out = [];
  const walk = (root) => {
    root.querySelectorAll('[data-testid], [data-test-id], [data-test]').forEach((el) => {
      const id = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      const name = el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || el.getAttribute('title') || (el.innerText || el.value || '').trim();
      out.push({ testId: id, name: String(name || '').replace(/\\s+/g, ' ').trim().slice(0, 80) });
    });
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  return out.slice(0, 500);
}`;

export async function crawl(agent: Agent, opts: DiscoveryOptions, progress: (p: { pages: number; current?: string }) => void, cancelled: () => boolean): Promise<{ pages: DiscoveredPage[]; skipped: Record<string, number>; signedInAs?: string }> {
  const { decryptAgentConfig } = await import('../../core/domain/agent-secrets.js');
  const { launchBrowser } = await import('../execution/browser.js');
  const config = decryptAgentConfig(agent.config);
  const base = String(config.base_url);
  const browser = await launchBrowser();
  const skipped: Record<string, number> = {};
  const pages: DiscoveredPage[] = [];
  const deadline = Date.now() + DISCOVERY_LIMITS.minutes * 60_000;
  let signedInAs: string | undefined;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    // Sign in as the chosen test user (or the agent's default one)
    const who = opts.loginAs ?? config.auth?.default_profile ?? (config.salesforce ? config.salesforce.default_persona ?? config.salesforce.personas?.[0]?.name : undefined);
    if (who || config.salesforce) {
      const { SessionVault } = await import('../auth/session-vault.js');
      const vault = new SessionVault();
      const { authSettings } = await import('../auth/profiles.js');
      const { AppSessions } = await import('../auth/app-login.js');
      const auth = authSettings(config);
      if (auth && who && auth.profiles.some((p) => p.name.toLowerCase() === String(who).toLowerCase())) {
        await new AppSessions(auth, base, { agentId: agent.id, vault }).login(page, who);
        signedInAs = who;
      } else {
        const { salesforceSettings } = await import('../salesforce/personas.js');
        const { SalesforceSessions } = await import('../salesforce/session.js');
        const sf = salesforceSettings(config);
        if (sf) {
          const r = await new SalesforceSessions(sf, { agentId: agent.id, vault }).login(page, who);
          signedInAs = r.persona.name;
        }
      }
    }

    const queue: Array<{ url: string; depth: number }> = (opts.startPaths.length ? opts.startPaths : ['/']).map((p) => ({ url: new URL(p, base.endsWith('/') ? base : `${base}/`).toString(), depth: 0 }));
    if (signedInAs && page.url() !== 'about:blank' && new URL(page.url()).origin === new URL(base).origin) queue.unshift({ url: page.url(), depth: 0 });
    const seen = new Set<string>();
    const queued = new Set(queue.map((x) => urlPattern(x.url)));
    while (queue.length && pages.length < opts.maxPages && Date.now() < deadline && !cancelled()) {
      const { url, depth } = queue.shift()!;
      const pattern = urlPattern(url);
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      progress({ pages: pages.length, current: pattern });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
      } catch (e: any) {
        skipped['did not load'] = (skipped['did not load'] ?? 0) + 1;
        logger.warn('Discovery: page did not load', { url, error: e.message });
        continue;
      }
      const landed = urlPattern(page.url());
      if (new URL(page.url()).origin !== new URL(base).origin) {
        skipped['left the site'] = (skipped['left the site'] ?? 0) + 1;
        continue;
      }
      // Sent elsewhere (sign-in page, redirect): recorded under where it landed, once
      if (landed !== pattern) {
        if (seen.has(landed)) continue;
        seen.add(landed);
      }
      const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10_000 }).catch(() => '');
      const nodes = parseAriaSnapshot(snapshot);
      const testIds = (await page.evaluate(`(${TESTID_SCRIPT})()`).catch(() => [])) as Array<{ testId: string; name: string }>;
      const title = await page.title().catch(() => '');
      const heading = nodes.find((n) => n.role === 'heading' && n.level === 1)?.name ?? nodes.find((n) => n.role === 'heading')?.name;
      const name = uniqueName(pageName(heading, title, landed), pages);
      // Links: from the accessibility tree (also inside web components) and plain anchors
      const anchors = (await page.$$eval('a[href]', (els) => els.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent || '').trim() })).slice(0, 400)).catch(() => [])) as Array<{ href: string; text: string }>;
      const links = [...nodes.filter((n) => n.role === 'link' && n.url).map((n) => ({ href: n.url!, text: n.name })), ...anchors];
      let count = 0;
      for (const l of links) {
        const why = skipReason(l.href, l.text, page.url(), opts.exclude);
        if (why) {
          skipped[why] = (skipped[why] ?? 0) + 1;
          continue;
        }
        const abs = new URL(l.href, page.url()).toString();
        const p = urlPattern(abs);
        count++;
        if (depth + 1 <= opts.maxDepth && !queued.has(p)) {
          queued.add(p);
          queue.push({ url: abs.split('#')[0], depth: depth + 1 });
        }
      }
      pages.push({ url: page.url(), pattern: landed, title, heading, name, depth, elements: elementsOf(nodes, testIds, name), links: count });
    }
    progress({ pages: pages.length });
    return { pages, skipped, signedInAs };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function uniqueName(name: string, pages: DiscoveredPage[]): string {
  let n = name;
  for (let i = 2; pages.some((p) => p.name === n); i++) n = `${name}${i}`;
  return n;
}

// ── storage and jobs ──────────────────────────────────────────────────────────

export interface Discovery {
  id: string; projectId: string; agentId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; options: DiscoveryOptions;
  progress: { pages: number; current?: string }; pages: DiscoveredPage[]; proposals: ProposedTest[]; skipped: Record<string, number>;
  signedInAs?: string; error?: string; startedAt: string; finishedAt?: string; createdBy?: string;
}

export class DiscoveryRepository {
  private db = getDatabaseClient();

  private map(r: any): Discovery {
    return {
      id: r.id, projectId: r.project_id, agentId: r.agent_id, status: r.status, options: r.options, progress: r.progress ?? { pages: 0 },
      pages: r.pages ?? [], proposals: r.proposals ?? [], skipped: r.skipped ?? {}, signedInAs: r.signed_in_as ?? undefined, error: r.error ?? undefined,
      startedAt: r.started_at, finishedAt: r.finished_at ?? undefined, createdBy: r.created_by ?? undefined,
    };
  }

  async create(projectId: string, agentId: string, options: DiscoveryOptions, user?: string): Promise<Discovery> {
    const r = await this.db.query(
      `INSERT INTO discoveries (id, project_id, agent_id, status, options, created_by) VALUES ($1, $2, $3, 'running', $4, $5) RETURNING *`,
      [`DSC-${crypto.randomUUID()}`, projectId, agentId, JSON.stringify(options), user ?? null],
    );
    return this.map(r.rows[0]);
  }

  async get(id: string, projectId: string): Promise<Discovery | null> {
    const r = (await this.db.query('SELECT * FROM discoveries WHERE id = $1 AND project_id = $2', [id, projectId])).rows[0];
    return r ? this.map(r) : null;
  }

  async list(projectId: string, agentId?: string): Promise<Discovery[]> {
    const r = await this.db.query(
      `SELECT * FROM discoveries WHERE project_id = $1 ${agentId ? 'AND agent_id = $2' : ''} ORDER BY started_at DESC LIMIT 20`,
      agentId ? [projectId, agentId] : [projectId],
    );
    return r.rows.map((x) => this.map(x));
  }

  async running(projectId: string): Promise<boolean> {
    return ((await this.db.query("SELECT 1 FROM discoveries WHERE project_id = $1 AND status = 'running' AND started_at > now() - interval '30 minutes'", [projectId])).rowCount ?? 0) > 0;
  }

  async progress(id: string, progress: Discovery['progress']): Promise<void> {
    await this.db.query('UPDATE discoveries SET progress = $2 WHERE id = $1', [id, JSON.stringify(progress)]);
  }

  async finish(id: string, patch: Partial<Pick<Discovery, 'status' | 'pages' | 'proposals' | 'skipped' | 'signedInAs' | 'error'>>): Promise<void> {
    await this.db.query(
      `UPDATE discoveries SET status = $2, pages = COALESCE($3, pages), proposals = COALESCE($4, proposals), skipped = COALESCE($5, skipped),
              signed_in_as = COALESCE($6, signed_in_as), error = $7, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, patch.status, patch.pages ? JSON.stringify(patch.pages) : null, patch.proposals ? JSON.stringify(patch.proposals) : null,
        patch.skipped ? JSON.stringify(patch.skipped) : null, patch.signedInAs ?? null, patch.error ?? null],
    );
  }

  /** Discoveries still "running" after a restart are over. */
  async failInterrupted(): Promise<void> {
    await this.db.query("UPDATE discoveries SET status = 'failed', error = 'Interrupted by a server restart', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'");
  }
}

const cancels = new Map<string, () => void>();
export const cancelDiscovery = (id: string) => cancels.get(id)?.();

/** Crawl in the background, then mark coverage and propose tests (rules; the AI too when there is a provider). */
export async function runDiscovery(discovery: Discovery, agent: Agent): Promise<void> {
  const repo = new DiscoveryRepository();
  let stop = false;
  cancels.set(discovery.id, () => { stop = true; });
  let lastSave = 0;
  try {
    const result = await crawl(agent, discovery.options, (p) => {
      if (Date.now() - lastSave > 1000) {
        lastSave = Date.now();
        void repo.progress(discovery.id, p).catch(() => undefined);
      }
    }, () => stop);
    // Screens the agent's own tests visit (its test selection), not every test of the project
    const { PlannerAgentService } = await import('../agents/services/planner-agent.service.js');
    const plan = await new PlannerAgentService().createTestPlan(agent.config, agent.projectId).catch(() => null);
    const covered = coveredPatterns((plan?.testCases ?? []) as Array<{ steps: TestStep[] }>, agent.config.base_url);
    for (const p of result.pages) p.covered = covered.has(p.pattern);
    const proposals = proposeSmokeTests(result.pages, agent.config.base_url, result.signedInAs);
    proposals.push(...await aiProposals(result.pages.filter((p) => !p.covered), agent, result.signedInAs).catch((e) => {
      logger.warn('Discovery: AI proposals failed', { error: e.message });
      return [];
    }));
    await repo.finish(discovery.id, { status: stop ? 'cancelled' : 'completed', pages: result.pages, proposals, skipped: result.skipped, signedInAs: result.signedInAs });
  } catch (e: any) {
    logger.warn('Discovery failed', { id: discovery.id, error: e.message });
    await repo.finish(discovery.id, { status: 'failed', error: String(e.message).split('\n')[0] });
  } finally {
    cancels.delete(discovery.id);
  }
}

/** With an AI provider: up to two functional tests per uncovered screen, using the screen's elements. */
async function aiProposals(pages: DiscoveredPage[], agent: Agent, loginAs?: string): Promise<ProposedTest[]> {
  const { getLLMRouter } = await import('../../infra/llm/router.js');
  const router = getLLMRouter();
  if (!router.hasAnyProvider() || !pages.length) return [];
  const { extractJsonArray } = await import('../../infra/llm/json.js');
  const { cleanAiSteps } = await import('../authoring/plain-english.js');
  const screens = pages.slice(0, 12).map((p) => `Screen ${p.name} (${p.pattern}, example ${new URL(p.url).pathname}):\n${p.elements.slice(0, 30).map((e) => `  {{el.${e.name}}} = ${e.role} "${e.label}"`).join('\n')}`).join('\n\n');
  const response = await router.chat([
    { role: 'system', content: 'You write functional UI tests for screens of an application. Reply with JSON only: [{"screen": "<name>", "title": "...", "steps": [{"action": "...", "target": "...", "data": {...}}]}]. ' +
      'Actions: navigate, click, fill (data.value), select (data.value), check, assert_visible, assert_text (data.value), assert_url (data.value). Targets: only the {{el.Name}} elements listed for the screen, or a path for navigate. ' +
      'Use {{fake.email}}, {{fake.fullName}}, {{fake.word}} for values. At most two tests per screen; skip screens where nothing meaningful can be tested. Never delete or submit payments.' },
    { role: 'user', content: screens },
  ], 'codegen', { preferred: agent.config?.ai?.provider, maxTokens: 3000 });
  const out: ProposedTest[] = [];
  for (const t of extractJsonArray(response.content)) {
    const page = pages.find((p) => p.name === t?.screen);
    if (!page || typeof t.title !== 'string') continue;
    const allowed = new Set(page.elements.map((e) => e.name));
    const steps = cleanAiSteps(t.steps, { blocks: [], elements: [] })
      .filter((s) => !s.target || s.action === 'navigate' || [...String(s.target).matchAll(/\{\{el\.([\w.]+)\}\}/g)].every((m) => allowed.has(m[1])));
    if (steps.length < 2) continue;
    const used = [...new Set(JSON.stringify(steps).match(/\{\{el\.([\w.]+)\}\}/g)?.map((m) => m.slice(5, -2)) ?? [])];
    out.push({ title: t.title.slice(0, 200), module: page.name, steps, page: page.pattern, source: 'ai', elements: used, ...(loginAs ? { data: { login_as: loginAs } } : {}) });
  }
  return out;
}
