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

describe('flaky-test quarantine', () => {
  const h = (s: string) => s.split('').map((c) => ({ status: c === 'P' || c === 'R' ? 'passed' : c === 'S' ? 'skipped' : 'failed', attempt: c === 'R' ? 2 : 1 }));

  it('measures flips, passes on retry and the clean streak', async () => {
    const { flakeStats } = await import('../modules/quality/quarantine.js');
    assert.deepEqual(flakeStats(h('PFPFPP')), { runs: 6, flips: 4, passedOnRetry: 0, failures: 2, cleanStreak: 2 });
    assert.deepEqual(flakeStats(h('PRPSRP')), { runs: 5, flips: 0, passedOnRetry: 2, failures: 0, cleanStreak: 1 });
    assert.equal(flakeStats(h('FFFF')).flips, 0);
  });

  it('quarantines flaky tests, not consistently failing ones, and releases after a clean streak', async () => {
    const { decide, flakeStats, quarantinePolicy, describeFlake } = await import('../modules/quality/quarantine.js');
    const policy = quarantinePolicy({ quarantine: { auto: true, flips: 3, passed_on_retry: 2, release_after: 3 } });
    assert.deepEqual(policy, { auto: true, flips: 3, window: 10, passedOnRetry: 2, releaseAfter: 3 });
    assert.equal(decide(flakeStats(h('PFPFP')), policy), 'quarantine');
    assert.equal(decide(flakeStats(h('PRPR')), policy), 'quarantine', 'passing only on retry is flaky too');
    assert.equal(decide(flakeStats(h('FFFFFF')), policy), null, 'always failing is a real failure');
    assert.equal(decide(flakeStats(h('PPPP')), policy), null);
    assert.equal(decide(flakeStats(h('PFPFP')), quarantinePolicy({})), null, 'auto is off by default');

    const auto = { testCaseId: 't', projectId: 'p', reason: 'x', auto: true, quarantinedAt: new Date() };
    assert.equal(decide(flakeStats(h('FPFPPP')), policy, auto), 'release');
    assert.equal(decide(flakeStats(h('FPFPP')), policy, auto), null);
    assert.equal(decide(flakeStats(h('FPPPPP')), policy, { ...auto, auto: false }), null, 'hand-quarantined tests stay until released by hand');
    assert.match(describeFlake(flakeStats(h('PFPFP')), policy), /flipped between pass and fail 4 times in its last 5 runs/);
  });

  it('reports failed quarantined tests as skipped in JUnit', async () => {
    const { ReportingAgentService } = await import('../modules/reporting/services/reporting-agent.service.js');
    const run: any = {
      id: 'RUN-Q', agentId: 'A', status: 'completed', startedAt: new Date(), totalTests: 2, passedTests: 1, failedTests: 0, skippedTests: 0,
      results: [
        { id: '1', testCaseId: 'T1', status: 'failed', error: 'Expected "OK"', startedAt: new Date(), metadata: { title: 'Flaky checkout', quarantined: true } },
        { id: '2', testCaseId: 'T2', status: 'passed', startedAt: new Date(), metadata: { title: 'Login' } },
      ],
    };
    const xml = new ReportingAgentService().render(run, 'junit');
    assert.match(xml, /<testsuites [^>]*failures="0" errors="0" skipped="1"/);
    assert.match(xml, /<skipped message="quarantined \(flaky\): Expected &quot;OK&quot;"\/>/);
  });
});

