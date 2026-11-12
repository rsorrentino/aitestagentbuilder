/**
 * Failure triage: group a run's failures by what went wrong, classify each
 * group (app bug / test bug / environment), and tell new failures from known
 * ones.
 *
 * Rules decide without AI and always run when a run finishes. When an AI
 * provider is configured, the AI can explain each group and suggest a fix
 * (agent config ai.triage = true, or POST /runs/:id/triage { ai: true }).
 */

import getDatabaseClient from '../../infra/db/client.js';

export type FailureCategory = 'app_bug' | 'test_bug' | 'environment' | 'unknown';

export interface TriageGroup {
  signature: string;
  category: FailureCategory;
  /** Why the rules (or the AI) chose the category */
  reason: string;
  /** AI explanation of the likely cause, and what to do */
  cause?: string;
  suggestion?: string;
  source: 'rules' | 'ai';
  sample: { error: string; action?: string; target?: string };
  tests: Array<{ resultId: string; testCaseId: string; title: string; persona?: string; dataRow?: string }>;
  /** Earlier runs of the same agent with this failure (last 30 days) */
  seenBefore: number;
  firstSeen?: string;
}

export interface Triage {
  generatedAt: string;
  ai: boolean;
  groups: TriageGroup[];
  summary: Record<FailureCategory, number>;
}

/**
 * Stable signature of a failure: the failed step's action plus the error with
 * run-specific details (numbers, quoted values, URLs, ids, timings) removed.
 */
