/**
 * Tests written in plain English → ordinary steps.
 *
 * Each sentence ("Click Save, then check that Total shows 42.00") is split into clauses and
 * turned into steps by rules first (no AI needed, the same text always gives the same steps),
 * using the project's library: block names become use_block steps, element names {{el.…}}.
 * Clauses the rules do not understand go to the AI with the action vocabulary, the library and,
 * when an agent is given, the outline of the live page (real labels and selectors).
 *
 * The result is ordinary steps: reviewed in the editor, then replayed exactly, without the AI.
 */

import type { TestStep } from '../../core/domain/test-case.js';

export interface LibraryView {
  blocks: Array<{ name: string; params: Array<{ name: string; default?: string }> }>;
  elements: Array<{ name: string; locator: string }>;
}

type Step = Omit<TestStep, 'stepId'>;
export interface ConvertedLine { text: string; steps: Step[]; via: 'rules' | 'ai' | 'none'; note?: string }

const KEYS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  'arrow down': 'ArrowDown', 'arrow up': 'ArrowUp', 'arrow left': 'ArrowLeft', 'arrow right': 'ArrowRight', 'down arrow': 'ArrowDown', 'up arrow': 'ArrowUp',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const unquote = (s: string) => s.trim().replace(/^["“'‘`](.*)["”'’`]$/s, '$1').trim();
const stripThe = (s: string) => s.trim().replace(/^(the|a|an)\s+/i, '');
const NOUNS = /\s+(button|link|tab|icon|field|box|input|textbox|text box|checkbox|dropdown|drop-down|list|menu item|option|menu)$/i;

/** Split a sentence into clauses: "…, then …", "… and then …", "…; …". Quoted text is never split. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^(\d+[.)]|[-*•])\s+/, '').replace(/[.]\s*$/, '');
    if (!cleaned) continue;
    // Protect quoted parts, split, restore
    const quoted: string[] = [];
    const masked = cleaned.replace(/(["“][^"”]*["”])/g, (m) => `\u0000${quoted.push(m) - 1}\u0000`);
    for (const part of masked.split(/\s*(?:;|,\s*(?:and\s+)?then\b|\band then\b|\bthen\b(?=\s))\s*/i)) {
      const restored = part.replace(/\u0000(\d+)\u0000/g, (_m, i) => quoted[Number(i)]).trim().replace(/^(and|then)\s+/i, '');
      if (restored) out.push(restored);
    }
  }
  return out;
}

/** A target for a label: the library element with that name, else the label itself (resolved by label, role or text when run). */
function targetFor(label: string, lib: LibraryView): string {
  const raw = unquote(stripThe(label));
  const bare = raw.replace(NOUNS, '').trim() || raw;
  const n = norm(raw);
  const nb = norm(bare);
  const el = lib.elements.find((e) => norm(e.name) === n || norm(e.name.split('.').pop()!) === n)
    ?? lib.elements.find((e) => norm(e.name) === nb || norm(e.name.split('.').pop()!) === nb);
  if (el) return `{{el.${el.name}}}`;
  return /^(\/|https?:|#|\.|\[|role=|text=|css=|xpath=|data-testid=|\{\{)/.test(raw) ? raw : bare;
}

function blockStep(clause: string, lib: LibraryView): Step | null {
  const text = clause.replace(/^(use|run|do)\s+(the\s+)?block\s+/i, '');
  const block = [...lib.blocks].sort((a, b) => b.name.length - a.name.length)
    .find((b) => text.toLowerCase() === b.name.toLowerCase() || text.toLowerCase().startsWith(`${b.name.toLowerCase()} `));
  if (!block) return null;
  const after = text.slice(block.name.length).trim();
  // "Sign in as admin" signs in as a persona, even when a block is called "Sign in"
  if (/^as\s/i.test(after)) return null;
  const rest = after.replace(/^(with|using|for)\s+/i, '');
  const params: Record<string, string> = {};
  // "user=alice, password: x", "user alice and password x"
  const names = block.params.map((p) => p.name);
  if (rest) {
    for (const piece of rest.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean)) {
      const m = /^([A-Za-z_][\w]*)\s*(?:=|:|\bis\b|\bas\b)?\s*(.+)$/.exec(piece.trim());
      if (m && names.includes(m[1])) params[m[1]] = unquote(m[2]);
      else if (names.length === 1 && !Object.keys(params).length) params[names[0]] = unquote(piece);
      else return null;
    }
  }
  return { action: 'use_block', target: block.name, ...(Object.keys(params).length ? { data: { params } } : {}) };
}

