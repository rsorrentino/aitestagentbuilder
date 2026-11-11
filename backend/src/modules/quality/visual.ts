/**
 * Visual regression: compare a screenshot with an approved baseline
 * (pixelmatch, ISC) and keep baselines per agent, name, persona and viewport.
 *
 * Files:  <ARTIFACTS_PATH>/baselines/<projectId>/<agentId>/<baselineId>.png
 *         <ARTIFACTS_PATH>/<runId>/<resultId>-visual-<n>-{actual,diff}.png
 */

import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Locator, Page } from 'playwright';
import getDatabaseClient from '../../infra/db/client.js';
import { ARTIFACTS_PATH } from '../../infra/config/paths.js';

export interface CompareResult {
  sizeMismatch: boolean;
  width: number;
  height: number;
  diffPixels: number;
  ratio: number;
  diffPng?: Buffer;
}

/** Pixel comparison. threshold: per-pixel color tolerance 0..1 (pixelmatch), anti-aliasing ignored. */
export function compareScreenshots(baseline: Buffer, actual: Buffer, threshold = 0.1): CompareResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, width: b.width, height: b.height, diffPixels: b.width * b.height, ratio: 1 };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: false });
  return {
    sizeMismatch: false,
    width: a.width,
    height: a.height,
    diffPixels,
    ratio: diffPixels / (a.width * a.height),
    diffPng: diffPixels > 0 ? PNG.sync.write(diff) : undefined,
  };
}

export interface VisualBaseline {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  persona: string;
  viewport: string;
  path: string;
  width: number;
  height: number;
  sourceRunId?: string;
  approvedBy?: string;
  updatedAt: Date;
}

/** Artifact-relative path of a baseline image (signed for display like run screenshots). */
export const baselineRelPath = (projectId: string, agentId: string, id: string) => `baselines/${projectId}/${agentId}/${id}.png`;
const abs = (rel: string) => join(ARTIFACTS_PATH, ...rel.split('/'));

const fromRow = (r: any): VisualBaseline => ({
  id: r.id, projectId: r.project_id, agentId: r.agent_id, name: r.name, persona: r.persona, viewport: r.viewport,
  path: r.path, width: r.width, height: r.height, sourceRunId: r.source_run_id ?? undefined,
  approvedBy: r.approved_by ?? undefined, updatedAt: r.updated_at,
});

export class VisualBaselineRepository {
  private db = getDatabaseClient();

  async find(agentId: string, name: string, persona: string, viewport: string): Promise<VisualBaseline | null> {
    const res = await this.db.query('SELECT * FROM visual_baselines WHERE agent_id = $1 AND name = $2 AND persona = $3 AND viewport = $4',
      [agentId, name, persona, viewport]);
    return res.rows[0] ? fromRow(res.rows[0]) : null;
  }

  async list(projectId: string, agentId?: string): Promise<VisualBaseline[]> {
    const res = await this.db.query(
      `SELECT * FROM visual_baselines WHERE project_id = $1 ${agentId ? 'AND agent_id = $2' : ''} ORDER BY agent_id, name, persona, viewport`,
      agentId ? [projectId, agentId] : [projectId]);
    return res.rows.map(fromRow);
  }

  async findById(id: string, projectId: string): Promise<VisualBaseline | null> {
    const res = await this.db.query('SELECT * FROM visual_baselines WHERE id = $1 AND project_id = $2', [id, projectId]);
    return res.rows[0] ? fromRow(res.rows[0]) : null;
  }

