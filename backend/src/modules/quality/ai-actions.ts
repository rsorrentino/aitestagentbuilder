/**
 * AI action steps: a step written as an instruction ("Add the cheapest
 * product to the cart", "Fill the signup form with a valid Italian address")
 * that the AI carries out on the live page.
 *
 *   { "action": "ai", "data": { "value": "Add the cheapest product to the cart", "max_actions": 12, "cache": true } }
 *   { "action": "AI: log in as demo with password {{secrets.DEMO_PW}}" }
 *
 * How it works:
 *  - In rounds, the AI sees the instruction, the actions done so far and the page (visible text, controls
 *    with selectors) and answers with the next few primitive actions (click, fill, select, …) or "done".
 *  - Secrets never reach the AI: {{secrets.NAME}} stays a placeholder in the instruction, the AI copies it into
 *    values, and it is resolved only when the action runs. Page content is masked like everywhere else.
 *  - A sequence that completed is cached (per agent, test, step, persona/row and instruction) and replayed in
 *    later runs without calling the AI; when the replay breaks, the AI continues from where it stopped.
 *  - The actions can be saved into the test case as ordinary steps (reviewable, no AI needed any more).
 */

import crypto from 'crypto';
import type { Page } from 'playwright';
import getDatabaseClient from '../../infra/db/client.js';

export const PRIMITIVES = ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'navigate', 'wait'] as const;
export type Primitive = typeof PRIMITIVES[number];

export interface AiAction {
  action: Primitive;
  target?: string;
  value?: string;
}

export interface AiActionResult extends AiAction {
  ok: boolean;
  error?: string;
  /** Replayed from the cache rather than chosen by the AI in this run */
  cached?: boolean;
}

export interface AiActionRecord {
  stepId: number;
  instruction: string;
  actions: AiActionResult[];
  done: boolean;
  reason: string;
  rounds: number;
  /** All actions came from the cache: no AI call */
  replayed: boolean;
  provider?: string;
  cacheSaved?: boolean;
  applied?: boolean;
}

export type Planner = (system: string, user: string) => Promise<{ content: string; provider?: string }>;

export const ACTION_PROMPT =
  'You operate a web page for an automated UI test. Carry out the instruction step by step with these actions: '
  + 'click, fill, select, check, uncheck, press, hover, navigate, wait. Use only selectors from the page outline '
  + '(selector="…"), or text=Visible text. For fill and select give the value; for press the key (e.g. Enter); for wait '
  + 'milliseconds. Placeholders such as {{secrets.NAME}} stand for values you must not know: copy them verbatim into '
  + 'values. Reply with JSON only: {"actions": [{"action": "…", "target": "…", "value": "…"}], "done": false, '
  + '"reason": "what you are doing"}. Give at most 3 actions per reply, then look at the page again. When the '
  + 'instruction is accomplished, reply {"actions": [], "done": true, "reason": "…"}. If it cannot be done on this '
  + 'page, reply {"actions": [], "done": true, "failed": true, "reason": "why"}. Do not verify or assert anything '
  + 'beyond the instruction.';

/** Parse the AI's answer; malformed answers yield no actions (and count against the round limit). */
export function parsePlan(content: string): { actions: AiAction[]; done: boolean; failed: boolean; reason: string } {
  const text = content.trim();
  let parsed: any;
  for (const candidate of [(text.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? [])[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // next candidate
    }
  }
  const actions: AiAction[] = [];
  for (const a of Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 5) : []) {
    const action = String(a?.action ?? '').toLowerCase().trim() as Primitive;
    if (!PRIMITIVES.includes(action)) continue;
    const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim().slice(0, 300) : undefined;
    const value = a.value === undefined || a.value === null ? undefined : String(a.value).slice(0, 2000);
    if (['click', 'fill', 'select', 'check', 'uncheck', 'hover'].includes(action) && !target) continue;
    actions.push({ action, ...(target ? { target } : {}), ...(value !== undefined ? { value } : {}) });
  }
  return {
    actions,
    done: parsed?.done === true,
    failed: parsed?.failed === true,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.trim().slice(0, 500) : '',
  };
}

