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

describe('GitHub', async () => {
  const crypto = await import('crypto');
  const YAML = (await import('yaml')).default;
  const { issueNumber, parseGitHubEvent, verifyGitHubSignature } = await import('../modules/integrations/github.js');
  const { githubActionsWorkflow, matchTriggers, validateTriggers } = await import('../modules/integrations/triggers.js');
  const { commitStatusOf, pullRequestComment } = await import('../modules/integrations/sync.js');

  it('checks webhook signatures in constant time', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    assert.equal(verifyGitHubSignature('s3cret', body, sig), true);
    assert.equal(verifyGitHubSignature('other', body, sig), false);
    assert.equal(verifyGitHubSignature('s3cret', Buffer.from('{"a":2}'), sig), false);
    assert.equal(verifyGitHubSignature('s3cret', body, undefined), false);
    assert.equal(verifyGitHubSignature('', body, sig), false);
    assert.equal(verifyGitHubSignature('s3cret', body, 'sha256=00'), false);
  });

  it('understands push, pull request and deployment webhooks', () => {
    const repository = { full_name: 'acme/shop' };
    assert.deepEqual(parseGitHubEvent('push', { ref: 'refs/heads/main', after: 'abc', repository, pusher: { name: 'dev' }, head_commit: { message: 'Fix\n\nbody' } }),
      { event: 'push', repository: 'acme/shop', sha: 'abc', ref: 'refs/heads/main', branch: 'main', actor: 'dev', title: 'Fix' });
    assert.equal(parseGitHubEvent('push', { ref: 'refs/heads/main', after: '0000000000', deleted: true, repository }), null, 'branch deleted');
    assert.equal(parseGitHubEvent('push', { ref: 'refs/tags/v1', after: 'abc', repository }), null, 'tags');
    const pr = parseGitHubEvent('pull_request', { action: 'synchronize', repository, pull_request: { number: 3, draft: true, head: { sha: 'h', ref: 'f' }, base: { ref: 'main' } } });
    assert.deepEqual([pr?.pr, pr?.sha, pr?.baseBranch, pr?.draft], [3, 'h', 'main', true]);
    assert.equal(parseGitHubEvent('pull_request', { action: 'labeled', repository, pull_request: {} }), null);
    assert.equal(parseGitHubEvent('deployment_status', { repository, deployment: {}, deployment_status: { state: 'failure' } }), null);
    assert.equal(parseGitHubEvent('deployment_status', { repository, deployment: { sha: 's', environment: 'preview' }, deployment_status: { state: 'success', target_url: 'https://p.example' } })?.deploymentUrl, 'https://p.example');
    assert.equal(parseGitHubEvent('issues', { repository }), null);
    assert.deepEqual(['#12', '12', 'acme/shop#12', 'https://github.com/acme/shop/issues/12'].map(issueNumber), [12, 12, 12, 12]);
    assert.throws(() => issueNumber('SHOP-1'), /not a GitHub issue number/);
  });

  it('matches triggers by event, branch globs and environments', () => {
    const triggers: any[] = [
      { event: 'push', agent_id: 'smoke', branches: ['main', 'release/*'] },
      { event: 'pull_request', agent_id: 'full', branches: ['main'] },
      { event: 'deployment_status', agent_id: 'full', environments: ['preview*', 'staging'], use_deployment_url: true },
      { event: 'deployment_status', agent_id: 'full', environments: ['staging'] },
    ];
    const push = (branch: string) => matchTriggers(triggers, { event: 'push', repository: 'r', sha: 's', branch });
    assert.deepEqual(push('main'), [{ agentId: 'smoke' }]);
    assert.deepEqual(push('release/2.1'), [{ agentId: 'smoke' }]);
    assert.deepEqual(push('feature/x'), []);
    assert.deepEqual(matchTriggers(triggers, { event: 'pull_request', repository: 'r', sha: 's', branch: 'f', baseBranch: 'main', pr: 1 }), [{ agentId: 'full' }]);
    assert.deepEqual(matchTriggers(triggers, { event: 'pull_request', repository: 'r', sha: 's', baseBranch: 'main', draft: true }), []);
    assert.deepEqual(matchTriggers(triggers, { event: 'deployment_status', repository: 'r', sha: 's', environment: 'Preview-12', deploymentUrl: 'https://pr-12.example' }), [{ agentId: 'full', baseUrl: 'https://pr-12.example' }]);
    assert.deepEqual(matchTriggers(triggers, { event: 'deployment_status', repository: 'r', sha: 's', environment: 'staging' }), [{ agentId: 'full' }], 'one run per agent');
    assert.deepEqual(validateTriggers([{ event: 'merge', agent_id: '' }, { event: 'push', agent_id: 'a', branches: 'main' }]), [
      'config.triggers[0].event must be one of push, pull_request, deployment_status', 'config.triggers[0].agent_id is required', 'config.triggers[1].branches must be a list of names',
    ]);
  });

  it('reports runs as commit statuses and pull request comments', () => {
    const base: any = { id: 'RUN-1', agentId: 'a', agentName: 'Shop', totalTests: 3, passedTests: 3, failedTests: 0, metadata: { git: { sha: 'abcdef123' } } };
    assert.deepEqual(commitStatusOf({ ...base, status: 'running' }), { state: 'pending', description: 'Running 3 tests…' });
    assert.deepEqual(commitStatusOf({ ...base, status: 'completed' }), { state: 'success', description: '3 of 3 passed' });
    assert.deepEqual(commitStatusOf({ ...base, status: 'failed', passedTests: 1, failedTests: 2 }), { state: 'failure', description: '2 of 3 failed' });
    assert.equal(commitStatusOf({ ...base, status: 'failed', passedTests: 0, metadata: { preflight: { ok: false } } }).state, 'error');
    assert.equal(commitStatusOf({ ...base, status: 'cancelled' }).state, 'error');
    const body = pullRequestComment({
      ...base, status: 'failed', passedTests: 2, failedTests: 1, duration: 61_000,
      metadata: { baseUrl: 'https://pr-1.example', git: { sha: 'abcdef123', environment: 'preview' }, triage: { groups: [{ category: 'app_bug', tests: [{}], seenBefore: false }] } },
      results: [
        { testCaseId: 't1', status: 'failed', startedAt: new Date(1), error: 'Step 2 (assert_text): Expected | pipe', metadata: { title: 'Cart' } },
        { testCaseId: 't1', status: 'passed', startedAt: new Date(0), metadata: { title: 'Cart' } },
        { testCaseId: 't2', status: 'failed', startedAt: new Date(1), error: 'flaky', metadata: { title: 'Flaky', quarantined: true } },
      ],
    });
    assert.match(body, /^### ❌ AI tests failed: Shop\n\*\*2 passed · 1 failed\*\* of 3 · 1 quarantined \(flaky\) failure not counted · 61 s · \[run RUN-1\]/);
    assert.match(body, /Tested `https:\/\/pr-1\.example` at abcdef1 \(preview\)\./);
    assert.match(body, /\| Cart \| Expected \\\| pipe \|/);
    assert.ok(!body.includes('Flaky'));
    assert.match(body, /\*\*Triage:\*\* 1 × application bug \(new\)/);
  });

  it('writes a valid GitHub Actions workflow', () => {
    const yaml = githubActionsWorkflow({ apiUrl: 'https://atab.example.com/api/v1/', projectId: 'default', agentId: 'agent-1', agentName: 'Shop', branch: 'develop' });
    const wf = YAML.parse(yaml);
    assert.deepEqual(Object.keys(wf.on), ['pull_request', 'push', 'workflow_dispatch']);
    assert.deepEqual(wf.on.push.branches, ['develop']);
    assert.equal(wf.jobs['ai-tests'].env.ATAB_URL, 'https://atab.example.com/api/v1');
    assert.equal(wf.jobs['ai-tests'].env.ATAB_AGENT, 'agent-1');
    assert.equal(wf.jobs['ai-tests'].steps[0].env.ATAB_API_KEY, '${{ secrets.ATAB_API_KEY }}');
    assert.match(wf.jobs['ai-tests'].steps[0].run, /test "\$status" = completed/);
  });
});

