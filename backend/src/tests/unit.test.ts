/**
 * Unit tests (no database, no network): `npm test`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction, looksLikeSelector, stepValue } from '../modules/execution/step-runner.js';
import { normalizeTestCaseInput, validateTestCaseInput } from '../core/domain/normalize.js';
import { validateTestCase } from '../core/domain/test-case.js';
import { extractJsonArray } from '../infra/llm/json.js';
import { flattenForPrompt } from '../infra/llm/copilot.js';
import { normalizeProvider } from '../infra/llm/client.js';
import { buildAgentConfig } from '../api/controllers/agents.controller.js';
import { detectSourceType } from '../modules/ingestion/services/document-parser.service.js';
import { latestAttempts } from '../modules/reporting/services/reporting-agent.service.js';

describe('step classification', () => {
  const cases: Array<[string, any, string]> = [
    ['navigate', { target: '/login' }, 'navigate'],
    ['Navigate to login page', { target: '/login' }, 'navigate'],
    ['Go to the dashboard', {}, 'navigate'],
    ['click', { target: '#submit' }, 'click'],
    ['Click on login button', { target: '#login-btn' }, 'click'],
    ['fill', { target: '#user', data: { value: 'bob' } }, 'fill'],
    ['Enter username', { target: '#username', data: { value: 'bob' } }, 'fill'],
    ['select', { target: '#country', data: { value: 'IT' } }, 'select'],
    ['press', { data: { value: 'Enter' } }, 'press'],
    ['assert_text', { data: { value: 'Welcome' } }, 'assert_text'],
    ['Verify welcome message is displayed', { target: '.welcome' }, 'assert_visible'],
    ['Verify the URL contains /dashboard', { data: { value: '/dashboard' } }, 'assert_url'],
    ['assert_title', { data: { value: 'Home' } }, 'assert_title'],
    ['wait', { data: { ms: 100 } }, 'wait'],
    ['screenshot', {}, 'screenshot'],
    ['salesforce_login', {}, 'salesforce_login'],
    ['Observe nothing in particular happens and feel happy', {}, 'assert_text'],
    ['Think about life', {}, 'manual'],
  ];
  for (const [action, step, expected] of cases) {
    it(`"${action}" → ${expected}`, () => assert.equal(classifyAction(action, step), expected));
  }

  it('detects selectors vs plain text', () => {
    assert.ok(looksLikeSelector('#login'));
    assert.ok(looksLikeSelector('text=Sign in'));
    assert.ok(looksLikeSelector('input[name="q"]'));
    assert.ok(looksLikeSelector('button'));
    assert.ok(!looksLikeSelector('Sign in button'));
  });

  it('reads step values from several shapes', () => {
    assert.equal(stepValue({ data: { value: 'a' } }), 'a');
    assert.equal(stepValue({ data: { text: 'b' } }), 'b');
    assert.equal(stepValue({ data: { username: 'c' } }), 'c');
    assert.equal(stepValue({}), undefined);
  });
});

describe('test case normalization', () => {
  it('normalizes LLM output', () => {
    const tc = normalizeTestCaseInput({
      name: 'Login works',
      priority: 'high',
      steps: ['Open the app', { action: 'click', selector: '#go', value: 'x' }],
      expected_results: 'Dashboard shown',
    }, { documentId: 'DOC-1', tags: ['agent:A'] })!;
    assert.equal(tc.title, 'Login works');
    assert.equal(tc.priority, 'High');
    assert.equal(tc.module, 'General');
    assert.equal(tc.steps.length, 2);
    assert.deepEqual(tc.steps[1], { action: 'click', target: '#go', data: { value: 'x' } });
    assert.deepEqual(tc.expectedResults, ['Dashboard shown']);
    assert.equal(tc.documentId, 'DOC-1');
    assert.deepEqual(tc.tags, ['agent:A']);
  });

  it('rejects items without a title', () => {
    assert.equal(normalizeTestCaseInput({ steps: [] }), null);
  });

  it('validates API input', () => {
    assert.deepEqual(validateTestCaseInput({ title: 'x', module: 'm', steps: [{ action: 'click' }] }), []);
    assert.ok(validateTestCaseInput({ name: 'x' }).length >= 2);
    assert.ok(validateTestCaseInput({ title: 'x', module: 'm', priority: 'Urgent' }).some((e) => e.includes('priority')));
    assert.deepEqual(validateTestCaseInput({ priority: 'Low' }, true), []);
  });

  it('keeps the legacy domain validator working', () => {
    const result = validateTestCase({
      id: 'TC-1', title: 'Login', module: 'Auth', priority: 'High',
      steps: [{ stepId: 1, action: 'navigate', target: '/login' }],
      expectedResults: ['ok'],
    });
    assert.equal(result.valid, true);
  });
});

describe('LLM helpers', () => {
  it('extracts JSON arrays from fenced or chatty responses', () => {
    assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
    assert.deepEqual(extractJsonArray('Here you go: [{"a":2}] hope it helps'), [{ a: 2 }]);
    assert.deepEqual(extractJsonArray('{"testCases":[{"a":3}]}'), [{ a: 3 }]);
    assert.deepEqual(extractJsonArray('{"a":4}'), [{ a: 4 }]);
    assert.throws(() => extractJsonArray('no json here'));
  });

  it('normalizes provider aliases', () => {
    assert.equal(normalizeProvider('claude'), 'anthropic');
    assert.equal(normalizeProvider('GitHub'), 'copilot');
    assert.equal(normalizeProvider('openai'), 'openai');
    assert.equal(normalizeProvider('nope'), undefined);
  });

  it('flattens conversations for the Copilot CLI/SDK', () => {
    const single = flattenForPrompt([{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }]);
    assert.deepEqual(single, { system: 'S', prompt: 'Hi' });
    const multi = flattenForPrompt([
      { role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' },
    ]);
    assert.equal(multi.prompt, 'User: A\n\nAssistant: B\n\nUser: C\n\nAssistant:');
  });
});

describe('agent config', () => {
  it('requires a valid base URL', () => {
    assert.ok(buildAgentConfig('a', {}).errors.length > 0);
    assert.ok(buildAgentConfig('a', { base_url: 'not a url' }).errors.length > 0);
    assert.ok(buildAgentConfig('a', { base_url: 'ftp://x' }).errors.length > 0);
  });

  it('fills defaults', () => {
    const { errors, config } = buildAgentConfig('Shop', { base_url: 'https://shop.test', retries: 9, test_selection: { priority: ['High', ''] } });
    assert.deepEqual(errors, []);
    assert.equal(config!.agent_name, 'Shop');
    assert.equal(config!.application_type, 'web');
    assert.equal(config!.retries, 3);
    assert.deepEqual(config!.test_selection.priority, ['High']);
  });
});

describe('ingestion', () => {
  it('detects document types', () => {
    assert.equal(detectSourceType('application/pdf', 'a.pdf'), 'pdf');
    assert.equal(detectSourceType('application/octet-stream', 'spec.docx'), 'word');
    assert.equal(detectSourceType('text/csv', 'cases.csv'), 'csv');
    assert.equal(detectSourceType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x.xlsx'), 'excel');
    assert.equal(detectSourceType('text/plain', 'notes.md'), 'markdown');
    assert.equal(detectSourceType('text/plain', 'notes.txt'), 'text');
  });
});

describe('reporting', () => {
  it('keeps the latest attempt per test', () => {
    const r = (id: string, tc: string, t: number, status: any) => ({ id, runId: 'R', testCaseId: tc, status, startedAt: new Date(t) });
    const latest = latestAttempts([r('1', 'A', 1, 'failed'), r('2', 'A', 2, 'passed'), r('3', 'B', 1, 'failed')]);
    assert.equal(latest.length, 2);
    assert.equal(latest.find((x) => x.testCaseId === 'A')!.status, 'passed');
  });
});
