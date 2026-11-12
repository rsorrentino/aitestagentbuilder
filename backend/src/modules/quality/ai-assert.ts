/**
 * AI-judged assertions: `assert_ai` checks an expectation written in plain
 * language ("the page shows an order confirmation with an order number")
 * against the live page, judged by the AI.
 *
 * The AI sees the page's text and structure (visible text, headings, controls,
 * URL, title) — not its pixels; use assert_screenshot for how a page looks.
 * Known secrets are masked before anything is sent. Judgements vary more than
 * classic assertions, so a verdict needs a minimum confidence, "unsure" fails
 * by default, and identical page content is judged once per run (cache).
 *
 *   { "action": "assert_ai", "target": "#chat-answer" (optional),
 *     "data": { "value": "The answer explains how to reset a password and links to the help page",
 *               "min_confidence": 0.7, "on_unsure": "fail" | "pass" } }
 */

import crypto from 'crypto';
import type { Locator, Page } from 'playwright';

export interface AiVerdict {
  expectation: string;
  verdict: 'pass' | 'fail' | 'unsure';
  confidence: number;
  reason: string;
  passed: boolean;
  url: string;
  provider?: string;
  cached?: boolean;
}

export type Judge = (system: string, user: string) => Promise<{ content: string; provider?: string }>;

const MAX_TEXT = 12_000;

export const JUDGE_PROMPT =
  'You are a strict QA judge. Decide whether the web page content below meets the expectation. '
  + 'Judge only from the content given: do not assume anything that is not shown. If the content does not let you decide, '
  + 'answer "unsure". Reply with JSON only: {"verdict": "pass" | "fail" | "unsure", "confidence": 0..1, '
  + '"reason": "one sentence that cites what the content shows or lacks"}.';

/** Parse the judge's answer; anything malformed counts as "unsure". */
export function parseVerdict(content: string): { verdict: AiVerdict['verdict']; confidence: number; reason: string } {
  const text = content.trim();
  let parsed: any;
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), (text.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? [])[1]]) {
    if (!candidate) continue;
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // next candidate
    }
  }
  const verdict = ['pass', 'fail', 'unsure'].includes(parsed?.verdict) ? parsed.verdict : 'unsure';
  const confidence = Math.min(Math.max(Number(parsed?.confidence), 0), 1);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 500) : 'The AI gave no usable answer',
  };
}

/** Decide pass/fail from a verdict and the step's thresholds. */
export function decideVerdict(v: { verdict: AiVerdict['verdict']; confidence: number }, minConfidence: number, onUnsure: 'fail' | 'pass'): boolean {
  if (v.verdict === 'unsure') return onUnsure === 'pass';
  if (v.confidence < minConfidence) return false;
  return v.verdict === 'pass';
}

/** What the AI gets to see: element or page text plus, for whole pages, an outline. */
async function pageContent(page: Page, locator: Locator | null, outline: (page: Page) => Promise<string>): Promise<string> {
  const title = await page.title().catch(() => '');
  if (locator) {
    const text = (await locator.innerText({ timeout: 10000 })).trim();
    return `URL: ${page.url()}\nTitle: ${title}\nElement text:\n${text.slice(0, MAX_TEXT)}`;
  }
  const text = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).trim();
  const structure = await outline(page).catch(() => '');
  return `URL: ${page.url()}\nTitle: ${title}\n\nVisible text:\n${text.slice(0, MAX_TEXT)}\n\nHeadings and controls:\n${structure.slice(0, 4000)}`;
}

export async function judgeExpectation(
  page: Page,
  locator: Locator | null,
  expectation: string,
  opts: {
    judge: Judge;
    outline: (page: Page) => Promise<string>;
    mask: (text: string) => string;
    cache: Map<string, Omit<AiVerdict, 'cached'>>;
    minConfidence?: number;
    onUnsure?: 'fail' | 'pass';
  },
): Promise<AiVerdict> {
  const content = opts.mask(await pageContent(page, locator, opts.outline));
  const minConfidence = Math.min(Math.max(Number(opts.minConfidence ?? 0.7), 0), 1);
  const onUnsure = opts.onUnsure === 'pass' ? 'pass' : 'fail';
  const key = crypto.createHash('sha256').update(`${expectation}\u0000${content}`).digest('hex');
  const hit = opts.cache.get(key);
  if (hit) return { ...hit, passed: decideVerdict(hit, minConfidence, onUnsure), cached: true };

  const answer = await opts.judge(JUDGE_PROMPT, `Expectation: ${expectation}\n\n--- Page content ---\n${content}`);
  const parsed = parseVerdict(answer.content);
  const verdict: AiVerdict = {
    expectation,
    ...parsed,
    passed: decideVerdict(parsed, minConfidence, onUnsure),
    url: page.url(),
    ...(answer.provider ? { provider: answer.provider } : {}),
  };
  opts.cache.set(key, verdict);
  return verdict;
}

export function describeVerdict(v: AiVerdict, minConfidence = 0.7): string {
  const conf = `${Math.round(v.confidence * 100)}%`;
  const lowConfidence = v.verdict !== 'unsure' && v.confidence < minConfidence ? ` (below the required ${Math.round(minConfidence * 100)}%)` : '';
  return `AI judged "${v.expectation}": ${v.verdict}, confidence ${conf}${lowConfidence}${v.cached ? ', same content as earlier in this run' : ''} — ${v.reason}`;
}