/** Navigation stays on the application under test. */
export function allowedNavigation(target: string, baseUrl: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
  try {
    return new URL(target).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function describeActions(actions: AiActionResult[]): string {
  return actions.map((a) => `${a.action}${a.target ? ` ${a.target}` : ''}${a.value !== undefined ? ` = "${a.value}"` : ''}${a.ok ? '' : ' ✗'}`).join(' → ');
}

export interface RunOptions {
  stepId: number;
  baseUrl: string;
  plan?: Planner;
  outline: (page: Page) => Promise<string>;
  mask: (text: string) => string;
  /** Runs one primitive action (values are resolved by the caller, e.g. secrets) */
  execute: (action: AiAction) => Promise<void>;
  cached?: AiAction[] | null;
  maxActions?: number;
  maxRounds?: number;
}

/** Carry out an instruction: replay the cache when there is one, then let the AI continue or finish. */
export async function runAiAction(page: Page, instruction: string, opts: RunOptions): Promise<AiActionRecord> {
  const maxActions = Math.min(Math.max(Number(opts.maxActions) || 12, 1), 40);
  const maxRounds = Math.min(Math.max(Number(opts.maxRounds) || Math.ceil(maxActions / 2) + 2, 1), 20);
  const record: AiActionRecord = { stepId: opts.stepId, instruction, actions: [], done: false, reason: '', rounds: 0, replayed: false };

  const runOne = async (a: AiAction, cached: boolean): Promise<boolean> => {
    if (a.action === 'navigate' && a.target && !allowedNavigation(a.target, opts.baseUrl)) {
      record.actions.push({ ...a, ok: false, error: 'Navigation outside the application is not allowed', ...(cached ? { cached } : {}) });
      return false;
    }
    try {
      await opts.execute(a);
      record.actions.push({ ...a, ok: true, ...(cached ? { cached } : {}) });
      return true;
    } catch (e: any) {
      record.actions.push({ ...a, ok: false, error: opts.mask(String(e?.message ?? e).split('\n')[0]).slice(0, 300), ...(cached ? { cached } : {}) });
      return false;
    }
  };

  // 1. Replay a sequence that worked before
  if (opts.cached?.length) {
    let ok = true;
    for (const a of opts.cached) {
      if (!(await runOne(a, true))) {
        ok = false;
        break;
      }
    }
    if (ok) {
      record.done = true;
      record.replayed = true;
      record.reason = 'Replayed the actions that completed this instruction before';
      return record;
    }
  }

  // 2. Let the AI decide, round by round
  if (!opts.plan) throw new Error('AI action steps need an AI provider, and none is configured');
  while (record.rounds < maxRounds) {
    record.rounds++;
    const page_ = opts.mask(await describePage(page, opts.outline));
    const history = record.actions.length
      ? record.actions.map((a, i) => `${i + 1}. ${a.action}${a.target ? ` ${a.target}` : ''}${a.value !== undefined ? ` "${a.value}"` : ''} → ${a.ok ? 'ok' : `failed: ${a.error}`}`).join('\n')
      : '(none yet)';
    const answer = await opts.plan(ACTION_PROMPT, `Instruction: ${instruction}\n\nActions so far:\n${history}\n\n--- Page ---\n${page_}`);
    if (answer.provider) record.provider = answer.provider;
    const plan = parsePlan(answer.content);
    if (plan.reason) record.reason = plan.reason;
    if (plan.done) {
      if (plan.failed) throw new AiActionError(`The AI could not complete "${instruction}": ${plan.reason || 'no reason given'}`, record);
      record.done = true;
      return record;
    }
    for (const a of plan.actions) {
      if (record.actions.length >= maxActions) break;
      // A failed action is reported to the AI in the next round, which can try another way
      if (!(await runOne(a, false))) break;
    }
    if (record.actions.length >= maxActions) break;
  }
  throw new AiActionError(`The AI did not complete "${instruction}" within ${record.rounds} round(s) and ${record.actions.length} action(s)`
    + (record.reason ? ` — last: ${record.reason}` : ''), record);
}

export class AiActionError extends Error {
  constructor(message: string, public record: AiActionRecord) {
    super(message);
  }
}

async function describePage(page: Page, outline: (page: Page) => Promise<string>): Promise<string> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  const title = await page.title().catch(() => '');
  const text = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).trim().slice(0, 6000);
  const controls = await outline(page).catch(() => '');
  return `URL: ${page.url()}\nTitle: ${title}\n\nVisible text:\n${text}\n\nControls:\n${controls.slice(0, 6000)}`;
}

