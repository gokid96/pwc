import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputMetadata, validDate, paymentEvidence, metadataView, metadataFields, newestFirstEvents } from '../src/audit.mjs';
test('business dates are explicit, valid and bound to the selected settlement month', () => {
  const form = new URLSearchParams({ occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' });
  assert.equal(inputMetadata(form, '2026-06').source, 'scenario');
  assert.equal(inputMetadata(form, '2026-05'), null);
  assert.equal(validDate('2026-02-30'), false);
  form.delete('occurredOn');
  assert.equal(inputMetadata(form, '2026-06'), null);
  assert.match(metadataView(null, String), /미기록/);
});

test('one entered date supplies the effective date by default; previous dates never fill a new event', () => {
  const form = new URLSearchParams({ occurredOn: '2026-07-02', sameEffectiveDate: 'yes', effectivePeriod: '2026-06' });
  assert.equal(inputMetadata(form, '2026-06').effectiveOn, '2026-07-02');
  form.delete('occurredOn');
  assert.equal(inputMetadata(form, '2026-06'), null);
  const previous = { occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' };
  const html = metadataFields('2026-06', String, previous);
  assert.match(html, /name="occurredOn" value="" required/);
  assert.match(html, /name="effectiveOn" value="" disabled/);
  assert.match(html, /value="scenario" selected/);
  assert.doesNotMatch(metadataFields('2026-05', String, previous), /2026-07-01"/);
  assert.match(metadataFields('2026-06', String, previous, { reuseOccurred: true }), /name="occurredOn" value="2026-07-01"/);
});

test('display history is newest first with date objects or strings and does not mutate state event order', () => {
  const events = [
    { action: 'send', acted_at: new Date('2026-07-01') },
    { action: 'reply', acted_at: '2026-07-03T00:00:00Z' },
    { action: 'resend', acted_at: '2026-07-02T00:00:00Z' },
  ];
  assert.deepEqual(newestFirstEvents(events).map(row => row.action), ['reply', 'resend', 'send']);
  assert.deepEqual(events.map(row => row.action), ['send', 'reply', 'resend']);
});
test('accounting evidence requires a reference and a finding, not only a generic reason', () => {
  assert.equal(paymentEvidence(new URLSearchParams({ reason: '1' })), null);
  assert.deepEqual(paymentEvidence(new URLSearchParams({ evidenceReference: '접수 7 · 통장 확인 내용', evidenceFinding: '수취계좌와 명의 확인' })),
    { reference: '접수 7 · 통장 확인 내용', finding: '수취계좌와 명의 확인' });
});
