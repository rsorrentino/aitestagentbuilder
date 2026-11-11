/**
 * Quality extensions (no database, no browser): `npm test`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { normalizeA11yOptions, summarizeAxe, describeA11y } from '../modules/quality/accessibility.js';
import { compareScreenshots, describeVisual } from '../modules/quality/visual.js';
import { evidenceConfig, keepEvidence, redactTrace, secretVariants } from '../modules/quality/evidence.js';
import { applyHealing, HealingCache, healedStepsOf } from '../modules/quality/healing.js';
import { classifyAction } from '../modules/execution/step-runner.js';

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

describe('accessibility', () => {
  const axe = {
    violations: [
      { id: 'color-contrast', impact: 'serious', help: 'Contrast', helpUrl: 'u1', nodes: [{ target: ['.a'] }, { target: ['.b'] }] },
      { id: 'image-alt', impact: 'critical', help: 'Alt text', helpUrl: 'u2', nodes: [{ target: ['img'] }] },
      { id: 'region', impact: 'moderate', help: 'Landmarks', helpUrl: 'u3', nodes: [{ target: ['div'] }] },
    ],
    passes: [{}, {}],
    incomplete: [{}],
  };

  it('counts only violations at or above the minimum impact, most severe first', () => {
    const r = summarizeAxe(axe, 'http://x/', normalizeA11yOptions({}));
    assert.deepEqual(r.violations.map((v) => [v.id, v.counted]), [['image-alt', true], ['color-contrast', true], ['region', false]]);
    assert.equal(r.failing, 2);
    assert.equal(r.passes, 2);
    assert.deepEqual(r.violations[1].targets, ['.a', '.b']);
    assert.match(describeA11y(r), /^2 accessibility violation\(s\) at serious\+ \(WCAG21AA\): image-alt \(critical, 1 element: img\)/);
  });

  it('honours ignored rules and the minimum impact', () => {
    const r = summarizeAxe(axe, 'u', normalizeA11yOptions({ ignore: 'image-alt, color-contrast', minImpact: 'moderate' }));
    assert.deepEqual(r.violations.map((v) => v.id), ['region']);
    assert.equal(r.failing, 1);
    const clean = summarizeAxe({ violations: [axe.violations[2]] }, 'u', normalizeA11yOptions({}));
    assert.equal(clean.failing, 0);
    assert.match(describeA11y(clean), /No serious\+ accessibility violations \(WCAG21AA\); 1 lower-impact issue/);
  });

  it('validates the options', () => {
    assert.equal(normalizeA11yOptions({ level: 'WCAG 2.2 AA' }).level, 'wcag22aa');
    assert.throws(() => normalizeA11yOptions({ level: 'wcag3' }), /Unknown accessibility level/);
    assert.throws(() => normalizeA11yOptions({ min_impact: 'huge' }), /Unknown impact/);
  });
});

describe('visual comparison', () => {
  const blue = png(40, 20, () => [0, 0, 220]);

  it('finds no difference between identical images', () => {
    const r = compareScreenshots(blue, png(40, 20, () => [0, 0, 220]));
    assert.equal(r.diffPixels, 0);
    assert.equal(r.ratio, 0);
    assert.equal(r.diffPng, undefined);
  });

  it('measures the changed area and returns a diff image', () => {
    const changed = png(40, 20, (x) => (x < 10 ? [220, 0, 0] : [0, 0, 220])); // a quarter turned red
    const r = compareScreenshots(blue, changed);
    assert.equal(r.diffPixels, 200);
    assert.equal(r.ratio, 0.25);
    assert.ok(r.diffPng && PNG.sync.read(r.diffPng).width === 40);
  });

  it('ignores tiny color noise below the threshold and reports size changes', () => {
    assert.equal(compareScreenshots(blue, png(40, 20, () => [0, 0, 218])).diffPixels, 0);
    const r = compareScreenshots(blue, png(40, 21, () => [0, 0, 220]));
    assert.equal(r.sizeMismatch, true);
    assert.equal(r.ratio, 1);
  });

  it('describes results', () => {
    const base = { name: 'home', persona: 'rep', viewport: '1280x800', maxDiffRatio: 0.001 };
    assert.equal(describeVisual({ ...base, status: 'created', ratio: 0, diffPixels: 0 }), 'Baseline created for "home" (1280x800, rep)');
    assert.match(describeVisual({ ...base, status: 'failed', ratio: 0.25, diffPixels: 200 }), /differs from the baseline: 25\.0% of pixels \(200\) changed, max 0\.100%/);
  });
});

describe('evidence', () => {
  it('reads the trace/video settings with safe defaults', () => {
    assert.deepEqual(evidenceConfig({}), { trace: 'on_failure', video: 'on_failure' });
    assert.deepEqual(evidenceConfig({ evidence: { trace: 'always', video: 'nonsense' } }), { trace: 'always', video: 'on_failure' });
    assert.equal(keepEvidence('on_failure', 'failed'), true);
    assert.equal(keepEvidence('on_failure', 'error'), true);
    assert.equal(keepEvidence('on_failure', 'passed'), false);
    assert.equal(keepEvidence('always', 'passed'), true);
    assert.equal(keepEvidence('off', 'failed'), false);
  });

  it('masks secrets in every form they appear in a trace', async () => {
    const secret = 'p@ss word"1&x';
    assert.deepEqual(secretVariants(['abc', secret]).sort(), [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret).replace(/%20/g, '+')].sort());

    const zip = new JSZip();
    zip.file('trace.trace', `{"type":"action","params":{"value":${JSON.stringify(secret)}}}\n`);
    zip.file('trace.network', `GET /login?pw=${encodeURIComponent(secret)}&sid=SESSION-0123456789`);
    zip.file('resources/page.html', '<p>nothing secret here</p>');
    const input = await zip.generateAsync({ type: 'nodebuffer' });
    const { zip: out, masked } = await redactTrace(input, [secret, 'SESSION-0123456789']);
    assert.equal(masked, 3);
    const read = await JSZip.loadAsync(out);
    const all = (await Promise.all(Object.values(read.files).map((f) => f.async('string')))).join('\n');
    assert.ok(!all.includes('SESSION-0123456789'));
    assert.ok(!all.includes(encodeURIComponent(secret)));
    assert.ok(!all.includes(JSON.stringify(secret).slice(1, -1)));
    assert.ok(all.includes('nothing secret here'));
    assert.equal((await redactTrace(input, [])).zip, input, 'unchanged when there is nothing to mask');
  });
});

describe('kept self-healing', () => {
  const metadata = {
    steps: [
      { stepId: 1, action: 'navigate', target: '/', status: 'passed' },
      { stepId: 2, action: 'click', target: '#old', status: 'passed', healedSelector: '#new' },
      { stepId: 3, action: 'click', target: '#broken', status: 'failed', healedSelector: '#tried' },
    ],
  };

  it('collects only successful heals', () => {
    assert.deepEqual(healedStepsOf(metadata), [{ stepId: 2, from: '#old', to: '#new' }]);
    assert.deepEqual(healedStepsOf({}), []);
  });

  it('rewrites a step only while it still has the broken selector', () => {
    const steps = [{ stepId: 1, action: 'navigate', target: '/' }, { stepId: 2, action: 'click', target: '#old' }];
    const first = applyHealing(steps, healedStepsOf(metadata));
    assert.equal(first.steps[1].target, '#new');
    assert.equal(first.applied.length, 1);
    const second = applyHealing(first.steps, healedStepsOf(metadata));
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(applyHealing(steps, healedStepsOf(metadata), [1]).applied.length, 0, 'limited to the chosen steps');
  });

  it('remembers heals per page path within a run', () => {
    const cache = new HealingCache();
    cache.set('#old', 'http://app/cart?x=1', '#new');
    assert.equal(cache.get('#old', 'http://app/cart?x=2'), '#new');
    assert.equal(cache.get('#old', 'http://app/other'), undefined);
  });

  it('classifies the new check steps', () => {
    for (const [action, kind] of [
      ['assert_accessible', 'assert_accessible'], ['Check accessibility', 'assert_accessible'], ['Verify the page meets WCAG', 'assert_accessible'],
      ['assert_screenshot', 'assert_screenshot'], ['Verify the header looks the same', 'assert_screenshot'], ['Verify it visually matches', 'assert_screenshot'],
      ['screenshot', 'screenshot'], ['Take a screenshot', 'screenshot'],
    ]) assert.equal(classifyAction(action, {}), kind, action);
  });
});

describe('HTML report', () => {
  it('includes evidence links, accessibility, visual differences and repaired selectors', async () => {
    const { ReportingAgentService } = await import('../modules/reporting/services/reporting-agent.service.js');
    const run: any = {
      id: 'RUN-1', agentId: 'A', status: 'failed', startedAt: new Date(), totalTests: 1, passedTests: 0, failedTests: 1, skippedTests: 0,
      results: [{
        id: 'R1', runId: 'RUN-1', testCaseId: 'TC-1', status: 'failed', startedAt: new Date(), error: 'boom',
        evidence: { screenshots: [], trace: 'RUN-1/R1-trace.zip?sig=1', video: 'RUN-1/R1-video.webm?sig=2' },
        metadata: {
          title: 'Checkout <script>',
          accessibility: [{ url: 'http://app/', level: 'wcag21aa', minImpact: 'serious', violations: [
            { id: 'image-alt', impact: 'critical', help: 'Images need alt', helpUrl: 'https://dequeuniversity.com/x', nodes: 1, targets: ['img'], counted: true },
          ] }],
          visual: [{ name: 'cart', viewport: '1280x800', persona: '', status: 'failed', ratio: 0.25, diff: 'RUN-1/d.png', baseline: 'baselines/p/a/b.png', actual: 'RUN-1/a.png' }],
          healing: { steps: [{ stepId: 2, from: '#old', to: '#new' }], applied: false },
        },
      }],
    };
    const html = new ReportingAgentService().render(run, 'html', { artifactsBaseUrl: 'http://x/artifacts/' });
    assert.match(html, /href="http:\/\/x\/artifacts\/RUN-1\/R1-trace\.zip\?sig=1">Playwright trace/);
    assert.match(html, /Accessibility \(WCAG21AA, http:\/\/app\/\): 1 violation\(s\) at serious\+/);
    assert.match(html, /Visual check "cart" \(1280x800\): failed, 25\.00% of pixels changed/);
    assert.match(html, /src="http:\/\/x\/artifacts\/RUN-1\/d\.png"/);
    assert.match(html, /<code>#old<\/code> → <code>#new<\/code>/);
    assert.ok(!html.includes('<script>'), 'titles are escaped');
  });
});

describe('failure triage', () => {
  it('ignores run-specific details in the failure signature', async () => {
    const { failureSignature } = await import('../modules/quality/triage.js');
    const a = failureSignature('Step 3 (click): Element "#buy-42" was not found or not actionable (locator.click: Timeout 10000ms exceeded.)', 'click');
    const b = failureSignature('Step 7 (click): Element "#buy-99" was not found or not actionable (locator.click: Timeout 2500ms exceeded.)', 'Click');
    assert.equal(a, b);
    assert.notEqual(a, failureSignature('Element "#buy" was not found or not actionable', 'fill'), 'the action is part of the signature');
    assert.equal(failureSignature('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4100/x', 'navigate'),
      failureSignature('page.goto: net::ERR_CONNECTION_REFUSED at http://10.0.0.5:8080/y', 'navigate'));
  });

  it('classifies failures by rules', async () => {
    const { classifyFailure } = await import('../modules/quality/triage.js');
    const cases: Array<[string, string]> = [
      ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://staging.example.com', 'environment'],
      ['Salesforce token request failed: invalid_grant', 'environment'],
      ['Element "#save" was not found or not actionable (locator.click: Timeout 10000ms exceeded.)', 'test_bug'],
      ['Unknown secret "PASSWORD" — define it in the agent\'s secrets', 'test_bug'],
      ['Expected #welcome to contain "Hello" but found "Hi"', 'app_bug'],
      ['Unexpected access to Opportunity for rep: delete is allowed (expected denied)', 'app_bug'],
      ['Screenshot "cart" (1280x800) differs from the baseline: 3.0% of pixels (900) changed, max 0.100%', 'app_bug'],
      ['2 accessibility violation(s) at serious+ (WCAG21AA): image-alt', 'app_bug'],
      ['Something odd happened', 'unknown'],
    ];
    for (const [error, category] of cases) assert.equal(classifyFailure(error).category, category, error);
  });

  it('groups the final attempt of each failed test, app bugs first', async () => {
    const { groupFailures, summarize } = await import('../modules/quality/triage.js');
    const result = (id: string, tc: string, status: string, error: string, startedAt: string, persona?: string) => ({
      id, testCaseId: tc, status, error, startedAt, metadata: { title: tc, persona, steps: [{ status: 'failed', action: 'assert_text', target: '#x' }] },
    });
    const groups = groupFailures([
      result('1', 'A', 'failed', 'Element "#a" was not found or not actionable', '2026-01-01T00:00:00Z'),
      result('2', 'A', 'passed', '', '2026-01-01T00:01:00Z'), // passed on retry: not a failure
      result('3', 'B', 'failed', 'Expected #x to contain "1" but found "2"', '2026-01-01T00:00:00Z', 'rep'),
      result('4', 'B', 'failed', 'Expected #x to contain "5" but found "6"', '2026-01-01T00:00:00Z', 'admin'),
      result('5', 'C', 'failed', 'Element "#c" was not found or not actionable', '2026-01-01T00:00:00Z'),
    ]);
    assert.deepEqual(groups.map((g) => [g.category, g.tests.length]), [['app_bug', 2], ['test_bug', 1]]);
    assert.deepEqual(groups[0].tests.map((t) => t.persona), ['rep', 'admin']);
    assert.deepEqual(summarize(groups), { app_bug: 2, test_bug: 1, environment: 0, unknown: 0 });
  });

  it('summarises triage in one line for notifications', async () => {
    const { triageLine } = await import('../modules/automation/notification.service.js');
    assert.equal(triageLine(undefined), undefined);
    assert.equal(triageLine({ summary: { app_bug: 2, test_bug: 1, environment: 0 }, groups: [
      { seenBefore: 0, tests: [{}, {}] }, { seenBefore: 3, tests: [{}] },
    ] }), 'Triage: 2 app bug, 1 test bug — 2 new failures');
    assert.equal(triageLine({ summary: { environment: 1 }, groups: [{ seenBefore: 1, tests: [{}] }] }), 'Triage: 1 environment — all seen before');
  });
});
