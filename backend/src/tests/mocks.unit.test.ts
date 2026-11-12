/**
 * Mock APIs and CI templates (no server).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answer, answerFromSpec, MockState, pathRegex, validateMockService } from '../modules/mocks/mocks.js';
import { CI_RUN_SCRIPT, ciTemplate, jenkinsfile } from '../modules/integrations/triggers.js';

const spec = {
  openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '/api' }],
  paths: {
    '/orders/{id}': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { examples: { one: { value: { id: 7 } } } } } } } } },
    '/orders': { post: { responses: { 201: { description: 'made', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer', example: 1 } } } } } } } } },
  },
};

describe('mock APIs', () => {
  it('matches path templates and wildcards', () => {
    assert.ok(pathRegex('/orders/{id}').test('/orders/12'));
    assert.ok(pathRegex('/orders/{id}').test('/orders/12/'));
    assert.ok(!pathRegex('/orders/{id}').test('/orders/12/items'));
    assert.ok(pathRegex('/files/*').test('/files/a/b.png'));
    assert.ok(pathRegex('/a.b').test('/a.b') && !pathRegex('/a.b').test('/axb'));
  });

  it('answers from the spec: examples first, else a sample of the schema; base path optional', () => {
    assert.deepEqual(answerFromSpec(spec, 'GET', '/api/orders/3'), { status: 200, body: { id: 7 }, headers: {}, delayMs: 0, source: 'spec' });
    assert.deepEqual(answerFromSpec(spec, 'get', '/orders/3')?.body, { id: 7 });
    assert.deepEqual(answerFromSpec(spec, 'POST', '/api/orders'), { status: 201, body: { id: 1 }, headers: {}, delayMs: 0, source: 'spec' });
    assert.equal(answerFromSpec(spec, 'DELETE', '/api/orders/3'), null);
  });

  it('answers one-off test answers first (as many times as asked), then routes, then the spec', () => {
    const svc = { id: 'unit-svc', spec, routes: [{ method: 'GET', path: '/orders/{id}', status: 200, body: { from: 'route' } }] };
    MockState.respond(svc.id, { method: 'get', path: '/orders/{id}', status: 503, body: { down: true }, times: 2 });
    assert.deepEqual([answer(svc, 'GET', '/orders/1').status, answer(svc, 'GET', '/orders/2').status, answer(svc, 'GET', '/orders/3').body], [503, 503, { from: 'route' }]);
    assert.equal(answer(svc, 'POST', '/api/orders').source, 'spec');
    assert.deepEqual([answer(svc, 'PUT', '/x').status, answer(svc, 'PUT', '/x').source], [404, 'none']);
    MockState.record(svc.id, { at: new Date(Date.now() - 60_000).toISOString(), method: 'GET', path: '/old', query: {}, status: 200, source: 'route' });
    MockState.record(svc.id, { at: new Date().toISOString(), method: 'GET', path: '/new', query: {}, status: 200, source: 'route' });
    assert.deepEqual(MockState.calls(svc.id, new Date(Date.now() - 1000)).map((c) => c.path), ['/new']);
    MockState.clear(svc.id);
  });

  it('validates services', () => {
    assert.deepEqual(validateMockService({ name: 'Pay', routes: [{ method: 'post', path: '/p', status: 201, delay_ms: 100 }] }), []);
    assert.equal(validateMockService({ name: '' })[0], 'name is required (up to 100 characters)');
    assert.match(validateMockService({ name: 'x', routes: [{ method: 'GET', path: '/a', delay_ms: 60_000 }] })[0], /delay_ms must be 0–10000/);
  });
});

describe('CI templates', () => {
  it('writes a Jenkinsfile whose shell step survives Groovy string escaping', () => {
    const jf = jenkinsfile({ apiUrl: 'https://atab.example.com/api/v1/', projectId: 'p1', agentId: 'a1', agentName: 'Shop' });
    assert.match(jf, /ATAB_URL = 'https:\/\/atab\.example\.com\/api\/v1'/);
    const groovy = jf.split("sh '''")[1].split("'''")[0];
    // What Groovy hands to the shell: \\ becomes \
    const shell = groovy.replace(/\\\\/g, '\\');
    for (const line of CI_RUN_SCRIPT.split('\n')) assert.ok(shell.includes(line), line);
    assert.match(shell, /sed -E 's#\\\.git\$##; s#\^\.\*\[:\/\]\(\[\^\/\]\+\/\[\^\/\]\+\)\$#\\1#'/);
    assert.ok(!/\\[^\\$n]/.test(groovy.replace(/\\\\/g, '')), 'no backslash Groovy would not understand');
  });

  it('serves every kind', () => {
    const o = { apiUrl: 'https://x/api/v1', projectId: 'p', agentId: 'a', agentName: 'A' };
    assert.deepEqual(['github', 'gitlab', 'azure', 'jenkins'].map((k) => ciTemplate(k as any, o).path), ['.github/workflows/ai-tests.yml', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile']);
  });
});
