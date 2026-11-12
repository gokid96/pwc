import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followupError, followupState, requestProgress, steps } from '../src/followup.mjs';

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
      const owner = step === 'reply' ? '대리점' : '영업지원팀';
      if (step === 'reply') assert.equal(followupError(step, state, '영업지원팀', '근거'), 403);
      assert.equal(followupError(step, state, owner, ''), 400);
      assert.equal(followupError(step, state, owner, '근거'), null);
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

test('account change continues the existing clarification and ignores document audit events', () => {
  const date = new Date('2026-06-01');
  const record = { action: 'reject', acted_at: date };
  const review = { id: '7' };
  const events = [
    { action: 'send', acted_at: date },
    { action: 'document_received', acted_at: date },
    { action: 'account_changed', acted_at: date },
  ];
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'waiting', held: true });
  events.push({ action: 'reply', review_id: '7', acted_at: date });
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'received', held: true });
});

test('a new change requires executive approval and fresh accounting evidence', () => {
  const date = new Date('2026-06-01');
  const record = { action: 'approve', created_at: date, acted_at: date };
  const events = [{ action: 'payment', acted_at: date }];
  const review = { id: '7' };
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'draft', held: true });
  events.push({ action: 'resubmit', review_id: '7', acted_at: date });
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'resubmitted', held: true });
  events.push({ action: 'review_approve', review_id: '7', acted_at: date });
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'paymentPending', held: false });
  events.push({ action: 'payment', review_id: '7', acted_at: date });
  assert.deepEqual(requestProgress(record, events, true, review), { state: 'paymentReady', held: false });
  assert.deepEqual(requestProgress(record, events, true, { id: '8' }), { state: 'draft', held: true });
});
