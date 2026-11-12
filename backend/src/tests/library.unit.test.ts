/**
 * Library: block expansion, element references, validation (no database).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { elementNamesIn, elementRef, expandSteps, resolveElements, validateBlock, validateElement } from '../modules/library/library.js';

const blocks = new Map(Object.entries({
  'sign in': { name: 'Sign in', params: [{ name: 'user' }, { name: 'pw', default: 'secret' }], steps: [
    { stepId: 1, action: 'fill', target: '#u', data: { value: '{{param.user}}' } },
    { stepId: 2, action: 'fill', target: '#p', data: { value: '{{param.pw}}', note: ['{{param.user}}'] } },
  ] },
  'checkout': { name: 'Checkout', params: [{ name: 'buyer' }], steps: [
    { stepId: 1, action: 'use_block', target: 'Sign in', data: { params: { user: '{{param.buyer}}' } } },
    { stepId: 2, action: 'click', target: 'text=Pay' },
  ] },
  'a': { name: 'A', params: [], steps: [{ stepId: 1, action: 'use_block', target: 'B' }] },
  'b': { name: 'B', params: [], steps: [{ stepId: 1, action: 'use_block', target: 'A' }] },
}));

describe('library', () => {
  it('expands blocks with parameters, nested, keeping where each step comes from', () => {
    const steps = expandSteps([
      { stepId: 1, action: 'navigate', target: '/' },
      { stepId: 2, action: 'use_block', target: 'CHECKOUT', data: { params: { buyer: 'ann' } } },
      { stepId: 3, action: 'assert_text', target: 'h1', data: { value: 'Paid' } },
    ], blocks);
    assert.deepEqual(steps, [
      { stepId: 1, action: 'navigate', target: '/' },
      { stepId: 2, action: 'fill', target: '#u', data: { value: 'ann' }, origin: { block: 'Sign in', blockStepId: 1, path: '2.1.1' } },
      { stepId: 2, action: 'fill', target: '#p', data: { value: 'secret', note: ['ann'] }, origin: { block: 'Sign in', blockStepId: 2, path: '2.1.2' } },
      { stepId: 2, action: 'click', target: 'text=Pay', origin: { block: 'Checkout', blockStepId: 2, path: '2.2' } },
      { stepId: 3, action: 'assert_text', target: 'h1', data: { value: 'Paid' } },
    ]);
  });

  it('explains wrong uses of blocks', () => {
    assert.throws(() => expandSteps([{ stepId: 4, action: 'use_block', target: 'Nope' }], blocks), /Step 4: unknown block "Nope"/);
    assert.throws(() => expandSteps([{ stepId: 1, action: 'use_block', target: 'Sign in' }], blocks), /needs the parameter "user"/);
    assert.throws(() => expandSteps([{ stepId: 1, action: 'use_block', target: 'Sign in', data: { params: { user: 'x', role: 'y' } } }], blocks), /has no parameter "role" \(it has: user, pw\)/);
    assert.throws(() => expandSteps([{ stepId: 1, action: 'use_block', target: 'A' }], blocks), /Block "A" uses itself \(a → b → a\)/);
  });

  it('resolves element references', () => {
    const els = new Map([['cart.total', { name: 'Cart.Total', locator: '[data-testid="total"]' }]]);
    assert.equal(resolveElements('{{el.Cart.Total}} >> span', els), '[data-testid="total"] >> span');
    assert.equal(resolveElements('{{ el.cart.total }}', els), '[data-testid="total"]');
    assert.throws(() => resolveElements('{{el.Cart.Tax}}', els), /Unknown element \{\{el\.Cart\.Tax\}\}/);
    assert.equal(elementRef(' {{el.Cart.Total}} '), 'Cart.Total');
    assert.equal(elementRef('{{el.Cart.Total}} >> span'), undefined);
    assert.deepEqual(elementNamesIn([{ stepId: 1, action: 'click', target: '{{el.A.B}}', data: { value: '{{el.C}}' } }]), ['A.B', 'C']);
  });

  it('validates blocks and elements', () => {
    assert.deepEqual(validateBlock({ name: 'Ok', params: [{ name: 'x' }], steps: [{ action: 'fill', data: { value: '{{param.x}}' } }] }), []);
    assert.deepEqual(validateBlock({ name: '', steps: [] }), ['name is required (up to 200 characters)', 'steps must be a non-empty list']);
    assert.match(validateBlock({ name: 'X', params: [{ name: 'a b' }, { name: 'c' }, { name: 'c' }], steps: [{ action: 'x' }] }).join('\n'), /"a b" is not a valid name[\s\S]*"c" is listed twice/);
    assert.deepEqual(validateElement({ name: 'Login.Submit', locator: 'role=button[name="Sign in"]', alternatives: ['#submit'] }), []);
    assert.equal(validateElement({ name: 'Login.Submit', locator: '{{el.Other}}' })[0], 'locator cannot use another element');
    assert.deepEqual(validateElement({ locator: '#x' }, true), []);
  });
});