function assertion(body: string, lib: LibraryView): Step | null {
  let m: RegExpExecArray | null;
  if ((m = /^(?:the\s+)?(?:page\s+)?title\s+(?:is|contains|should be|should contain|equals)\s+(.+)$/i.exec(body))) return { action: 'assert_title', data: { value: unquote(m[1]) } };
  if ((m = /^(?:the\s+)?(?:url|address)\s+(?:is|contains|should contain|includes|ends with)\s+(.+)$/i.exec(body))) return { action: 'assert_url', data: { value: unquote(m[1]) } };
  if ((m = /^(?:we are|i am|you are|it is)\s+on\s+(\/\S+)$/i.exec(body))) return { action: 'assert_url', data: { value: m[1] } };
  if ((m = /^(.+?)\s+(?:is|are)\s+(?:not visible|hidden|not shown|not displayed|gone|absent)$/i.exec(body))
    || (m = /^(?:there is no|no)\s+(.+)$/i.exec(body))) return { action: 'assert_not_visible', target: targetFor(m[1], lib) };
  if ((m = /^(.+?)\s+(?:is|are)\s+(?:visible|shown|displayed|present|there)$/i.exec(body))
    || (m = /^(.+?)\s+(?:appears|is shown|is displayed)$/i.exec(body))) {
    const quoted = /["“]([^"”]+)["”]/.exec(m[1]);
    return { action: 'assert_visible', target: quoted ? `text=${quoted[1]}` : targetFor(m[1], lib) };
  }
  if ((m = /^(?:the\s+)?(?:page|screen)\s+(?:shows|contains|says|displays|has)\s+(.+)$/i.exec(body))) return { action: 'assert_text', target: 'body', data: { value: unquote(m[1]) } };
  if ((m = /^(.+?)\s+(?:shows|contains|says|displays|reads|equals|has the text|has text|is|should show|should contain|should be)\s+(.+)$/i.exec(body))) {
    return { action: 'assert_text', target: targetFor(m[1], lib), data: { value: unquote(m[2]) } };
  }
  if ((m = /^["“'](.+)["”']$/.exec(body.trim()))) return { action: 'assert_visible', target: `text=${m[1]}` };
  return null;
}

/** One clause → steps by rules, or null (left to the AI). */
export function parseClause(clause: string, lib: LibraryView): Step[] | null {
  const c = clause.trim();
  let m: RegExpExecArray | null;
  const block = blockStep(c, lib);
  if (block) return [block];
  if ((m = /^(?:log ?in|sign ?in|login)\s+as\s+(?:the\s+)?(.+?)(?:\s+user)?$/i.exec(c))) return [{ action: 'salesforce_login', data: { persona: unquote(m[1]) } }];
  if ((m = /^(?:log ?out|sign ?out|logout)$/i.exec(c))) return [{ action: 'salesforce_logout' }];
  if ((m = /^(?:go|navigate|browse)\s+(?:to\s+)?(?:the\s+)?(\S+)(?:\s+page)?$/i.exec(c)) || (m = /^(?:open|visit|load)\s+(?:the\s+)?(\S+)(?:\s+page)?$/i.exec(c))) {
    const where = unquote(m[1]);
    if (/^(\/|https?:\/\/)/.test(where)) return [{ action: 'navigate', target: where }];
    return null;
  }
  if ((m = /^(?:check that|verify that|verify|check|expect that|expect|ensure that|ensure|confirm that|confirm|assert that|assert|make sure that|make sure|see that|i see|you see|should see)\s+(.+)$/i.exec(c))) {
    const a = assertion(m[1], lib);
    if (a) return [a];
    // "Check the terms checkbox" is not an assertion: the rules below may know it
    if (!/^check\s/i.test(c) || /^check that\b/i.test(c)) return null;
  }
  if ((m = /^(?:wait)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)$/i.exec(c))) {
    const ms = /^m/i.test(m[2]) ? Number(m[1]) : Number(m[1]) * 1000;
    return [{ action: 'wait', data: { ms: Math.round(ms) } }];
  }
  if ((m = /^wait\s+(?:for|until)\s+(?:the\s+)?(.+?)(?:\s+(?:to\s+)?(?:appears?|is visible|shows|loads?))?$/i.exec(c))) return [{ action: 'wait', target: targetFor(m[1], lib) }];
  if ((m = /^press\s+(?:the\s+)?(.+?)(?:\s+key)?$/i.exec(c)) && KEYS[m[1].toLowerCase()]) return [{ action: 'press', data: { value: KEYS[m[1].toLowerCase()] } }];
  if ((m = /^(?:select|choose|pick)\s+(.+?)\s+(?:in|from|for)\s+(?:the\s+)?(.+)$/i.exec(c))) return [{ action: 'select', target: targetFor(m[2], lib), data: { value: unquote(m[1]) } }];
  if ((m = /^(?:type|enter|fill in|fill|input|write|put)\s+(.+?)\s+(?:in|into|in the|into the)\s+(?:the\s+)?(.+)$/i.exec(c))) return [{ action: 'fill', target: targetFor(m[2], lib), data: { value: unquote(m[1]) } }];
  if ((m = /^(?:fill in|fill|set|enter|complete)\s+(?:the\s+)?(.+?)\s+(?:with|to|as)\s+(.+)$/i.exec(c))) return [{ action: 'fill', target: targetFor(m[1], lib), data: { value: unquote(m[2]) } }];
  if ((m = /^(?:uncheck|untick|deselect)\s+(.+)$/i.exec(c))) return [{ action: 'uncheck', target: targetFor(m[1], lib) }];
  if ((m = /^(?:check|tick)\s+(?:the\s+)?(.+?)(?:\s+(?:checkbox|box|option))?$/i.exec(c))) return [{ action: 'check', target: targetFor(m[1], lib) }];
  if ((m = /^(?:hover|hover over|move the mouse over|mouse over)\s+(.+)$/i.exec(c))) return [{ action: 'hover', target: targetFor(m[1], lib) }];
  if ((m = /^(?:click|tap|press|hit|double click|double-click)\s+(?:on\s+)?(.+)$/i.exec(c))) return [{ action: 'click', target: targetFor(m[1], lib) }];
  if ((m = /^(?:take a |take |make a )?screenshot(?:\s+(?:of|named)\s+(.+))?$/i.exec(c))) return [{ action: 'screenshot', ...(m[1] ? { data: { value: unquote(m[1]) } } : {}) }];
  return null;
}

/** All lines by rules; the ones not understood are returned for the AI (same order). */
export function convertByRules(text: string, lib: LibraryView): ConvertedLine[] {
  return splitClauses(text).map((clause) => {
    const steps = parseClause(clause, lib);
    return steps ? { text: clause, steps, via: 'rules' as const } : { text: clause, steps: [], via: 'none' as const };
  });
}

const ACTIONS = `navigate (target: /path or URL), click, fill (data.value), select (data.value = option label), check, uncheck, press (data.value = key), hover,
wait (data.ms, or target to wait for), assert_visible, assert_not_visible, assert_text (target + data.value), assert_url (data.value), assert_title (data.value),
screenshot, salesforce_login (data.persona: sign in as that persona / login profile), use_block (target = block name, data.params),
http_request (target path, data.method/json/extract), assert_status, assert_json,
db_query / assert_db / db_execute (target = database name, data.sql with ? placeholders, data.params, assert_db: data.rows / data.equals), assert_ai (data.value = expectation judged by AI on the page),
ai (data.value = instruction carried out by AI on the live page, only when no other action fits)`;

/** The AI prompt for the clauses the rules did not understand (pure, so it can be checked). */
export function aiPrompt(lines: string[], lib: LibraryView, outline?: string): { system: string; user: string } {
  const system = [
    'You turn test steps written in plain English into structured UI test steps. Reply with JSON only:',
    '[{"line": <number>, "steps": [{"action": "...", "target": "...", "data": {...}}]}] with one entry per input line, in order.',
    `Actions: ${ACTIONS}.`,
    'Targets: prefer a library element as {{el.Name}} when one fits; else a selector seen in the page outline; else the visible label or text',
    '(e.g. "Save", "Email") — it is resolved by label, placeholder, role and text when the test runs. Never invent CSS classes.',
    'Use use_block when a library block does what the line says. Keep {{secrets.X}}, {{data.x}}, {{fake.x}}, {{vars.x}} placeholders as written.',
    'If a line cannot be automated, return "steps": [] for it.',
  ].join('\n');
  const user = [
    `Lines:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    lib.elements.length ? `Library elements:\n${lib.elements.slice(0, 200).map((e) => `{{el.${e.name}}} = ${e.locator}`).join('\n')}` : 'Library elements: none',
    lib.blocks.length ? `Library blocks:\n${lib.blocks.slice(0, 100).map((b) => `${b.name}(${b.params.map((p) => p.name).join(', ')})`).join('\n')}` : 'Library blocks: none',
    outline ? `Page outline (real elements with selectors):\n${outline}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

const KNOWN = new Set(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait', 'assert_visible', 'assert_not_visible', 'assert_text',
  'assert_url', 'assert_title', 'screenshot', 'salesforce_login', 'salesforce_logout', 'use_block', 'http_request', 'assert_status', 'assert_json', 'assert_ai', 'ai',
  'assert_header', 'assert_response_time', 'mock_route', 'block_route', 'assert_accessible', 'assert_screenshot', 'assert_performance', 'wait_for_code', 'wait_for_lightning',
  'db_query', 'assert_db', 'db_execute']);

/** Keep only well-formed steps with known actions and existing blocks (pure). */
export function cleanAiSteps(raw: any, lib: LibraryView): Step[] {
  if (!Array.isArray(raw)) return [];
  const blocks = new Set(lib.blocks.map((b) => b.name.toLowerCase()));
  return raw
    .filter((s) => s && typeof s.action === 'string' && KNOWN.has(s.action))
    .filter((s) => s.action !== 'use_block' || blocks.has(String(s.target ?? '').toLowerCase()))
    .map((s) => ({
      action: s.action,
      ...(typeof s.target === 'string' && s.target.trim() ? { target: s.target.trim() } : {}),
      ...(s.data && typeof s.data === 'object' && !Array.isArray(s.data) && Object.keys(s.data).length ? { data: s.data } : {}),
    }));
}

/**
 * Convert plain-English steps: rules first, then the AI for what is left (with the live page's
 * outline when a base URL is given). Lines nobody understood come back with a note.
 */
export async function convertText(text: string, lib: LibraryView, opts: { baseUrl?: string; path?: string; aiProvider?: string } = {}): Promise<{ lines: ConvertedLine[]; steps: Step[]; usedAi: boolean; pageOutline: boolean }> {
  const lines = convertByRules(text, lib);
  const pending = lines.filter((l) => l.via === 'none');
  let usedAi = false;
  let pageOutline = false;
  if (pending.length) {
    const { getLLMRouter } = await import('../../infra/llm/router.js');
    const router = getLLMRouter();
    if (!router.hasAnyProvider()) {
      for (const l of pending) l.note = 'Not understood. Rephrase it like “Click Save”, “Type alice@example.com into Email”, “Check that Total shows 42.00”, or add an AI provider.';
    } else {
      let outline: string | undefined;
      if (opts.baseUrl) {
        outline = await livePageOutline(opts.baseUrl, opts.path).catch(() => undefined);
        pageOutline = !!outline;
      }
      const { system, user } = aiPrompt(pending.map((l) => l.text), lib, outline);
      const { extractJsonArray } = await import('../../infra/llm/json.js');
      const response = await router.chat([{ role: 'system', content: system }, { role: 'user', content: user }], 'codegen', { preferred: opts.aiProvider, maxTokens: 2000 });
      usedAi = true;
      const answer = extractJsonArray(response.content);
      pending.forEach((l, i) => {
        const entry = answer.find((a: any) => Number(a?.line) === i + 1) ?? answer[i];
        const steps = cleanAiSteps(entry?.steps, lib);
        if (steps.length) {
          l.steps = steps;
          l.via = 'ai';
        } else l.note = 'The AI could not turn this into steps: describe what to click, type or check.';
      });
    }
  }
  return { lines, steps: lines.flatMap((l) => l.steps), usedAi, pageOutline };
}

/** Outline of the page the steps start on (interactive elements with selectors), for the AI. */
async function livePageOutline(baseUrl: string, path = '/'): Promise<string> {
  const { launchBrowser, outlinePage } = await import('../execution/browser.js');
  const browser = await launchBrowser();
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    const url = /^https?:\/\//.test(path) ? path : new URL(path || '/', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    return await outlinePage(page, 120);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
