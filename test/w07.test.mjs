import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceDirectory } from './fixtures/source-directory.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';

test('groups transitively, excludes one-field matches and keeps deposit evidence separate', () => {
  const source = row => ({ file: 'fixture.csv', row });
  const agency = (agency_id, representative_name, address, bank_account_no, row) =>
    ({ agency_id, representative_name, address, bank_account_no, source: source(row) });
  const rebate = (agency_id, period_ym, rebate_amount_krw, row) =>
    ({ agency_id, period_ym, rebate_amount_krw, source: source(row) });

  const result = calculateW07({
    agencies: [
      agency('A', 'R', 'X', '1', 2), agency('B', 'R', 'X', '2', 3),
      agency('C', 'R', 'Y', '1', 4), agency('D', 'R', 'Z', '3', 5),
    ],
    rebates: [
      rebate('A', '2026-06', '1000000', 6), rebate('C', '2026-06', '1000000', 7),
      rebate('D', '2026-06', '2000001', 8), rebate('A', '2026-05', '1', 9),
    ],
    collections: [
      { agency_id: 'C', bank_account_no: '3', source: source(10) },
      { agency_id: 'D', bank_account_no: '3', source: source(11) },
    ],
  });
  assert.deepEqual(result.groups.map(group => group.members.map(member => member.agencyId)),
    [['A', 'B', 'C'], ['D']]);
  assert.deepEqual(result.groups[0].links.map(link => link.matchedFields),
    [['representative_name', 'address'], ['representative_name', 'bank_account_no']]);
  assert.deepEqual(result.groups[0].links[1].sources, [source(2), source(4)]);
  assert.deepEqual(result.requests.map(request => [request.totalKrw, request.exceedsLimit]),
    [[2_000_000, false], [2_000_001, true], [1, false]]);
  assert.deepEqual(result.requests[0].rebateRows.map(row => row.source), [source(6), source(7)]);
  assert.equal(result.collectionEvidence[0].sharedDeposits, true);
  assert.equal(result.collectionEvidence[0].crossAgencyRegistration, true);
  assert.equal(result.requests[0].collectionEvidence[0].deposits[0].source.row, 10);
});

test('June original records produce the documented approval split', async () => {
  const directory = sourceDirectory;
  const result = calculateW07(await readW07Data(directory));
  const june = result.requests.filter(request => request.period === '2026-06');
  const support = june.filter(request => !request.exceedsLimit);
  const executives = june.filter(request => request.exceedsLimit);
  assert.equal(support.length, 37);
  assert.equal(executives.length, 1);
  assert.equal(june.flatMap(request => request.rebateRows).length, 40);
  assert.equal(june.filter(request => request.group.members.length > 1).length, 1);
  const [executive] = executives;
  assert.equal(executive.approver, '영업임원');
  assert.equal(executive.totalKrw, 3_888_097);
  assert.deepEqual(executive.group.members.map(member => member.agencyId), ['D-011', 'D-024', 'D-037']);
  const evidence = executive.collectionEvidence.find(item =>
    item.deposits.some(deposit => deposit.depositId === 'DP-00013'));
  assert.deepEqual(evidence.registered.map(row => row.agencyId), ['D-011', 'D-037']);
  assert.equal(evidence.deposits.length, 4);
});
