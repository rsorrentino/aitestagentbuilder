/**
 * Project library: reusable step blocks and named elements.
 *
 *  - A block is a named list of steps with parameters ("Log in as {{param.user}}", "Create
 *    opportunity"). Tests use it with { action: "use_block", target: "<block name>",
 *    data: { params: { user: "rep" } } }; blocks may use other blocks. Changing a block changes
 *    every test that uses it.
 *  - An element is a named locator ("Checkout.Total" → [data-testid="order-total"]). Steps use it
 *    as {{el.Checkout.Total}}; when the UI changes, the element is fixed once (or self-healed once)
 *    for every test.
 */

import crypto from 'crypto';
import getDatabaseClient from '../../infra/db/client.js';
import type { TestStep } from '../../core/domain/test-case.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { applyHealing, HealedStep } from '../quality/healing.js';

export interface BlockParam { name: string; description?: string; default?: string }
export interface StepBlock {
  id: string; projectId: string; name: string; description?: string; params: BlockParam[]; steps: TestStep[];
  createdAt: string; updatedAt: string; createdBy?: string; updatedBy?: string;
}
export interface LibraryElement {
  id: string; projectId: string; name: string; locator: string; alternatives: string[]; description?: string; pageUrl?: string;
  source: 'manual' | 'recorder' | 'discovery' | 'healed'; healedAt?: string; createdAt: string; updatedAt: string; createdBy?: string;
}

/** Where a step of an expanded test comes from (a block, possibly nested). */
export interface StepOrigin { block: string; blockStepId: number; path: string }
export type RunStep = TestStep & { origin?: StepOrigin };

