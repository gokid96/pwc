import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followupError, followupState, steps } from '../src/followup.mjs';

test('executive rejection supports an incomplete reply and a second request before resubmission', () => {
  for (const action of ['reject', 'clarify']) {
    const rejected = { action };
    let latest;
    assert.equal(followupState(rejected, latest, true), 'draft');
    assert.equal(followupState(rejected, latest, false), null);
    assert.equal(followupError('resubmit', 'draft', '영업지원팀', ''), 409);
    for (const step of ['send', 'reply', 'resend', 'reply', 'verify']) {
      const state = followupState(rejected, latest, true);
      assert.equal(followupError(step, state, '영업임원', '근거'), 403);
      assert.equal(followupError(step, state, '영업지원팀', ''), 400);
      assert.equal(followupError(step, state, '영업지원팀', '근거'), null);
      latest = step;
      assert.equal(followupState(rejected, latest, true), steps[step][1]);
    }
    assert.equal(followupError('resubmit', 'verified', '영업지원팀', ''), null);
    assert.equal(followupState(null, 'resubmit', true), 'resubmitted');
    assert.equal(followupState(rejected, 'resubmit', true), 'draft');
  }
});

test('accounting requires its own evidence after approval', () => {
  const approved = { action: 'approve', created_at: new Date() };
  assert.equal(followupState(approved, 'resubmit', true), 'paymentPending');
  assert.equal(followupError('payment', 'paymentPending', '영업지원팀', '근거'), 403);
  assert.equal(followupError('payment', 'paymentPending', '회계', ''), 400);
  assert.equal(followupError('payment', 'paymentPending', '회계', '모의 확인 근거'), null);
  assert.equal(followupState(approved, 'payment', true), 'paymentReady');
  assert.equal(followupError('payment', 'paymentReady', '회계', '중복'), 409);
});