describe('API testing', () => {
  it('reads JSON paths', async () => {
    const { jsonPath } = await import('../modules/quality/api-testing.js');
    const doc = { items: [{ name: 'A', tags: ['x'] }, { name: 'B' }], 'odd key': 1, total: 0 };
    assert.deepEqual(jsonPath(doc, '$.items[1].name'), { found: true, value: 'B' });
    assert.deepEqual(jsonPath(doc, 'items[0].tags[0]'), { found: true, value: 'x' });
    assert.deepEqual(jsonPath(doc, '$.items.length'), { found: true, value: 2 });
    assert.deepEqual(jsonPath(doc, "$['odd key']"), { found: true, value: 1 });
    assert.deepEqual(jsonPath(doc, '$.total'), { found: true, value: 0 }, 'falsy values are found');
    assert.deepEqual(jsonPath(doc, '$.items[5].name'), { found: false, value: undefined });
    assert.deepEqual(jsonPath([1, 2], '$[1]'), { found: true, value: 2 });
    assert.throws(() => jsonPath(doc, '$..name'), /Unsupported JSON path/);
  });

  it('matches statuses and checks JSON expectations', async () => {
    const { statusMatches, checkJson } = await import('../modules/quality/api-testing.js');
    assert.ok(statusMatches(201, '2xx') && statusMatches(404, 404) && statusMatches(204, [200, 204]) && !statusMatches(500, '4xx'));
    const body = { id: 7, name: 'Lamp', tags: ['new', 'sale'], price: null };
    assert.equal(checkJson(body, { path: '$.id', equals: 7 }), '$.id = 7');
    assert.equal(checkJson(body, { path: '$.id', equals: '7' }), '$.id = 7', 'loose comparison for scalars');
    assert.match(checkJson(body, { path: '$.tags', contains: 'sale' }), /contains/);
    assert.match(checkJson(body, { path: '$.price', type: 'null' }), /is null/);
    assert.match(checkJson(body, { path: '$.missing', exists: false }), /does not exist/);
    assert.throws(() => checkJson(body, { path: '$.name', equals: 'Desk' }), /Expected \$\.name to equal "Desk" but it is "Lamp"/);
    assert.throws(() => checkJson(body, { path: '$.tags', length: 3 }), /have length 3 but it has 2/);
    assert.throws(() => checkJson(undefined, { path: '$.id' }), /not JSON/);
  });

  it('captures variables from responses', async () => {
    const { extractVars } = await import('../modules/quality/api-testing.js');
    const vars: Record<string, string> = {};
    const res: any = { json: { id: 42, owner: { email: 'a@b.c' } } };
    assert.deepEqual(extractVars(res, { orderId: '$.id', owner: '$.owner' }, vars), ['orderId', 'owner']);
    assert.deepEqual(vars, { orderId: '42', owner: '{"email":"a@b.c"}' });
    assert.throws(() => extractVars(res, { x: '$.nope' }, vars), /not in the response/);
    assert.throws(() => extractVars(res, { 'bad name': '$.id' }, vars), /Invalid variable name/);
    const { resolvePlaceholders } = await import('../core/domain/agent-secrets.js');
    assert.equal(resolvePlaceholders('orders/{{vars.orderId}}', {}, vars), 'orders/42');
    assert.throws(() => resolvePlaceholders('{{vars.nope}}', {}, vars), /Unknown variable "nope"/);
  });

  it('builds smoke tests from an OpenAPI description', async () => {
    const { listOperations, parseSpec, smokeTest, sampleFor } = await import('../modules/quality/openapi-tests.js');
    const spec = parseSpec(`openapi: 3.0.3
info: { title: Shop, version: '1' }
paths:
  /items/{id}:
    get:
      parameters: [{ name: id, in: path, required: true, schema: { type: integer, example: 5 } }]
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Item' } } } } }
  /items:
    post:
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/Item' } } } }
      responses: { '201': { description: created } }
components:
  schemas:
    Item:
      type: object
      required: [name, price]
      properties: { name: { type: string }, price: { type: number, minimum: 0 }, email: { type: string, format: email, example: x@y.z }, note: { type: string } }
`);
    const ops = listOperations(spec);
    assert.deepEqual(ops.map((o) => `${o.method} ${o.path}`), ['GET /items/{id}', 'POST /items']);
    assert.deepEqual(sampleFor(spec, { $ref: '#/components/schemas/Item' }), { name: 'test', price: 0, email: 'x@y.z' });
    const get = smokeTest(ops[0]).test!;
    assert.deepEqual(get.steps.map((s) => [s.action, s.target, s.data]), [
      ['http_request', 'items/5', { method: 'GET' }],
      ['assert_status', undefined, { value: '200' }],
      ['assert_json', undefined, { path: '$.name' }],
      ['assert_json', undefined, { path: '$.price' }],
    ]);
    assert.equal(smokeTest(ops[1]).test!.steps[0].data!.json.name, 'test');
    assert.throws(() => parseSpec('{"openapi":"3.0.0"}'), /no "paths"/);
    const { basePathOf } = await import('../modules/quality/openapi-tests.js');
    assert.equal(basePathOf({ openapi: '3.0.0', servers: [{ url: '/api/v1/' }] }), '/api/v1');
    assert.equal(basePathOf({ openapi: '3.0.0', servers: [{ url: 'https://api.example.com/v1' }] }), '', 'absolute: set the API base URL instead');
    assert.equal(basePathOf({ swagger: '2.0', basePath: '/v2' }), '/v2');
    assert.equal(smokeTest(ops[0], '/v1').test!.steps[0].target, 'v1/items/5');
  });

  it('classifies API steps, including natural phrasing', () => {
    for (const [action, step, kind] of [
      ['http_request', {}, 'http_request'], ['GET /api/users', {}, 'http_request'], ['POST', { target: '/orders' }, 'http_request'],
      ['Send a request to the orders endpoint', {}, 'http_request'],
      ['Verify the status code is 201', {}, 'assert_status'], ['Verify the response time is under 500 ms', {}, 'assert_response_time'],
      ['Verify the response header content-type', {}, 'assert_header'], ['Verify the JSON contains the order id', {}, 'assert_json'],
      ['Mock the payments API', { target: '**/payments' }, 'mock_route'], ['block_route', {}, 'block_route'],
      ['Get started', {}, 'manual'], ['Verify the page header is shown', { target: 'h1' }, 'assert_visible'],
    ] as Array<[string, any, string]>) assert.equal(classifyAction(action, step), kind, action);
  });
});

