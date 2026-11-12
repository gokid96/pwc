import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputMetadata, validDate, paymentEvidence, metadataView } from '../src/audit.mjs';
test('business dates are explicit, valid and bound to the selected settlement month', () => {
  const form = new URLSearchParams({ occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' });
  assert.equal(inputMetadata(form, '2026-06').source, 'scenario');
  assert.equal(inputMetadata(form, '2026-05'), null);
  assert.equal(validDate('2026-02-30'), false);
  form.delete('occurredOn');
  assert.equal(inputMetadata(form, '2026-06'), null);
  assert.match(metadataView(null, String), /미기록/);
});
test('accounting evidence requires a reference and a finding, not only a generic reason', () => {
  assert.equal(paymentEvidence(new URLSearchParams({ reason: '1' })), null);
  assert.deepEqual(paymentEvidence(new URLSearchParams({ evidenceReference: '접수 7 · 통장 확인 내용', evidenceFinding: '수취계좌와 명의 확인' })),
    { reference: '접수 7 · 통장 확인 내용', finding: '수취계좌와 명의 확인' });
});
