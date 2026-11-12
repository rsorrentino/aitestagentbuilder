/**
 * App discovery helpers: URL patterns, what is never followed, the accessibility tree, names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coveredPatterns, elementsOf, ident, pageName, parseAriaSnapshot, proposeSmokeTests, skipReason, urlPattern } from '../modules/discovery/discovery.js';

describe('app discovery', () => {
  it('groups pages of the same kind', () => {
    assert.equal(urlPattern('https://shop.test/orders/123/edit?x=1#a'), '/orders/:id/edit');
    assert.equal(urlPattern('https://shop.test/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '/users/:id');
    assert.equal(urlPattern('https://acme.lightning.force.com/lightning/r/Account/001xx000003DGb2AAG/view'), '/lightning/r/Account/:id/view');
    assert.equal(urlPattern('https://acme.lightning.force.com/lightning/o/Account/home'), '/lightning/o/Account/home');
    assert.equal(urlPattern('https://shop.test/blog/2026-launch'), '/blog/2026-launch', 'slugs stay');
    assert.equal(urlPattern('https://shop.test/'), '/');
  });

  it('never follows sign-out, destructive, external or file links', () => {
    const base = 'https://shop.test/';
    assert.equal(skipReason('/products', 'Products', base), null);
    assert.equal(skipReason('/logout', 'Sign out', base), 'sign-out or destructive');
    assert.equal(skipReason('/settings', 'Log out', base), 'sign-out or destructive');
    assert.equal(skipReason('/admin/delete-all', 'Admin', base), 'sign-out or destructive');
    assert.equal(skipReason('/account/unsubscribe', 'Preferences', base), 'sign-out or destructive');
    assert.equal(skipReason('https://other.test/', 'Partner', base), 'another site');
    assert.equal(skipReason('/files/terms.PDF', 'Terms', base), 'a file');
    assert.equal(skipReason('mailto:a@b.c', 'Mail', base), 'not a page');
    assert.equal(skipReason('/lightning/setup/SetupOneHome/home', 'Setup', 'https://acme.lightning.force.com/'), 'Salesforce Setup or sign-out');
    assert.equal(skipReason('/reports/2026', 'Reports', base, ['/reports/*']), 'excluded');
  });

  it('reads the accessibility tree', () => {
    const nodes = parseAriaSnapshot(`- heading "My account" [level=1]
- link "Settings":
  - /url: /account/settings
- textbox "Account Name"
- button "Say \\"hi\\""
- text: plain words
- combobox "Country":
  - option "Italy" [selected]`);
    assert.deepEqual(nodes, [
      { role: 'heading', name: 'My account', level: 1 }, { role: 'link', name: 'Settings', url: '/account/settings' },
      { role: 'textbox', name: 'Account Name' }, { role: 'button', name: 'Say "hi"' }, { role: 'combobox', name: 'Country' }, { role: 'option', name: 'Italy' },
    ]);
  });

  it('names screens and elements, preferring test ids', () => {
    assert.equal(ident('Account name *'), 'AccountName');
    assert.equal(ident('3D view'), 'X3DView');
    assert.equal(pageName('My account', 'x', '/account'), 'MyAccount');
    assert.equal(pageName(undefined, '', '/orders/:id'), 'Orders');
    const els = elementsOf([
      { role: 'heading', name: 'Cart', level: 1 }, { role: 'heading', name: 'Related', level: 2 }, { role: 'button', name: 'Checkout' },
      { role: 'button', name: 'Checkout' }, { role: 'link', name: 'Help' }, { role: 'textbox', name: 'Coupon' }, { role: 'button', name: 'Save button' },
    ], [{ testId: 'checkout', name: 'Checkout' }], 'Cart');
    assert.deepEqual(els.map((e) => [e.name, e.locator]), [
      ['Cart.CartTitle', 'role=heading[name="Cart"]'], ['Cart.CheckoutButton', '[data-testid="checkout"]'], ['Cart.HelpLink', 'role=link[name="Help"]'],
      ['Cart.CouponField', 'role=textbox[name="Coupon"]'], ['Cart.SaveButton', 'role=button[name="Save button"]'],
    ]);
    assert.deepEqual(els[1].alternatives, ['role=button[name="Checkout"]']);
  });

  it('knows which screens tests visit and proposes tests for the others', () => {
    const covered = coveredPatterns([
      { steps: [{ stepId: 1, action: 'navigate', target: '/orders/5' }] },
      { steps: [{ stepId: 1, action: 'click', target: 'x' }] },
      { steps: [{ stepId: 1, action: 'navigate', target: '/{{vars.x}}' }] },
    ], 'https://shop.test');
    assert.deepEqual([...covered].sort(), ['/', '/orders/:id']);
    const tests = proposeSmokeTests([
      { url: 'https://shop.test/cart', pattern: '/cart', title: 'Cart', heading: 'Your cart', name: 'YourCart', depth: 1, links: 0, covered: false,
        elements: [{ name: 'YourCart.YourCartTitle', role: 'heading', label: 'Your cart', locator: 'x' }, { name: 'YourCart.CouponField', role: 'textbox', label: 'Coupon', locator: 'y' }] },
      { url: 'https://shop.test/', pattern: '/', title: 'Home', name: 'Home', depth: 0, links: 0, covered: true, elements: [] },
    ], 'https://shop.test', 'alice');
    assert.deepEqual(tests, [{
      title: 'Your cart screen shows its main parts', module: 'YourCart', page: '/cart', source: 'rules', data: { login_as: 'alice' },
      elements: ['YourCart.YourCartTitle', 'YourCart.CouponField'],
      steps: [{ action: 'navigate', target: '/cart' }, { action: 'assert_visible', target: '{{el.YourCart.YourCartTitle}}' }, { action: 'assert_visible', target: '{{el.YourCart.CouponField}}' }],
    }]);
  });
});
