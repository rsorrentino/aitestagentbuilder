/**
 * Accessibility checks with axe-core (Deque, MPL-2.0) on the live page.
 *
 * Used by the `assert_accessible` step and by the optional end-of-test scan
 * (agent config `checks.accessibility`: off | report | fail).
 */

import type { Page } from 'playwright';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
export const IMPACT_RANK: Record<Impact, number> = { minor: 1, moderate: 2, serious: 3, critical: 4 };

/** WCAG conformance level → axe rule tags (each level includes the ones below it). */
export const LEVEL_TAGS: Record<string, string[]> = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
};

export interface A11yOptions {
  /** wcag2a | wcag2aa | wcag21aa (default) | wcag22aa */
  level?: string;
  /** Only scan inside these selectors */
  include?: string[];
  /** Skip these selectors (third-party widgets, …) */
  exclude?: string[];
  /** axe rule ids to ignore, e.g. "color-contrast" */
  ignore?: string[];
  /** Violations below this impact are reported but do not count (default: serious) */
  minImpact?: Impact;
}

export interface A11yViolation {
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  nodes: number;
  targets: string[];
  counted: boolean;
}

export interface A11yReport {
  url: string;
  level: string;
  minImpact: Impact;
  violations: A11yViolation[];
  /** violations at or above minImpact */
  failing: number;
  passes: number;
  incomplete: number;
}

const asList = (v: unknown): string[] =>
  v === undefined || v === null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

export function normalizeA11yOptions(raw: Record<string, any> = {}): Required<A11yOptions> {
  const level = String(raw.level ?? 'wcag21aa').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!LEVEL_TAGS[level]) throw new Error(`Unknown accessibility level "${raw.level}" — use ${Object.keys(LEVEL_TAGS).join(', ')}`);
  const minImpact = String(raw.minImpact ?? raw.min_impact ?? 'serious').toLowerCase() as Impact;
  if (!IMPACT_RANK[minImpact]) throw new Error(`Unknown impact "${minImpact}" — use minor, moderate, serious or critical`);
  return { level, minImpact, include: asList(raw.include), exclude: asList(raw.exclude), ignore: asList(raw.ignore) };
}

/** Turn raw axe results into a compact report (pure: unit-testable). */
export function summarizeAxe(results: any, url: string, opts: Required<A11yOptions>): A11yReport {
  const violations: A11yViolation[] = (results.violations ?? [])
    .filter((v: any) => !opts.ignore.includes(v.id))
    .map((v: any) => {
      const impact = (v.impact ?? 'minor') as Impact;
      return {
        id: v.id,
        impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: (v.nodes ?? []).length,
        targets: (v.nodes ?? []).slice(0, 5).map((n: any) => (Array.isArray(n.target) ? n.target.join(' ') : String(n.target))),
        counted: IMPACT_RANK[impact] >= IMPACT_RANK[opts.minImpact],
      };
    })
    .sort((a: A11yViolation, b: A11yViolation) => IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || b.nodes - a.nodes);
  return {
    url,
    level: opts.level,
    minImpact: opts.minImpact,
    violations,
    failing: violations.filter((v) => v.counted).length,
    passes: (results.passes ?? []).length,
    incomplete: (results.incomplete ?? []).length,
  };
}

export async function scanAccessibility(page: Page, raw: Record<string, any> = {}): Promise<A11yReport> {
  const opts = normalizeA11yOptions(raw);
  const { AxeBuilder } = await import('@axe-core/playwright');
  let builder = new AxeBuilder({ page }).withTags(LEVEL_TAGS[opts.level]);
  for (const sel of opts.include) builder = builder.include(sel);
  for (const sel of opts.exclude) builder = builder.exclude(sel);
  if (opts.ignore.length) builder = builder.disableRules(opts.ignore);
  const results = await builder.analyze();
  return summarizeAxe(results, page.url(), opts);
}

export function describeA11y(report: A11yReport): string {
  if (report.failing === 0) {
    const minor = report.violations.length;
    return `No ${report.minImpact}+ accessibility violations (${report.level.toUpperCase()})${minor ? `; ${minor} lower-impact issue(s) reported` : ''}`;
  }
  const top = report.violations.filter((v) => v.counted).slice(0, 3)
    .map((v) => `${v.id} (${v.impact}, ${v.nodes} element${v.nodes === 1 ? '' : 's'}: ${v.targets[0] ?? ''})`).join('; ');
  return `${report.failing} accessibility violation(s) at ${report.minImpact}+ (${report.level.toUpperCase()}): ${top}`;
}
