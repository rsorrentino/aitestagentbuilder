/**
 * Integrations (no database, no network): Jira document format, bug policy and
 * text, config validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, textToAdf } from '../modules/integrations/jira.js';
import { defectPolicy } from '../modules/integrations/types.js';
import { validateIntegration } from '../modules/integrations/validate.js';
import { defectText, signatureLabel } from '../modules/integrations/sync.js';

describe('integrations', () => {
  it('converts text to Atlassian Document Format and back', () => {
    const doc = textToAdf('First line\nsecond line with https://x.test/runs/1\n\nNext paragraph');
    assert.equal(doc.type, 'doc');
    assert.equal(doc.content.length, 2);
    assert.deepEqual(doc.content[0].content.map((n: any) => n.type), ['text', 'hardBreak', 'text', 'text']);
    assert.deepEqual(doc.content[0].content[3].marks, [{ type: 'link', attrs: { href: 'https://x.test/runs/1' } }]);
    assert.equal(adfToText(doc).trim(), 'First line\nsecond line with https://x.test/runs/1\n\nNext paragraph');
    const story = { type: 'doc', content: [
      { type: 'heading', content: [{ type: 'text', text: 'Acceptance criteria' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'total is 42.00' }] }] }] },
    ] };
    assert.match(adfToText(story), /Acceptance criteria\n\n- total is 42\.00/);
    assert.deepEqual(textToAdf('').content, [{ type: 'paragraph', content: [] }]);
  });

  it('files only application bugs of unattended runs by default', () => {
    assert.deepEqual(defectPolicy({}), { enabled: false, categories: ['app_bug'], onlyUnattended: true, agents: [], labels: ['atab'] });
    assert.deepEqual(defectPolicy({ defects: { enabled: true, categories: ['app_bug', 'environment'], only_unattended: false, resolve_transition: ' Done ' } }),
      { enabled: true, categories: ['app_bug', 'environment'], onlyUnattended: false, agents: [], resolveTransition: 'Done', labels: ['atab'] });
  });

  it('validates Jira settings with readable messages', () => {
    assert.deepEqual(validateIntegration('jira', { base_url: 'https://acme.atlassian.net', email: 'a@b.c', api_token: 't', project_key: 'SHOP' }, false), []);
    assert.deepEqual(validateIntegration('jira', { base_url: 'https://jira.acme.local', api_token: 't' }, false), [], 'Data Center needs no email');
    const errors = validateIntegration('jira', { base_url: 'acme', api_token: '••••••••', project_key: 'shop', defects: { enabled: true, categories: ['bug'] } }, false);
    assert.equal(errors.length, 4, errors.join('\n'));
    assert.match(errors.join('\n'), /base_url.*\n.*api_token.*\n.*project_key must be.*\n.*categories/s);
    assert.deepEqual(validateIntegration('jira', { base_url: 'https://acme.atlassian.net', email: 'a@b.c', api_token: '••••••••' }, true), [], 'kept secret on update');
    assert.match(validateIntegration('jira', { base_url: 'https://acme.atlassian.net', email: 'a@b.c', api_token: 't', defects: { enabled: true } }, false).join(), /project_key is required to file bugs/);
    assert.match(validateIntegration('github', { repository: 'acme', token: 'x' }, false).join(), /owner\/name/);
  });

  it('writes the bug from the failure group', () => {
    const { title, body } = defectText({ id: 'RUN-1', agentId: 'a1', agentName: 'Shop' }, {
      category: 'app_bug', reason: 'The application did not show what the test expects', cause: 'Price formatting returns NaN',
      sample: { action: 'assert_text', target: '#total', error: 'Step 2 (assert_text): Expected #total to contain "42.00" but found "NaN"' },
      tests: [{ title: 'Cart total' }, { title: 'Order summary', persona: 'rep' }],
    });
    assert.equal(title, '[Automated test] Shop: Expected #total to contain "42.00" but found "NaN"');
    assert.match(body, /run RUN-1: http:\/\/localhost:4000\/runs\/RUN-1/);
    assert.match(body, /Failed step: assert_text → #total\nError: Expected #total/);
    assert.match(body, /- Cart total\n- Order summary \(as rep\)/);
    assert.match(body, /Likely cause \(AI\): Price formatting returns NaN/);
    assert.match(signatureLabel('a1', 'sig'), /^atab-[0-9a-f]{10}$/);
    assert.notEqual(signatureLabel('a1', 'sig'), signatureLabel('a2', 'sig'));
  });
});
