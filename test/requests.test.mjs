import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceDirectory } from './fixtures/source-directory.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';
import { itemBasis, itemCatalog, postAuditCause, pastExceedances, validateItemProposal } from '../src/controls.mjs';
import { buildRequestItems, composeReply, effectiveCatalog, mergedAnswers, recipientsOf, resendItems, resendText } from '../src/requests.mjs';

const data = await readW07Data(sourceDirectory);
const result = calculateW07(data);
const june = result.requests.find(row => row.period === '2026-06' && row.group.groupId === 'D-011');

test('item basis comes from code-computed facts and the catalog can be extended or disabled', () => {
  const basis = itemBasis(june);
  assert.deepEqual(Object.keys(basis).sort(), ['payee', 'relation', 'sameAddress', 'sameRep', 'sharedAccount']);
  assert.match(basis.sharedAccount, /6310/);
  const catalog = effectiveCatalog([
    { id: 'c1', kind: 'item', label: '공동 납품 계약 여부', format: 'yesno', status: 'active' },
    { id: 'relation', kind: 'item', label: itemCatalog.relation.label, status: 'disabled' },
  ]);
  assert.equal(catalog.items.c1.custom, true);
  const active = Object.fromEntries(Object.entries(catalog.items).filter(([, row]) => row.status === 'active'));
  const extended = itemBasis(june, active);
  assert.ok(extended.c1);
  assert.equal(extended.relation, undefined);
});

test('AI item proposals must stay inside the allowed list and quote the reason verbatim', () => {
  const reason = '공동 입금계좌 사용 경위와 실제 수취계좌가 확인되지 않음';
  const valid = validateItemProposal({ items: [{ id: 'payee', quote: '실제 수취계좌' }, { id: 'sharedAccount', quote: '지어낸 문장' }], newItem: '공동 납품 계약 여부' },
    ['payee', 'sharedAccount'], reason);
  assert.deepEqual(valid.items, [{ id: 'payee', quote: '실제 수취계좌' }, { id: 'sharedAccount', quote: null }]);
  assert.equal(valid.newItem, '공동 납품 계약 여부');
  assert.throws(() => validateItemProposal({ items: [{ id: 'other' }] }, ['payee'], reason));
});

test('requests go per item to the right agencies and resends narrow to what is missing', () => {
  const catalog = effectiveCatalog();
  const asked = buildRequestItems(['sharedAccount', 'payee', 'sameRep'], '공동 납품 계약 여부', catalog, june);
  assert.equal(asked.length, 4);
  assert.deepEqual(asked[1].recipients, ['D-011', 'D-024', 'D-037']);
  const send = { id: 1, action: 'send', metadata: { items: asked } };
  assert.deepEqual(recipientsOf([send], 'D-011'), ['D-011', 'D-024', 'D-037']);
  const form = new URLSearchParams({ ans_sharedAccount: '공동 납품 정산용', acc_payee: '국민 412-27-556311', holder_payee: '금강상사11' });
  const composed = composeReply(form, asked);
  assert.match(composed.text, /\[장려금 받을 계좌와 예금주\] 수취계좌 국민 412-27-556311 예금주 금강상사11/);
  const events = [send, { id: 2, action: 'reply', agency_id: 'D-011', reason: composed.text, metadata: { answers: composed.answers } },
    { id: 3, action: 'reply', agency_id: 'D-024', reason: '', metadata: { answers: { sharedAccount: { text: '잘못 입금' } } } }];
  const merged = mergedAnswers(events);
  assert.deepEqual(Object.keys(merged), ['D-011', 'D-024']);
  const narrowed = resendItems(asked, merged, [{ id: 'sharedAccount', verdict: 'met' }, { id: 'payee', verdict: 'partial' },
    { id: 'sameRep', verdict: 'missing' }, { id: 'custom1', verdict: 'missing' }]);
  assert.deepEqual(narrowed.map(row => row.id), ['payee', 'sameRep', 'custom1']);
  assert.deepEqual(narrowed[0].recipients, ['D-024', 'D-037']);
  assert.match(resendText(narrowed), /^D-024: 장려금 받을 계좌와 예금주/m);
  const legacy = recipientsOf([{ id: 9, action: 'send', agency_id: 'D-011' }], 'D-011');
  assert.deepEqual(legacy, ['D-011']);
});

test('past breach cause stays an estimate until the master at approval time is confirmed', () => {
  const [past] = pastExceedances(result, data, '2026-06');
  const estimate = postAuditCause(past, data);
  assert.equal(estimate.code, 'approval_unit_likely');
  assert.equal(estimate.confirmed, false);
  assert.match(estimate.text, /2020-07-05~2022-08-12/);
  assert.match(estimate.text, /원본에 없어 확인이 필요함/);
  assert.doesNotMatch(estimate.text, /판정이 가능했음/);
  assert.equal(postAuditCause(past, data, 'same').code, 'approval_unit');
  assert.equal(postAuditCause(past, data, 'different').code, 'data_change');
});

test('audit or recovery conclusions raise the next three months of team approvals to the executive', async () => {
  const { precheckGroups } = await import('../src/controls.mjs');
  const audits = [
    { group_id: 'D-011', period: '2026-06', metadata: { conclusion: 'audit_report' } },
    { group_id: 'D-031', period: '2026-06', metadata: { conclusion: 'closed' } },
  ];
  assert.deepEqual([...precheckGroups(audits, '2026-06')], []);
  for (const month of ['2026-07', '2026-08', '2026-09']) assert.deepEqual([...precheckGroups(audits, month)], ['D-011']);
  assert.deepEqual([...precheckGroups(audits, '2026-10')], []);
  const { approveSupportRequests } = await import('../src/bulk-approval.mjs');
  const request = { group: { groupId: 'D-011', members: [{ agencyId: 'D-011' }] }, approver: '영업임원', exceedsLimit: false };
  assert.equal(await approveSupportRequests({ role: '영업지원팀', ids: ['D-011'], requests: [request], savedIds: new Set(), affected: new Set(), approve: async () => {} }), 403);
});