export function failureSignature(error: string, action?: string): string {
  const normalized = String(error ?? '')
    .replace(/^Step \d+ \([^)]*\):\s*/, '')
    .replace(/https?:\/\/[^\s"')]+/g, '<url>')
    .replace(/"[^"]*"|'[^']*'|“[^”]*”/g, '"…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b(RUN|TC|RES|VB)-[\w-]+/g, '<id>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${(action ?? '').toLowerCase().trim()}|${normalized}`;
}

const RULES: Array<{ category: FailureCategory; test: RegExp; reason: string }> = [
  // Environment: the application or the network was not available
  { category: 'environment', test: /net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|getaddrinfo|Cannot reach|HTTP 5\d\d|status of 5\d\d|Service Unavailable|Bad Gateway|browser has been closed|Target page, context or browser has been closed|Navigation timeout|page\.goto: Timeout/i, reason: 'The application or the network was not reachable' },
  { category: 'environment', test: /needs an AI provider/i, reason: 'An AI check could not run: no AI provider is configured' },
  { category: 'environment', test: /Salesforce token request failed|login as .* did not complete|Sign-in as .* (failed|did not complete)|verification code|phishing-resistant|Cannot connect to PostgreSQL|No Salesforce API access/i, reason: 'Login or infrastructure problem, not the behaviour under test' },
  // Test bug: the test no longer matches the application or is misconfigured
  { category: 'test_bug', test: /was not found or not actionable|strict mode violation|resolved to \d+ elements|waiting for (locator|getBy)|locator\.\w+: Timeout|not attached to the DOM|outside of the viewport/i, reason: 'A selector no longer finds the element: the page changed or the test is outdated' },
  { category: 'test_bug', test: /needs (a target|data\.value)|Unknown secret|Unknown Salesforce persona|not in STEP_ENV_ALLOWLIST|Test case has no steps|Give the expected access|Expected true\/false|No approved baseline|Unknown accessibility level|Test data set .* (not found|has no rows)|Unknown data field|needs a data set|Unknown fake data kind|Unknown test data locale/i, reason: 'The test case is incomplete or misconfigured' },
  // App bug: the application behaved differently from what the test expects
  { category: 'app_bug', test: /Expected .* to contain|Expected the page to contain|Expected URL to contain|Expected title to contain|Expected access to be denied|Unexpected access to|Expected profile|is missing permission set|must not have permission set|not to be visible|differs from the baseline|exceeds the performance budget|slower than the baseline .* of earlier runs|changed size compared with the baseline|accessibility violation/i, reason: 'The application did not show or allow what the test expects' },
  { category: 'app_bug', test: /AI judged .*: fail\b/i, reason: 'The AI judged that the page does not meet the expectation' },
  { category: 'unknown', test: /The AI (could not|did not) complete/i, reason: 'An AI action step did not reach its goal: read the AI\'s reason and the evidence (app change or unclear instruction)' },
  { category: 'unknown', test: /AI judged .*: (unsure|pass, confidence)/i, reason: 'The AI could not decide with enough confidence: check the evidence' },
];

export function classifyFailure(error: string): { category: FailureCategory; reason: string } {
  for (const rule of RULES) if (rule.test.test(error)) return { category: rule.category, reason: rule.reason };
  return { category: 'unknown', reason: 'No rule matched this error' };
}

/** Final attempt of each test (and persona) in a run, failed ones only. */
function finalFailures(results: any[]): any[] {
  const latest = new Map<string, any>();
  for (const r of results) {
    const key = `${r.testCaseId}@${r.metadata?.persona ?? ''}#${r.metadata?.dataRow ?? ''}`;
    const prev = latest.get(key);
    if (!prev || new Date(r.startedAt) >= new Date(prev.startedAt)) latest.set(key, r);
  }
  return [...latest.values()].filter((r) => ['failed', 'error', 'timeout'].includes(r.status));
}

/** Group failures with the rules (pure: unit-testable). */
export function groupFailures(results: any[]): Omit<TriageGroup, 'seenBefore' | 'firstSeen'>[] {
  const groups = new Map<string, Omit<TriageGroup, 'seenBefore' | 'firstSeen'>>();
  for (const r of finalFailures(results)) {
    const step = (r.metadata?.steps ?? []).find((s: any) => s.status === 'failed');
    const error = String(r.error ?? step?.message ?? 'Unknown error');
    const signature = failureSignature(error, step?.action);
    let group = groups.get(signature);
    if (!group) {
      const { category, reason } = classifyFailure(error);
      group = { signature, category, reason, source: 'rules', sample: { error: error.slice(0, 500), action: step?.action, target: step?.target }, tests: [] };
      groups.set(signature, group);
    }
    group.tests.push({ resultId: r.id, testCaseId: r.testCaseId, title: r.metadata?.title ?? r.testCaseId, ...(r.metadata?.persona ? { persona: r.metadata.persona } : {}), ...(r.metadata?.dataLabel ? { dataRow: r.metadata.dataLabel } : {}) });
  }
  const order: Record<FailureCategory, number> = { app_bug: 0, environment: 1, test_bug: 2, unknown: 3 };
  return [...groups.values()].sort((a, b) => order[a.category] - order[b.category] || b.tests.length - a.tests.length);
}

export function summarize(groups: Array<{ category: FailureCategory; tests: unknown[] }>): Record<FailureCategory, number> {
  const out: Record<FailureCategory, number> = { app_bug: 0, test_bug: 0, environment: 0, unknown: 0 };
  for (const g of groups) out[g.category] += g.tests.length;
  return out;
}

/** How often each signature failed in earlier runs of the agent (results store their signature). */
async function history(agentId: string, runId: string, signatures: string[]): Promise<Map<string, { count: number; first: string }>> {
  const out = new Map<string, { count: number; first: string }>();
  if (!signatures.length) return out;
  const res = await getDatabaseClient().query(
    `SELECT r.metadata->>'failureSignature' AS sig, COUNT(DISTINCT r.run_id)::int AS runs, MIN(ru.started_at) AS first
       FROM results r JOIN runs ru ON ru.id = r.run_id
      WHERE ru.agent_id = $1 AND ru.id <> $2 AND ru.started_at >= NOW() - INTERVAL '30 days'
        AND r.metadata->>'failureSignature' = ANY($3)
      GROUP BY 1`,
    [agentId, runId, signatures]);
  for (const row of res.rows) out.set(row.sig, { count: row.runs, first: new Date(row.first).toISOString() });
  return out;
}

export interface Explainer {
  (groups: TriageGroup[]): Promise<Array<{ category?: FailureCategory; cause?: string; suggestion?: string }>>;
}

/** Ask the AI to classify and explain each group (one call for the whole run). */
export async function explainWithAi(groups: TriageGroup[], preferred?: string): Promise<Array<{ category?: FailureCategory; cause?: string; suggestion?: string }>> {
  const { getLLMRouter } = await import('../../infra/llm/router.js');
  const { extractJsonArray } = await import('../../infra/llm/json.js');
  const router = getLLMRouter();
  const listing = groups.map((g, i) => [
    `#${i + 1} (${g.tests.length} test${g.tests.length === 1 ? '' : 's'}: ${g.tests.slice(0, 5).map((t) => t.title).join('; ')})`,
    `  failed step: ${g.sample.action ?? '?'}${g.sample.target ? ` → ${g.sample.target}` : ''}`,
    `  error: ${g.sample.error}`,
    `  rule-based guess: ${g.category} (${g.reason})`,
    `  seen in earlier runs: ${g.seenBefore}`,
  ].join('\n')).join('\n\n');
  const response = await router.chat([
    {
      role: 'system',
      content: 'You triage failed UI test runs. For each failure group decide whether it is an application bug (app_bug), '
        + 'a broken or outdated test (test_bug), or an environment / infrastructure problem (environment), give the most likely '
        + 'cause in one sentence and one concrete next step. Reply with JSON only: '
        + '[{"group": 1, "category": "app_bug|test_bug|environment|unknown", "cause": "…", "suggestion": "…"}].',
    },
    { role: 'user', content: listing },
  ], 'analysis', { preferred, maxTokens: 1200 });
  const answers = extractJsonArray(response.content);
  return groups.map((_g, i) => {
    const a = answers.find((x: any) => Number(x?.group) === i + 1) ?? {};
    const category = ['app_bug', 'test_bug', 'environment', 'unknown'].includes(a.category) ? a.category : undefined;
    return { category, cause: typeof a.cause === 'string' ? a.cause.slice(0, 400) : undefined, suggestion: typeof a.suggestion === 'string' ? a.suggestion.slice(0, 400) : undefined };
  });
}

/** Triage a finished run: rules, history, and optionally the AI. */
export async function triageRun(run: { id: string; agentId: string; results?: any[] }, opts: { ai?: boolean; preferred?: string; explain?: Explainer } = {}): Promise<Triage> {
  const base = groupFailures(run.results ?? []);
  const seen = await history(run.agentId, run.id, base.map((g) => g.signature));
  const groups: TriageGroup[] = base.map((g) => ({
    ...g,
    seenBefore: seen.get(g.signature)?.count ?? 0,
    ...(seen.get(g.signature) ? { firstSeen: seen.get(g.signature)!.first } : {}),
  }));
  let usedAi = false;
  if (opts.ai && groups.length) {
    const answers = await (opts.explain ?? ((gs) => explainWithAi(gs, opts.preferred)))(groups);
    answers.forEach((a, i) => {
      const g = groups[i];
      if (a.category) g.category = a.category;
      if (a.cause) g.cause = a.cause;
      if (a.suggestion) g.suggestion = a.suggestion;
      if (a.category || a.cause) g.source = 'ai';
    });
    usedAi = true;
  }
  return { generatedAt: new Date().toISOString(), ai: usedAi, groups, summary: summarize(groups) };
}