describe('AI-judged assertions', () => {
  it('parses verdicts and treats malformed answers as unsure', async () => {
    const { parseVerdict, decideVerdict } = await import('../modules/quality/ai-assert.js');
    assert.deepEqual(parseVerdict('{"verdict":"pass","confidence":0.9,"reason":"Shows order #42"}'), { verdict: 'pass', confidence: 0.9, reason: 'Shows order #42' });
    assert.equal(parseVerdict('Sure!\n```json\n{"verdict":"fail","confidence":2,"reason":"x"}\n```').confidence, 1, 'clamped');
    assert.equal(parseVerdict('I think it passes').verdict, 'unsure');
    assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, 'unsure');
    assert.equal(decideVerdict({ verdict: 'pass', confidence: 0.9 }, 0.7, 'fail'), true);
    assert.equal(decideVerdict({ verdict: 'pass', confidence: 0.5 }, 0.7, 'fail'), false, 'not confident enough');
    assert.equal(decideVerdict({ verdict: 'fail', confidence: 0.99 }, 0.7, 'pass'), false);
    assert.equal(decideVerdict({ verdict: 'unsure', confidence: 0 }, 0.7, 'fail'), false);
    assert.equal(decideVerdict({ verdict: 'unsure', confidence: 0 }, 0.7, 'pass'), true);
  });

  it('judges the live page or an element, masks secrets and caches identical content', async () => {
    const { judgeExpectation } = await import('../modules/quality/ai-assert.js');
    const { launchBrowser, outlinePage } = await import('../modules/execution/browser.js');
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<title>Order</title><h1>Thank you</h1><p id="msg">Order #42 confirmed for token SECRET-TOKEN-123</p><button>Track order</button>');
      const seen: string[] = [];
      const judge = async (_system: string, user: string) => {
        seen.push(user);
        return { content: '{"verdict":"pass","confidence":0.95,"reason":"It says Order #42 confirmed"}', provider: 'stub' };
      };
      const opts = { judge, outline: (p: any) => outlinePage(p, 20), mask: (t: string) => t.split('SECRET-TOKEN-123').join('••••'), cache: new Map() };
      const v1 = await judgeExpectation(page, null, 'The page confirms the order with its number', opts);
      assert.equal(v1.passed, true);
      assert.equal(v1.provider, 'stub');
      assert.match(seen[0], /Expectation: The page confirms the order with its number/);
      assert.match(seen[0], /Visible text:\n[\s\S]*Order #42 confirmed/);
      assert.match(seen[0], /button selector="text=Track order"/);
      assert.ok(!seen[0].includes('SECRET-TOKEN-123'), 'secrets are masked before sending');

      const v2 = await judgeExpectation(page, null, 'The page confirms the order with its number', opts);
      assert.equal(v2.cached, true);
      assert.equal(seen.length, 1, 'identical content is judged once');

      await judgeExpectation(page, page.locator('#msg'), 'Mentions the order number', opts);
      assert.match(seen[1], /Element text:\nOrder #42 confirmed/);
      assert.doesNotMatch(seen[1], /Headings and controls/);
    } finally {
      await browser.close();
    }
  });

  it('classifies AI-check steps', () => {
    for (const [action, kind] of [
      ['assert_ai', 'assert_ai'], ['Verify with AI that the cart shows 3 items', 'assert_ai'], ['Check using the AI whether the tone is polite', 'assert_ai'],
      ['Verify the AI assistant is visible', 'assert_text'],
    ] as Array<[string, string]>) assert.equal(classifyAction(action, {}), kind, action);
  });
});