/** The successful actions of a record, in order: what gets cached and saved as steps. */
export function successfulActions(record: Pick<AiActionRecord, 'actions'>): AiAction[] {
  return record.actions.filter((a) => a.ok).map(({ action, target, value }) => ({ action, ...(target ? { target } : {}), ...(value !== undefined ? { value } : {}) }));
}

/** Ordinary test steps for the actions (data.value carries fill/select values, key presses and waits). */
export function actionsToSteps(actions: AiAction[]): Array<{ action: string; target?: string; data?: Record<string, any> }> {
  return actions.map((a) => ({
    action: a.action,
    ...(a.target ? { target: a.target } : {}),
    ...(a.value !== undefined ? { data: { value: a.value } } : {}),
  }));
}

export const instructionHash = (instruction: string) => crypto.createHash('sha256').update(instruction.trim()).digest('hex');

/** Sequences that completed an instruction, replayed in later runs. */
export class AiActionCache {
  private db = getDatabaseClient();

  async get(key: { agentId: string; testCaseId: string; stepId: number; variant: string; instruction: string }): Promise<AiAction[] | null> {
    const res = await this.db.query(
      `UPDATE ai_action_cache SET uses = uses + 1
        WHERE agent_id = $1 AND test_case_id = $2 AND step_id = $3 AND variant = $4 AND instruction_hash = $5
        RETURNING actions`,
      [key.agentId, key.testCaseId, key.stepId, key.variant, instructionHash(key.instruction)]);
    return res.rows[0]?.actions ?? null;
  }

  async save(key: { agentId: string; testCaseId: string; stepId: number; variant: string; instruction: string }, actions: AiAction[]): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_action_cache (agent_id, test_case_id, step_id, variant, instruction_hash, actions)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id, test_case_id, step_id, variant, instruction_hash)
       DO UPDATE SET actions = EXCLUDED.actions, updated_at = CURRENT_TIMESTAMP`,
      [key.agentId, key.testCaseId, key.stepId, key.variant, instructionHash(key.instruction), JSON.stringify(actions)]);
  }

  async clear(agentId: string, testCaseId?: string): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM ai_action_cache WHERE agent_id = $1 AND ($2::text IS NULL OR test_case_id = $2)`,
      [agentId, testCaseId ?? null]);
    return res.rowCount ?? 0;
  }
}

/**
 * Turn values that came from the test's data set row or fake values back into placeholders, so steps
 * saved from a data-driven or generated-data test stay generic ({{data.email}}, {{fake.email:buyer}}).
 */
export function templatize(text: string, testData?: { row?: Record<string, any>; fake?: Record<string, string> }): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(testData?.row ?? {})) {
    if ((typeof v === 'string' || typeof v === 'number') && String(v).length >= 3 && !String(v).includes('{{')) pairs.push([String(v), `{{data.${k}}}`]);
  }
  for (const [k, v] of Object.entries(testData?.fake ?? {})) if (v && v.length >= 3) pairs.push([v, `{{fake.${k}}}`]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [value, placeholder] of pairs) out = out.split(value).join(placeholder);
  return out;
}

/**
 * Replace the AI action step of a test case with ordinary steps. Only while the step at that
 * position is still the same AI step; its persona limits (only_personas / skip_personas) carry over.
 */
export function expandAiStep<T extends { stepId: number; action: string; target?: string; data?: Record<string, any> }>(
  steps: T[], stepId: number, originalAction: string, actions: AiAction[], testData?: { row?: Record<string, any>; fake?: Record<string, string> },
): Array<Omit<T, 'stepId'>> | null {
  const index = steps.findIndex((s) => s.stepId === stepId);
  if (index < 0 || steps[index].action !== originalAction) return null;
  const keep = Object.fromEntries(Object.entries(steps[index].data ?? {}).filter(([k]) => ['only_personas', 'skip_personas'].includes(k)));
  const replacement = actionsToSteps(actions).map((s) => ({
    ...s,
    ...(s.target ? { target: templatize(s.target, testData) } : {}),
    ...(s.data || Object.keys(keep).length ? { data: { ...(s.data ? { value: templatize(String(s.data.value), testData) } : {}), ...keep } } : {}),
  }));
  const strip = ({ stepId: _id, ...rest }: T) => rest;
  return [...steps.slice(0, index).map(strip), ...(replacement as any[]), ...steps.slice(index + 1).map(strip)];
}
