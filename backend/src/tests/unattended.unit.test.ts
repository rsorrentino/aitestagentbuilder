/**
 * Unattended runs and the daily digest (no database).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describePreflight, isUnattended, unattendedSettings, validateUnattended } from '../modules/automation/unattended.js';
import { digestDue, digestMessage } from '../modules/automation/digest.js';

describe('unattended runs', () => {
  it('re-runs failures by default only when nobody watches the run', () => {
    assert.equal(isUnattended('schedule'), true);
    assert.equal(isUnattended('api'), true);
    assert.equal(isUnattended('user'), false);
    assert.equal(unattendedSettings({}, 'schedule').rerunFailed, true);
    assert.equal(unattendedSettings({}, 'user').rerunFailed, false);
    assert.equal(unattendedSettings({ unattended: { rerun_failed: true } }, 'user').rerunFailed, true);
    assert.equal(unattendedSettings({ unattended: { rerun_failed: false } }, 'schedule').rerunFailed, false);
    assert.deepEqual(unattendedSettings({}, 'schedule'), { preflight: true, retries: 3, waitMs: 300_000, rerunFailed: true, maxRunMinutes: 240, resumeInterrupted: true });
    assert.equal(unattendedSettings({ unattended: { preflight_retries: 99 } }).retries, 20, 'bounded');
    assert.deepEqual(validateUnattended({ rerun_failed: 'sometimes', max_run_minutes: 'x' }), ['config.unattended.max_run_minutes must be a number', 'config.unattended.rerun_failed must be true, false or "auto"']);
  });

  it('describes pre-flight results', () => {
    const failed = { ok: false, attempts: 4, at: '', checks: [{ name: 'application', ok: false, blocking: true, detail: 'https://app: no answer (ECONNREFUSED)' }, { name: 'ai provider', ok: false, blocking: false, detail: 'none' }] };
    assert.equal(describePreflight(failed), 'Pre-flight failed after 4 attempt(s): application — https://app: no answer (ECONNREFUSED). No tests were run');
    assert.match(describePreflight({ ...failed, ok: true, checks: [{ name: 'application', ok: true, blocking: true, detail: 'HTTP 200' }] }), /Pre-flight passed: application ok/);
  });
});

describe('daily digest', () => {
  it('is due once a day after its time, in its time zone', () => {
    const cfg = { digest_time: '07:30', digest_timezone: 'Europe/Rome' };
    // 06:00 UTC = 07:00 in Rome (winter): not yet
    assert.equal(digestDue(new Date('2026-01-15T06:00:00Z'), cfg, null), false);
    // 06:31 UTC = 07:31 in Rome: due
    assert.equal(digestDue(new Date('2026-01-15T06:31:00Z'), cfg, null), true);
    // Already sent at 07:31 Rome time today: not again
    assert.equal(digestDue(new Date('2026-01-15T09:00:00Z'), cfg, new Date('2026-01-15T06:31:00Z')), false);
    // Sent yesterday: due again today
    assert.equal(digestDue(new Date('2026-01-16T06:35:00Z'), cfg, new Date('2026-01-15T06:31:00Z')), true);
    // Default 07:00 UTC
    assert.equal(digestDue(new Date('2026-01-15T07:05:00Z'), {}, null), true);
  });

  it('summarises agents, new and known failures, flaky re-runs and sign-in problems', () => {
    const m = digestMessage({
      projectId: 'P', projectName: 'Shop', since: '',
      agents: [
        { agentId: 'A1', agentName: 'Checkout', runs: 2, failedRuns: 1, lastStatus: 'failed', lastRunId: 'R1', passed: 8, failed: 2, passedOnRerun: 1, preflightFailures: 0,
          failures: [{ title: 'Pay by card', error: 'Expected text…', known: false }, { title: 'Coupon', known: true }] },
        { agentId: 'A2', agentName: 'Search', runs: 1, failedRuns: 0, lastStatus: 'completed', lastRunId: 'R2', passed: 5, failed: 0, passedOnRerun: 0, preflightFailures: 0, failures: [] },
      ],
      signInAttention: 1,
    }, 'https://qa.example.com');
    assert.equal(m.headline, '🌅 Shop: 1 of 2 agent(s) failing');
    assert.deepEqual(m.lines.map((l) => l.title), [
      '❌ Checkout: 8 passed, 2 failed (2 runs, 1 passed only when re-run)',
      '   🆕 new: Pay by card',
      '   ↺ still failing: Coupon',
      '✅ Search: 5 passed, 0 failed',
      '🔐 1 test user(s) may need a person to sign in (see the dashboard)',
    ]);
    assert.equal(m.lines[0].error, 'https://qa.example.com/runs/R1');
  });
});