  /** Store `image` (PNG) as the baseline, replacing any previous one. */
  async save(input: { projectId: string; agentId: string; name: string; persona: string; viewport: string; image: Buffer; sourceRunId?: string; approvedBy: string }): Promise<VisualBaseline> {
    const existing = await this.find(input.agentId, input.name, input.persona, input.viewport);
    const id = existing?.id ?? `VB-${crypto.randomUUID()}`;
    const rel = baselineRelPath(input.projectId, input.agentId, id);
    mkdirSync(dirname(abs(rel)), { recursive: true });
    writeFileSync(abs(rel), input.image);
    const { width, height } = PNG.sync.read(input.image);
    const res = await this.db.query(
      `INSERT INTO visual_baselines (id, project_id, agent_id, name, persona, viewport, path, width, height, source_run_id, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (agent_id, name, persona, viewport) DO UPDATE SET
         path = EXCLUDED.path, width = EXCLUDED.width, height = EXCLUDED.height,
         source_run_id = EXCLUDED.source_run_id, approved_by = EXCLUDED.approved_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [id, input.projectId, input.agentId, input.name, input.persona, input.viewport, rel, width, height, input.sourceRunId ?? null, input.approvedBy]);
    return fromRow(res.rows[0]);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM visual_baselines WHERE id = $1 AND project_id = $2 RETURNING path', [id, projectId]);
    if (!res.rows[0]) return false;
    rmSync(abs(res.rows[0].path), { force: true });
    return true;
  }
}

export interface VisualEntry {
  name: string;
  persona: string;
  viewport: string;
  status: 'passed' | 'failed' | 'created';
  ratio: number;
  diffPixels: number;
  maxDiffRatio: number;
  sizeMismatch?: boolean;
  baselineId?: string;
  baseline?: string;
  actual?: string;
  diff?: string;
  approved?: boolean;
}

export interface VisualCheckContext {
  projectId: string;
  agentId: string;
  runId: string;
  resultId: string;
  persona?: string;
  /** sequence number within the test, for unique file names */
  index: number;
}

/**
 * Take a screenshot (page or element) and compare it with the baseline.
 * Missing baseline: stored as the new baseline (on_missing "create", default) or fail ("fail").
 */
export async function checkScreenshot(
  page: Page,
  locator: Locator | null,
  name: string,
  ctx: VisualCheckContext,
  data: Record<string, any> = {},
): Promise<VisualEntry> {
  const viewportSize = page.viewportSize();
  const viewport = viewportSize ? `${viewportSize.width}x${viewportSize.height}` : 'auto';
  const persona = ctx.persona ?? '';
  const mask = (Array.isArray(data.mask) ? data.mask : data.mask ? [data.mask] : []).map((s: string) => page.locator(String(s)));
  const shotOpts = { animations: 'disabled' as const, caret: 'hide' as const, mask, timeout: 15000 };
  // Let fonts and late layout settle
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  const image = locator
    ? await locator.screenshot(shotOpts)
    : await page.screenshot({ ...shotOpts, fullPage: data.full_page === true || data.fullPage === true });

  const maxDiffRatio = Number(data.max_diff_ratio ?? data.maxDiffRatio ?? 0.001);
  const threshold = Number(data.threshold ?? 0.1);
  const repo = new VisualBaselineRepository();
  const baseline = await repo.find(ctx.agentId, name, persona, viewport);
  const base: Omit<VisualEntry, 'status' | 'ratio' | 'diffPixels'> = { name, persona, viewport, maxDiffRatio };

  if (!baseline || !existsSync(abs(baseline.path))) {
    if (String(data.on_missing ?? 'create') === 'fail') {
      throw new Error(`No approved baseline for screenshot "${name}" (${viewport}${persona ? `, ${persona}` : ''})`);
    }
    const saved = await repo.save({ projectId: ctx.projectId, agentId: ctx.agentId, name, persona, viewport, image, sourceRunId: ctx.runId, approvedBy: 'first run' });
    return { ...base, status: 'created', ratio: 0, diffPixels: 0, baselineId: saved.id, baseline: saved.path };
  }

  const result = compareScreenshots(readFileSync(abs(baseline.path)), image, threshold);
  const entry: VisualEntry = {
    ...base,
    status: !result.sizeMismatch && result.ratio <= maxDiffRatio ? 'passed' : 'failed',
    ratio: result.ratio,
    diffPixels: result.diffPixels,
    sizeMismatch: result.sizeMismatch || undefined,
    baselineId: baseline.id,
    baseline: baseline.path,
  };
  if (entry.status === 'failed') {
    const dir = join(ARTIFACTS_PATH, ctx.runId);
    mkdirSync(dir, { recursive: true });
    const stem = `${ctx.resultId}-visual-${ctx.index}`;
    writeFileSync(join(dir, `${stem}-actual.png`), image);
    entry.actual = `${ctx.runId}/${stem}-actual.png`;
    if (result.diffPng) {
      writeFileSync(join(dir, `${stem}-diff.png`), result.diffPng);
      entry.diff = `${ctx.runId}/${stem}-diff.png`;
    }
  }
  return entry;
}

/** Make the actual screenshot of a failed comparison the new baseline. */
export async function approveActual(entry: VisualEntry, projectId: string, agentId: string, runId: string, approvedBy: string): Promise<VisualBaseline> {
  if (!entry.actual) throw new Error('This comparison has no new screenshot to approve');
  const file = abs(entry.actual);
  if (!existsSync(file)) throw new Error('The screenshot of this run is no longer available (retention)');
  const repo = new VisualBaselineRepository();
  return repo.save({ projectId, agentId, name: entry.name, persona: entry.persona, viewport: entry.viewport, image: readFileSync(file), sourceRunId: runId, approvedBy });
}

export function describeVisual(e: VisualEntry): string {
  const pct = (r: number) => `${(r * 100).toFixed(r < 0.01 ? 3 : 1)}%`;
  const where = `"${e.name}" (${e.viewport}${e.persona ? `, ${e.persona}` : ''})`;
  if (e.status === 'created') return `Baseline created for ${where}`;
  if (e.sizeMismatch) return `Screenshot ${where} changed size compared with the baseline`;
  if (e.status === 'passed') return `Screenshot ${where} matches the baseline (${pct(e.ratio)} different, max ${pct(e.maxDiffRatio)})`;
  return `Screenshot ${where} differs from the baseline: ${pct(e.ratio)} of pixels (${e.diffPixels}) changed, max ${pct(e.maxDiffRatio)}`;
}