describe('GitLab and Azure DevOps', async () => {
  const { parseGitLabEvent, verifyGitLabToken } = await import('../modules/integrations/gitlab.js');
  const { htmlToText, parseAzureEvent, textToHtml, verifyAzureHook } = await import('../modules/integrations/azure-devops.js');
  const { CI_RUN_SCRIPT, gitlabCiJob, azurePipeline } = await import('../modules/integrations/triggers.js');
  const YAML = (await import('yaml')).default;

  it('understands GitLab push, merge request and deployment hooks', () => {
    const project = { id: 42, path_with_namespace: 'acme/shop' };
    assert.deepEqual(parseGitLabEvent('Push Hook', { project, ref: 'refs/heads/main', after: 'abc', user_username: 'dev', commits: [{ id: 'abc', title: 'Fix' }] }),
      { event: 'push', repository: 'acme/shop', repositoryId: '42', sha: 'abc', ref: 'refs/heads/main', branch: 'main', actor: 'dev', title: 'Fix' });
    assert.equal(parseGitLabEvent('Push Hook', { project, ref: 'refs/heads/x', after: '0000000000000000' }), null, 'branch deleted');
    const mr = (action: string, extra: any = {}) => parseGitLabEvent('Merge Request Hook', { project, object_attributes: { iid: 3, action, state: 'opened', source_branch: 'f', target_branch: 'main', last_commit: { id: 's' }, ...extra } });
    assert.deepEqual([mr('open')?.pr, mr('open')?.baseBranch, mr('open')?.event], [3, 'main', 'pull_request']);
    assert.equal(mr('update'), null, 'no new commits');
    assert.equal(mr('update', { oldrev: 'r' })?.sha, 's');
    assert.equal(mr('merge', { state: 'merged' }), null);
    assert.equal(mr('open', { draft: true })?.draft, true);
    assert.equal(parseGitLabEvent('Deployment Hook', { project, status: 'running', sha: 's' }), null);
    assert.equal(parseGitLabEvent('Deployment Hook', { project, status: 'success', sha: 's', environment: 'review/x', environment_external_url: 'https://x.review' })?.deploymentUrl, 'https://x.review');
    assert.equal(verifyGitLabToken('secret-1234567890', 'secret-1234567890'), true);
    assert.equal(verifyGitLabToken('secret-1234567890', 'secret-123456789'), false);
    assert.equal(verifyGitLabToken('secret-1234567890', undefined), false);
  });

  it('understands Azure DevOps service hooks', () => {
    const repository = { id: 'r1', name: 'shop-web' };
    const push = parseAzureEvent({ eventType: 'git.push', resource: { repository, refUpdates: [{ name: 'refs/heads/main', newObjectId: 'abc' }], pushedBy: { uniqueName: 'dev@acme' }, commits: [{ comment: 'Fix\nmore' }] } });
    assert.deepEqual(push, { event: 'push', repository: 'shop-web', repositoryId: 'r1', sha: 'abc', ref: 'refs/heads/main', branch: 'main', actor: 'dev@acme', title: 'Fix' });
    assert.equal(parseAzureEvent({ eventType: 'git.push', resource: { repository, refUpdates: [{ name: 'refs/heads/x', newObjectId: '0000000000' }] } }), null);
    const pr = { repository, pullRequestId: 5, status: 'active', sourceRefName: 'refs/heads/f', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: 's' } };
    assert.deepEqual([parseAzureEvent({ eventType: 'git.pullrequest.created', resource: pr })?.pr, parseAzureEvent({ eventType: 'git.pullrequest.created', resource: pr })?.baseBranch], [5, 'main']);
    assert.equal(parseAzureEvent({ eventType: 'git.pullrequest.updated', message: { text: 'Jamal approved pull request 5' }, resource: pr }), null);
    assert.equal(parseAzureEvent({ eventType: 'git.pullrequest.updated', message: { text: 'Jamal updated the source branch of pull request 5' }, resource: pr })?.sha, 's');
    assert.equal(parseAzureEvent({ eventType: 'git.pullrequest.created', resource: { ...pr, status: 'completed' } }), null);
    assert.equal(verifyAzureHook('secret-1234567890', { token: 'secret-1234567890' }), true);
    assert.equal(verifyAzureHook('secret-1234567890', { authorization: `Basic ${Buffer.from('any:secret-1234567890').toString('base64')}` }), true);
    assert.equal(verifyAzureHook('secret-1234567890', { authorization: `Basic ${Buffer.from('secret-1234567890:').toString('base64')}` }), false);
    assert.equal(verifyAzureHook('', { token: '' }), false);
  });

  it('converts text to work item HTML and back', () => {
    assert.equal(textToHtml('Run <1>: https://x.test/runs/1\nnext\n\nPara 2'), '<p>Run &lt;1&gt;: <a href="https://x.test/runs/1">https://x.test/runs/1</a><br>next</p><p>Para 2</p>');
    assert.equal(htmlToText('<div>As a <b>shopper</b>&nbsp;I pay</div><ul><li>total &amp; tax</li><li>42.00</li></ul>'), 'As a shopper I pay\n- total & tax\n- 42.00');
  });

  it('writes GitLab CI jobs and Azure pipelines with a POSIX script', () => {
    const o = { apiUrl: 'https://atab.example.com/api/v1', projectId: 'default', agentId: 'agent-1', agentName: 'Shop' };
    const job = YAML.parse(gitlabCiJob(o))['ai-tests'];
    assert.equal(job.image, 'alpine:3.20');
    assert.ok(job.script[0].includes(CI_RUN_SCRIPT));
    const pipeline = YAML.parse(azurePipeline({ ...o, branch: 'develop' }));
    assert.deepEqual(pipeline.pr.branches.include, ['develop']);
    assert.ok(pipeline.steps[1].bash.includes(CI_RUN_SCRIPT));
    assert.ok(!/\[\[|\$\{[A-Z_]+\[@\]\}|<<</.test(CI_RUN_SCRIPT), 'no bash-only syntax');
  });
});