export const ELEMENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ELEMENT_REF = /\{\{\s*el\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const PARAM_REF = /\{\{\s*param\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export const MAX_BLOCK_DEPTH = 5;

export class LibraryError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

const mapStrings = (v: any, fn: (s: string) => string): any => {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
};

/**
 * Replace use_block steps by the block's steps (parameters filled in), recursively.
 * Steps of a block keep the use_block step's number and say where they come from.
 */
export function expandSteps(steps: TestStep[], blocks: Map<string, Pick<StepBlock, 'name' | 'params' | 'steps'>>, depth = 0, parentPath = '', chain: string[] = []): RunStep[] {
  const out: RunStep[] = [];
  for (const step of steps ?? []) {
    if (step.action !== 'use_block') {
      out.push(step);
      continue;
    }
    const name = String(step.target ?? '').trim();
    const block = blocks.get(name.toLowerCase());
    const here = parentPath ? `${parentPath}.${step.stepId}` : String(step.stepId);
    if (!block) throw new LibraryError(`Step ${here}: unknown block "${name}" (Library → Blocks)`);
    if (chain.includes(block.name.toLowerCase())) throw new LibraryError(`Block "${block.name}" uses itself (${[...chain, block.name.toLowerCase()].join(' → ')})`);
    if (depth >= MAX_BLOCK_DEPTH) throw new LibraryError(`Blocks are nested more than ${MAX_BLOCK_DEPTH} levels deep at "${block.name}"`);
    const given: Record<string, any> = step.data?.params ?? {};
    const unknown = Object.keys(given).filter((k) => !block.params.some((p) => p.name === k));
    if (unknown.length) throw new LibraryError(`Step ${here}: block "${block.name}" has no parameter ${unknown.map((u) => `"${u}"`).join(', ')} (it has: ${block.params.map((p) => p.name).join(', ') || 'none'})`);
    const values: Record<string, string> = {};
    for (const p of block.params) {
      const v = given[p.name] ?? p.default;
      if (v === undefined || v === null) throw new LibraryError(`Step ${here}: block "${block.name}" needs the parameter "${p.name}"`);
      values[p.name] = String(v);
    }
    const filled = block.steps.map((s) => mapStrings(s, (text) => text.replace(PARAM_REF, (_m, n) => {
      if (!(n in values)) throw new LibraryError(`Block "${block.name}" uses {{param.${n}}}, which is not one of its parameters`);
      return values[n];
    })) as TestStep);
    for (const [i, fs] of filled.entries()) {
      const blockStepId = fs.stepId ?? i + 1;
      if (fs.action === 'use_block') {
        // Nested block: its steps keep the origin of the innermost block (where a repaired selector is saved)
        const inner = expandSteps([{ ...fs, stepId: blockStepId }], blocks, depth + 1, here, [...chain, block.name.toLowerCase()]);
        out.push(...inner.map((s) => ({ ...s, stepId: step.stepId })));
      } else {
        out.push({ ...fs, stepId: step.stepId, origin: { block: block.name, blockStepId, path: `${here}.${blockStepId}` } });
      }
    }
  }
  return out;
}

/** Replace {{el.Name}} with the element's locator (unknown elements throw). */
export function resolveElements(text: string, elements: Map<string, Pick<LibraryElement, 'name' | 'locator'>>): string {
  return text.replace(ELEMENT_REF, (_m, name) => {
    const el = elements.get(String(name).toLowerCase());
    if (!el) throw new LibraryError(`Unknown element {{el.${name}}} (Library → Elements)`);
    return el.locator;
  });
}

/** The element a target is exactly ("{{el.Checkout.Total}}"), if any. */
export function elementRef(target?: string): string | undefined {
  const m = /^\s*\{\{\s*el\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}\s*$/.exec(target ?? '');
  return m?.[1];
}

export function elementNamesIn(steps: TestStep[]): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(steps ?? []).matchAll(ELEMENT_REF)) names.add(m[1]);
  return [...names];
}

export function validateBlock(input: any, partial = false): string[] {
  const errors: string[] = [];
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) errors.push('name is required (up to 200 characters)');
  }
  if (input.params !== undefined) {
    if (!Array.isArray(input.params)) errors.push('params must be a list of { name, description?, default? }');
    else {
      const seen = new Set<string>();
      for (const p of input.params) {
        if (!p || !PARAM_NAME_RE.test(String(p.name ?? ''))) errors.push(`params: "${p?.name ?? ''}" is not a valid name (letters, digits, underscore)`);
        else if (seen.has(p.name)) errors.push(`params: "${p.name}" is listed twice`);
        else seen.add(p.name);
      }
    }
  }
  if (!partial || input.steps !== undefined) {
    if (!Array.isArray(input.steps) || !input.steps.length) errors.push('steps must be a non-empty list');
    else if (input.steps.some((s: any) => !s || typeof s.action !== 'string' || !s.action.trim())) errors.push('every step needs an action');
    else {
      const names = new Set((input.params ?? []).map((p: any) => p?.name));
      const used = new Set<string>();
      for (const m of JSON.stringify(input.steps).matchAll(PARAM_REF)) used.add(m[1]);
      const missing = [...used].filter((u) => !names.has(u));
      if (missing.length && input.params !== undefined) errors.push(`steps use ${missing.map((m) => `{{param.${m}}}`).join(', ')} but params does not declare ${missing.length === 1 ? 'it' : 'them'}`);
    }
  }
  return errors;
}

export function validateElement(input: any, partial = false): string[] {
  const errors: string[] = [];
  if (!partial || input.name !== undefined) {
    if (!ELEMENT_NAME_RE.test(String(input.name ?? ''))) errors.push('name must be letters, digits and underscores, with dots for groups (e.g. Checkout.Total, Login.SubmitButton)');
  }
  if (!partial || input.locator !== undefined) {
    if (typeof input.locator !== 'string' || !input.locator.trim()) errors.push('locator is required, e.g. [data-testid="order-total"], role=button[name="Save"], text=Total');
    else if (/\{\{\s*el\./.test(input.locator)) errors.push('locator cannot use another element');
  }
  if (input.alternatives !== undefined && (!Array.isArray(input.alternatives) || input.alternatives.some((a: any) => typeof a !== 'string' || !a.trim()))) {
    errors.push('alternatives must be a list of locators');
  }
  return errors;
}

/** Numbered steps (1, 2, …) as stored. */
const numbered = (steps: any[]): TestStep[] => steps.map((s, i) => ({ ...s, stepId: i + 1 }));

// ── storage ───────────────────────────────────────────────────────────────────

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export class BlockRepository {
  private db = getDatabaseClient();

  private map(r: any): StepBlock {
    return {
      id: r.id, projectId: r.project_id, name: r.name, description: r.description ?? undefined, params: r.params ?? [], steps: r.steps ?? [],
      createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by ?? undefined, updatedBy: r.updated_by ?? undefined,
    };
  }

  async list(projectId: string): Promise<StepBlock[]> {
    return (await this.db.query('SELECT * FROM step_blocks WHERE project_id = $1 ORDER BY lower(name)', [projectId])).rows.map((r) => this.map(r));
  }

  async get(blockId: string, projectId: string): Promise<StepBlock | null> {
    const r = (await this.db.query('SELECT * FROM step_blocks WHERE id = $1 AND project_id = $2', [blockId, projectId])).rows[0];
    return r ? this.map(r) : null;
  }

  async byName(projectId: string): Promise<Map<string, StepBlock>> {
    return new Map((await this.list(projectId)).map((b) => [b.name.toLowerCase(), b]));
  }

  async create(projectId: string, input: { name: string; description?: string; params?: BlockParam[]; steps: TestStep[] }, user?: string): Promise<StepBlock> {
    try {
      const r = await this.db.query(
        `INSERT INTO step_blocks (id, project_id, name, description, params, steps, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [id('BLK'), projectId, input.name.trim(), input.description ?? null, JSON.stringify(input.params ?? []), JSON.stringify(numbered(input.steps)), user ?? null],
      );
      return this.map(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') throw new LibraryError(`A block named "${input.name.trim()}" already exists`, 409);
      throw e;
    }
  }

  async update(blockId: string, projectId: string, input: Partial<{ name: string; description: string; params: BlockParam[]; steps: TestStep[] }>, user?: string): Promise<StepBlock | null> {
    const current = await this.get(blockId, projectId);
    if (!current) return null;
    try {
      const r = await this.db.query(
        `UPDATE step_blocks SET name = $3, description = $4, params = $5, steps = $6, updated_at = CURRENT_TIMESTAMP, updated_by = $7 WHERE id = $1 AND project_id = $2 RETURNING *`,
        [blockId, projectId, (input.name ?? current.name).trim(), input.description !== undefined ? input.description || null : current.description ?? null,
          JSON.stringify(input.params ?? current.params), JSON.stringify(input.steps ? numbered(input.steps) : current.steps), user ?? null],
      );
      // Renamed: tests and blocks using the old name follow
      if (input.name && input.name.trim() !== current.name) await this.rename(projectId, current.name, input.name.trim());
      return this.map(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') throw new LibraryError(`A block named "${input.name?.trim()}" already exists`, 409);
      throw e;
    }
  }

  private async rename(projectId: string, from: string, to: string): Promise<void> {
    const swap = (steps: any[]) => steps.map((s) => (s.action === 'use_block' && String(s.target ?? '').toLowerCase() === from.toLowerCase() ? { ...s, target: to } : s));
    for (const table of ['test_cases', 'step_blocks']) {
      const rows = (await this.db.query(`SELECT id, steps FROM ${table} WHERE project_id = $1 AND steps @> $2::jsonb`, [projectId, JSON.stringify([{ action: 'use_block' }])])).rows;
      for (const r of rows) {
        const next = swap(r.steps ?? []);
        if (JSON.stringify(next) !== JSON.stringify(r.steps)) await this.db.query(`UPDATE ${table} SET steps = $2 WHERE id = $1`, [r.id, JSON.stringify(next)]);
      }
    }
  }

  async delete(blockId: string, projectId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM step_blocks WHERE id = $1 AND project_id = $2', [blockId, projectId])).rowCount ?? 0) > 0;
  }

  /** Tests and blocks that use a block. */
  async usage(projectId: string, name: string): Promise<{ tests: Array<{ id: string; title: string }>; blocks: Array<{ id: string; name: string }> }> {
    const uses = (steps: any[]) => (steps ?? []).some((s) => s.action === 'use_block' && String(s.target ?? '').toLowerCase() === name.toLowerCase());
    const filter = JSON.stringify([{ action: 'use_block' }]);
    const tests = (await this.db.query('SELECT id, title, steps FROM test_cases WHERE project_id = $1 AND steps @> $2::jsonb ORDER BY title', [projectId, filter])).rows.filter((r) => uses(r.steps));
    const blocks = (await this.db.query('SELECT id, name, steps FROM step_blocks WHERE project_id = $1 AND steps @> $2::jsonb ORDER BY name', [projectId, filter])).rows.filter((r) => uses(r.steps));
    return { tests: tests.map((r) => ({ id: r.id, title: r.title })), blocks: blocks.map((r) => ({ id: r.id, name: r.name })) };
  }

  /** Save a selector repaired while running a block step (only if the step still has the broken one). */
  async heal(projectId: string, name: string, blockStepId: number, from: string, to: string): Promise<boolean> {
    const block = (await this.byName(projectId)).get(name.toLowerCase());
    if (!block) return false;
    let changed = false;
    const steps = block.steps.map((s) => (s.stepId === blockStepId && s.target === from ? ((changed = true), { ...s, target: to }) : s));
    if (changed) await this.db.query('UPDATE step_blocks SET steps = $2, updated_at = CURRENT_TIMESTAMP, updated_by = $3 WHERE id = $1', [block.id, JSON.stringify(steps), 'self-healing']);
    return changed;
  }
}

export class ElementRepository {
  private db = getDatabaseClient();

  private map(r: any): LibraryElement {
    return {
      id: r.id, projectId: r.project_id, name: r.name, locator: r.locator, alternatives: r.alternatives ?? [], description: r.description ?? undefined,
      pageUrl: r.page_url ?? undefined, source: r.source, healedAt: r.healed_at ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by ?? undefined,
    };
  }

  async list(projectId: string): Promise<LibraryElement[]> {
    return (await this.db.query('SELECT * FROM elements WHERE project_id = $1 ORDER BY lower(name)', [projectId])).rows.map((r) => this.map(r));
  }

  async get(elementId: string, projectId: string): Promise<LibraryElement | null> {
    const r = (await this.db.query('SELECT * FROM elements WHERE id = $1 AND project_id = $2', [elementId, projectId])).rows[0];
    return r ? this.map(r) : null;
  }

  async byName(projectId: string): Promise<Map<string, LibraryElement>> {
    return new Map((await this.list(projectId)).map((e) => [e.name.toLowerCase(), e]));
  }

  async create(projectId: string, input: { name: string; locator: string; alternatives?: string[]; description?: string; pageUrl?: string; source?: LibraryElement['source'] }, user?: string): Promise<LibraryElement> {
    try {
      const r = await this.db.query(
        `INSERT INTO elements (id, project_id, name, locator, alternatives, description, page_url, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id('EL'), projectId, input.name, input.locator.trim(), JSON.stringify(input.alternatives ?? []), input.description ?? null, input.pageUrl ?? null, input.source ?? 'manual', user ?? null],
      );
      return this.map(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') throw new LibraryError(`An element named "${input.name}" already exists`, 409);
      throw e;
    }
  }

  async update(elementId: string, projectId: string, input: Partial<{ name: string; locator: string; alternatives: string[]; description: string; pageUrl: string }>): Promise<LibraryElement | null> {
    const cur = await this.get(elementId, projectId);
    if (!cur) return null;
    try {
      const r = await this.db.query(
        `UPDATE elements SET name = $3, locator = $4, alternatives = $5, description = $6, page_url = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND project_id = $2 RETURNING *`,
        [elementId, projectId, input.name ?? cur.name, (input.locator ?? cur.locator).trim(), JSON.stringify(input.alternatives ?? cur.alternatives),
          input.description !== undefined ? input.description || null : cur.description ?? null, input.pageUrl !== undefined ? input.pageUrl || null : cur.pageUrl ?? null],
      );
      if (input.name && input.name !== cur.name) await this.rename(projectId, cur.name, input.name);
      return this.map(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') throw new LibraryError(`An element named "${input.name}" already exists`, 409);
      throw e;
    }
  }

  private async rename(projectId: string, from: string, to: string): Promise<void> {
    const re = new RegExp(`\\{\\{\\s*el\\.${from.replace(/\./g, '\\.')}\\s*\\}\\}`, 'gi');
    for (const table of ['test_cases', 'step_blocks']) {
      const rows = (await this.db.query(`SELECT id, steps FROM ${table} WHERE project_id = $1 AND steps::text ILIKE $2`, [projectId, `%el.${from}%`])).rows;
      for (const r of rows) {
        const next = mapStrings(r.steps ?? [], (t) => t.replace(re, `{{el.${to}}}`));
        if (JSON.stringify(next) !== JSON.stringify(r.steps)) await this.db.query(`UPDATE ${table} SET steps = $2 WHERE id = $1`, [r.id, JSON.stringify(next)]);
      }
    }
  }

  async delete(elementId: string, projectId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM elements WHERE id = $1 AND project_id = $2', [elementId, projectId])).rowCount ?? 0) > 0;
  }

  async usage(projectId: string, name: string): Promise<{ tests: Array<{ id: string; title: string }>; blocks: Array<{ id: string; name: string }> }> {
    const uses = (steps: any) => elementNamesIn(steps).some((n) => n.toLowerCase() === name.toLowerCase());
    const like = `%el.${name}%`;
    const tests = (await this.db.query('SELECT id, title, steps FROM test_cases WHERE project_id = $1 AND steps::text ILIKE $2 ORDER BY title', [projectId, like])).rows.filter((r) => uses(r.steps));
    const blocks = (await this.db.query('SELECT id, name, steps FROM step_blocks WHERE project_id = $1 AND steps::text ILIKE $2 ORDER BY name', [projectId, like])).rows.filter((r) => uses(r.steps));
    return { tests: tests.map((r) => ({ id: r.id, title: r.title })), blocks: blocks.map((r) => ({ id: r.id, name: r.name })) };
  }

  /** A repaired locator: the element takes it, the old one is kept as an alternative (only if it was still the broken one). */
  async heal(projectId: string, name: string, from: string, to: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE elements SET locator = $4, alternatives = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(alternatives || to_jsonb($3::text)) x),
              source = 'healed', healed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = $1 AND lower(name) = lower($2) AND locator = $3`,
      [projectId, name, from, to],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

/**
 * Save repaired selectors where they belong: the library element the step used ({{el.Name}}),
 * the library block the step came from, or the test case. Each place is only changed while it
 * still has the broken selector.
 */
export async function saveHealing(projectId: string, testCaseId: string, healed: HealedStep[], only?: number[]): Promise<{ applied: Array<HealedStep & { savedTo: string }>; skipped: HealedStep[] }> {
  const wanted = only?.length ? healed.filter((h) => only.includes(h.stepId)) : healed;
  const applied: Array<HealedStep & { savedTo: string }> = [];
  const skipped: HealedStep[] = [];
  const forTest: HealedStep[] = [];
  const elements = new ElementRepository();
  const blocks = new BlockRepository();
  for (const h of wanted) {
    const el = elementRef(h.from);
    if (el) {
      const current = (await elements.byName(projectId)).get(el.toLowerCase());
      if (current && (await elements.heal(projectId, current.name, current.locator, h.to))) applied.push({ ...h, savedTo: `element ${current.name}` });
      else skipped.push(h);
    } else if (h.block) {
      if (await blocks.heal(projectId, h.block, h.blockStepId ?? 0, h.from, h.to)) applied.push({ ...h, savedTo: `block ${h.block}` });
      else skipped.push(h);
    } else forTest.push(h);
  }
  if (forTest.length) {
    const repo = new TestCaseRepository();
    const tc = await repo.findById(testCaseId, projectId);
    if (!tc) skipped.push(...forTest);
    else {
      const r = applyHealing(tc.steps, forTest);
      if (r.applied.length) await repo.update(tc.id, { steps: r.steps }, projectId);
      applied.push(...r.applied.map((h) => ({ ...h, savedTo: 'test case' })));
      skipped.push(...r.skipped);
    }
  }
  return { applied, skipped };
}
