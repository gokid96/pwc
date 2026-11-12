import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyChanges, callAssistant, documentSamples, individualExceedance, isOpenPeriod, reviewScope, samples } from '../src/condition.mjs';
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
  assert.match(failed.request.contents[0].parts[0].text, /D-011/);
  const draft = await callAssistant('draft', { reason: '거절 D-011 D-037', recipient: {
    sharedDeposit: true, registrationDiffers: true,
  } }, {
    run: async () => ({ evidence: ['통장 사본', '공동 계좌 사용 경위서'] }),
  });
  assert.deepEqual(draft.result.evidence, ['통장 사본', '공동 계좌 사용 경위서']);
  assert.match(draft.result.draft, /귀 거래처의 입금 기록에 등록 정산계좌와 다른 계좌/);
  assert.doesNotMatch(draft.result.draft, /D-011|D-037|동일한 정산계좌/);
});

test('June account change preserves original data and finds earlier paid approvals', async () => {
  const data = await readW07Data(fileURLToPath(new URL('../01_참가자_배포용/04_원본데이터/', import.meta.url)));
  const before = calculateW07(data);
  assert.equal(isOpenPeriod(data.rebates, '2026-06'), true);
  for (const month of ['01', '02', '03', '04', '05']) {
    assert.equal(isOpenPeriod(data.rebates, '2026-' + month), false);
  }
  const agency = data.agencies.find(row => row.agency_id === 'D-011');
  const sample = documentSamples(data).change[1];
  assert.ok(sample.includes(agency.representative_name) && sample.includes(agency.address));
  assert.doesNotMatch(sample, /모의/);
  const newAccount = sample.split('신규 정산계좌: ')[1].replace(/\D/g, '');
  assert.ok([...data.agencies, ...data.collections].every(row => row.bank_account_no.replace(/\D/g, '') !== newAccount));
  const generated = documentSamples(data);
  assert.ok(generated.mixed[1].includes('기존 정산계좌: ' + agency.bank_account_no));
  assert.equal(sample.split('신규 정산계좌: ')[1].replace(/\d/g, '#'), agency.bank_account_no.replace(/\d/g, '#'));
  assert.equal(generated.explanation[1].split('\n').length, 3);
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

test('approval summary accepts only checks supported by the computed evidence', async () => {
  const input = { agencies: ['D-011'], options: ['승인', '거절', '추가 확인 요청'], allowedChecks: ['registration'] };
  const valid = await callAssistant('summary', input, { run: async () => ({ check: 'registration' }) });
  assert.deepEqual(valid.result, { check: 'registration' });
  const invalid = await callAssistant('summary', input, { run: async () => ({ check: 'sharedDeposit' }) });
  assert.equal(invalid.result, null);
  assert.match(invalid.raw.error, /연결할 수 없는 확인 항목/);
});
