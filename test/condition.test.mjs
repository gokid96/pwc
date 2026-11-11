import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyChanges, callAssistant, individualExceedance, reviewScope, samples } from '../src/condition.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';

test('AI candidates require source text and flag omitted or conflicting values', async () => {
  const output = await callAssistant('extract', { text: samples.mixed[1] }, {
    run: async () => ({
      representative_name: ['모의 김대표'], address: ['없는 값'],
      bank_account_no: ['모의은행 999-000-1100', '모의은행 999-000-1101'],
    }),
  });
  assert.equal(output.result.representative_name.needsReview, false);
  assert.equal(output.result.address.needsReview, true);
  assert.equal(output.result.bank_account_no.needsReview, true);
  assert.deepEqual(output.result.bank_account_no.candidates.map(value => value.lines), [[2], [3]]);
  const failed = await callAssistant('extract', { text: samples.change[1] }, {
    run: async () => { throw new Error('timeout'); },
  });
  assert.equal(failed.result, null);
  assert.match(failed.request.input, /D-011/);
  const draft = await callAssistant('draft', { reason: '모의 거절' }, {
    run: async () => ({ evidence: ['사용 근거'], draft: '확인 자료를 보내 주세요.' }),
  });
  assert.deepEqual(draft.result.evidence, ['사용 근거']);
});

test('June account change preserves original data and finds earlier paid approvals', async () => {
  const data = await readW07Data(fileURLToPath(new URL('../01_참가자_배포용/04_원본데이터/', import.meta.url)));
  const before = calculateW07(data);
  const updated = applyChanges(data, [{
    kind: 'change', agency_id: 'D-011', details: { afterAccount: '모의은행 999-000-1101' },
  }]);
  assert.notEqual(data.agencies.find(row => row.agency_id === 'D-011').bank_account_no, '모의은행 999-000-1101');
  const scope = reviewScope(data, '2026-06', before, calculateW07(updated), 'D-011');
  assert.deepEqual(scope.after.map(row => [row.amount, row.approver]),
    [[2_562_561, '영업임원'], [1_325_536, '영업지원팀']]);
  assert.equal(scope.retained.length, 4);
  assert.equal(scope.history.length, 15);
  assert.ok(scope.history.every(row => row.paid && row.source.row > 1));
  assert.equal(individualExceedance(data.rebates, '2026-06'), 0);
  assert.equal(before.requests.filter(row => row.period === '2026-06' && row.exceedsLimit).length, 1);
});
