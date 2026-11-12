/**
 * Plain-English steps: sentence rules, library use, the AI prompt and its answers (no AI, no browser).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aiPrompt, cleanAiSteps, convertByRules, convertText, splitClauses } from '../modules/authoring/plain-english.js';

delete process.env.COPILOT_MODE;
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'LLM_PROVIDER']) delete process.env[k];

const lib = {
  blocks: [{ name: 'Sign in', params: [{ name: 'user' }] }, { name: 'Create opportunity', params: [{ name: 'account' }, { name: 'amount' }] }],
  elements: [{ name: 'Checkout.PayButton', locator: '[data-testid="pay"]' }, { name: 'Cart.Total', locator: '#t' }],
};
const one = (text: string) => convertByRules(text, lib).map((l) => (l.via === 'rules' ? l.steps : null));

describe('plain-English steps', () => {
  it('splits sentences into clauses, never inside quotes', () => {
    assert.deepEqual(splitClauses('1. Go to /cart, then click Pay\n- Type "a, then b" into Notes; press Enter.'), ['Go to /cart', 'click Pay', 'Type "a, then b" into Notes', 'press Enter']);
  });

  it('understands the usual phrasings', () => {
    assert.deepEqual(one('Go to /cart'), [[{ action: 'navigate', target: '/cart' }]]);
    assert.deepEqual(one('Open https://shop.example/x'), [[{ action: 'navigate', target: 'https://shop.example/x' }]]);
    assert.deepEqual(one('Type "alice@example.com" into the Email field'), [[{ action: 'fill', target: 'Email', data: { value: 'alice@example.com' } }]]);
    assert.deepEqual(one('Fill in Amount with {{fake.amount}}'), [[{ action: 'fill', target: 'Amount', data: { value: '{{fake.amount}}' } }]]);
    assert.deepEqual(one('Select Italy from the Country dropdown'), [[{ action: 'select', target: 'Country', data: { value: 'Italy' } }]]);
    assert.deepEqual(one('Check the Accept terms checkbox'), [[{ action: 'check', target: 'Accept terms' }]]);
    assert.deepEqual(one('Untick Newsletter'), [[{ action: 'uncheck', target: 'Newsletter' }]]);
    assert.deepEqual(one('Click the Save button'), [[{ action: 'click', target: 'Save' }]]);
    assert.deepEqual(one('Press Enter'), [[{ action: 'press', data: { value: 'Enter' } }]]);
    assert.deepEqual(one('Wait 1.5 seconds'), [[{ action: 'wait', data: { ms: 1500 } }]]);
    assert.deepEqual(one('Wait for the results table to appear'), [[{ action: 'wait', target: 'results table' }]]);
    assert.deepEqual(one('Log in as the rep user'), [[{ action: 'salesforce_login', data: { persona: 'rep' } }]]);
  });

  it('understands checks', () => {
    assert.deepEqual(one('Verify the page title contains Checkout'), [[{ action: 'assert_title', data: { value: 'Checkout' } }]]);
    assert.deepEqual(one('Check that the URL contains /orders/'), [[{ action: 'assert_url', data: { value: '/orders/' } }]]);
    assert.deepEqual(one('Verify the "Order placed" message is visible'), [[{ action: 'assert_visible', target: 'text=Order placed' }]]);
    assert.deepEqual(one('Make sure the error banner is hidden'), [[{ action: 'assert_not_visible', target: 'error banner' }]]);
    assert.deepEqual(one('Expect the page shows "Thank you"'), [[{ action: 'assert_text', target: 'body', data: { value: 'Thank you' } }]]);
    assert.deepEqual(one('Check that the Status field says Closed Won'), [[{ action: 'assert_text', target: 'Status', data: { value: 'Closed Won' } }]]);
  });

  it('uses the library: elements by name, blocks with parameters', () => {
    assert.deepEqual(one('Click the Pay button'), [[{ action: 'click', target: '{{el.Checkout.PayButton}}' }]]);
    assert.deepEqual(one('Check that Total shows 42.00'), [[{ action: 'assert_text', target: '{{el.Cart.Total}}', data: { value: '42.00' } }]]);
    assert.deepEqual(one('Sign in with user alice'), [[{ action: 'use_block', target: 'Sign in', data: { params: { user: 'alice' } } }]]);
    assert.deepEqual(one('Sign in as admin'), [[{ action: 'salesforce_login', data: { persona: 'admin' } }]], '"as" means a persona, not the block');
    assert.deepEqual(one('Create opportunity with account=Acme, amount: 5000'), [[{ action: 'use_block', target: 'Create opportunity', data: { params: { account: 'Acme', amount: '5000' } } }]]);
    assert.deepEqual(one('Use block Create opportunity with account Acme and amount 5000'), [[{ action: 'use_block', target: 'Create opportunity', data: { params: { account: 'Acme', amount: '5000' } } }]]);
  });

  it('leaves the rest to the AI, and keeps only steps it can run', () => {
    assert.deepEqual(one('Open the cart page'), [null]);
    assert.deepEqual(one('Make the order cheaper'), [null]);
    const { system, user } = aiPrompt(['Open the cart page'], lib, 'a: [data-testid="cart"] Cart');
    assert.match(system, /one entry per input line/);
    assert.match(user, /1\. Open the cart page/);
    assert.match(user, /\{\{el\.Cart\.Total\}\} = #t/);
    assert.match(user, /Create opportunity\(account, amount\)/);
    assert.match(user, /Page outline[\s\S]*data-testid="cart"/);
    assert.deepEqual(cleanAiSteps([
      { action: 'click', target: ' #a ' }, { action: 'teleport' }, { action: 'use_block', target: 'Nope' },
      { action: 'use_block', target: 'sign in', data: { params: { user: 'x' } } }, 'junk',
    ], lib), [{ action: 'click', target: '#a' }, { action: 'use_block', target: 'sign in', data: { params: { user: 'x' } } }]);
  });

  it('without an AI provider, says how to rephrase what it did not understand', async () => {
    const r = await convertText('Click Save\nMake the order cheaper', lib);
    assert.equal(r.usedAi, false);
    assert.deepEqual(r.steps, [{ action: 'click', target: 'Save' }]);
    assert.match(r.lines[1].note!, /Not understood\. Rephrase it like “Click Save”/);
  });
});