describe('test data generation', () => {
  it('gives the same value for the same kind and label within a test', async () => {
    const { createFaker, FakeValues } = await import('../modules/quality/test-data-gen.js');
    const values = new FakeValues(await createFaker('en'));
    const email = values.get('email', 'buyer');
    assert.equal(values.get('email', 'buyer'), email);
    assert.notEqual(values.get('email', 'seller'), email);
    assert.match(email, /@example\.(com|net|org)$/, 'emails never reach real mailboxes');
    assert.match(values.get('password'), /[A-Z]/);
    assert.match(values.get('password'), /\d/);
    assert.ok(['4111111111111111', '5555555555554444', '378282246310005', '4000056655665556'].includes(values.get('testCard')));
    assert.match(values.get('date'), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(values.get('expiry'), /^\d{2}\/\d{2}$/);
    assert.deepEqual(Object.keys(values.used()).sort(), ['date', 'email:buyer', 'email:seller', 'expiry', 'password', 'testCard']);
    assert.throws(() => values.get('ssn'), /Unknown fake data kind "ssn"/);
  });

  it('is reproducible with a seed and follows the locale', async () => {
    const { createFaker, FakeValues, seedFor } = await import('../modules/quality/test-data-gen.js');
    const run = async (seed: unknown, test: string) => {
      const v = new FakeValues(await createFaker('it', seedFor(seed, test, undefined, 0)));
      return [v.get('fullName'), v.get('city'), v.get('zip')].join('|');
    };
    assert.equal(await run(42, 'TC-1'), await run(42, 'TC-1'));
    assert.notEqual(await run(42, 'TC-1'), await run(42, 'TC-2'), 'each test gets its own values');
    assert.equal(seedFor(undefined, 'x'), undefined);
    assert.match((await run(42, 'TC-1')).split('|')[2], /^\d{5}$/, 'Italian postal codes');
    await assert.rejects(createFaker('xx_YY'), /Unknown test data locale/);
  });

  it('resolves data, fake and secret placeholders', async () => {
    const { resolvePlaceholders } = await import('../core/domain/agent-secrets.js');
    const fake = { get: (kind: string, label = '') => `<${kind}${label ? `:${label}` : ''}>` };
    const row = { user: 'ada', address: { city: 'Turin' }, qty: 3, active: false };
    const r = (t: string) => resolvePlaceholders(t, { PW: 's3cret' }, { id: '7' }, { data: row, fake });
    assert.equal(r('{{data.user}} lives in {{ data.address.city }}'), 'ada lives in Turin');
    assert.equal(r('{{data.qty}}/{{data.active}}'), '3/false');
    assert.equal(r('{{fake.email}} {{fake.email:admin}} {{secrets.PW}} {{vars.id}}'), '<email> <email:admin> s3cret 7');
    assert.throws(() => r('{{data.nope}}'), /Unknown data field "nope" — the row has: user, address, qty, active/);
    assert.throws(() => resolvePlaceholders('{{data.user}}', {}, {}, {}), /needs a data set/);
    assert.throws(() => resolvePlaceholders('{{fake.email}}', {}, {}, {}), /only available while a test runs/);
    assert.equal(r('{{secrets.PW:x}}'), '{{secrets.PW:x}}', 'labels only apply to fake values');
  });

  it('reads data set rows and labels them', async () => {
    const { datasetRows, rowLabel } = await import('../modules/quality/test-data-gen.js');
    assert.equal(datasetRows({ rows: [{ a: 1 }, 'bad', null, { b: 2 }] }).length, 2);
    assert.deepEqual(datasetRows({ user: 'x' }), [{ user: 'x' }]);
    assert.deepEqual(datasetRows(null), []);
    assert.equal(rowLabel({ _label: 'empty email' }, 0), 'empty email');
    assert.equal(rowLabel({ name: 'Ada' }, 1), 'Ada');
    assert.equal(rowLabel({ qty: 2 }, 2), 'row 3');
  });

  it('generates rows from field kinds and sanitizes AI rows', async () => {
    const { generateRows, sanitizeRows } = await import('../modules/quality/test-data-gen.js');
    const rows = await generateRows({ name: 'fullName', email: 'email', qty: 'number' }, 5, { locale: 'de', seed: 1 });
    assert.equal(rows.length, 5);
    assert.deepEqual(Object.keys(rows[0]), ['name', 'email', 'qty']);
    assert.deepEqual(rows, await generateRows({ name: 'fullName', email: 'email', qty: 'number' }, 5, { locale: 'de', seed: 1 }), 'seeded generation is reproducible');
    assert.equal(new Set(rows.map((r) => r.email)).size, 5, 'each row gets new values');
    await assert.rejects(generateRows({ email: 'nope' }, 2), /Unknown fake data kind "nope"/);
    await assert.rejects(generateRows({ 'bad col': 'email' }, 2), /Invalid column name/);
    await assert.rejects(generateRows({}, 2), /fields must map/);
    assert.equal((await generateRows({ e: 'email' }, 1000)).length, 100, 'capped at 100 rows');

    const clean = sanitizeRows([{ ok: 'x', 'bad key': 1, nested: { a: 1 }, n: 2, b: true, z: null, long: 'y'.repeat(2000) }, 'text', {}, { ok: 'y' }], 10);
    assert.deepEqual(Object.keys(clean[0]), ['ok', 'n', 'b', 'z', 'long']);
    assert.equal((clean[0].long as string).length, 1000);
    assert.equal(clean.length, 2);
    assert.equal(sanitizeRows([{ a: 1 }, { a: 2 }, { a: 3 }], 2).length, 2);
    assert.deepEqual(sanitizeRows('nope', 5), []);
  });

  it('classifies data set problems as test bugs', async () => {
    const { classifyFailure } = await import('../modules/quality/triage.js');
    assert.equal(classifyFailure('Test data set "users" not found in this project').category, 'test_bug');
    assert.equal(classifyFailure('Unknown data field "mail" — the row has: email').category, 'test_bug');
  });
});
