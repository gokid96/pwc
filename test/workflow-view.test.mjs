import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createWorkflow } from '../src/workflow.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';
const data = await readW07Data(fileURLToPath(new URL('../01_참가자_배포용/04_원본데이터/', import.meta.url)));
async function render({ url, role = 1, rows = [], events = [], documents = [], calls = [], reviews = [], body }) {
  const db = { release() {}, async query(sql) {
    const items = /^SELECT/.test(sql) ? sql.includes('w07_review') ? reviews : sql.includes('w07_decision') ? rows :
      sql.includes('w07_event') ? events : sql.includes('w07_document') ? documents : sql.includes('w07_ai_call') ? calls : [] : [];
    return { rows: items, rowCount: items.length };
  } };
  const workflow = createWorkflow({ connect: async () => db, query: db.query }, async () => data, calculateW07,
    async () => { throw Error('AI must not run in view tests'); });
  let html, status;
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, { url, method: body ? 'POST' : 'GET', headers: { cookie: 'w07_role=' + role + '; w07_dealer=D-011' } });
  await workflow(request, { writeHead(code) { status = code; return this; }, end(text) { html = text; } });
  return { html, status };
}
const decision = { group_id: 'D-011', role: '영업임원', action: 'approve', reason: '', acted_at: new Date('2026-07-01'), created_at: new Date('2026-07-01') };
test('executive empty list distinguishes total scope from actionable work', async () => {
  const { html } = await render({ url: '/?view=requests&period=2026-06', rows: [decision] });
  assert.match(html, /이번 달 임원 대상 전체/);
  assert.match(html, /지금 결정할 요청 0건/);
  assert.match(html, /현재 결정할 요청이 없습니다/);
});
test('executive chooses among evidence-based conditions while the AI proposal runs', async () => {
  const pending = await render({ url: '/?view=requests&period=2026-06&group=D-011', calls: [
    { kind: 'conditions', group_id: 'D-011', created_at: new Date('2026-07-01'), finished_at: null, result: null },
  ] });
  assert.match(pending.html, /제안 중/);
  assert.equal((pending.html.match(/name="condition"/g) ?? []).length, 4);
  assert.match(pending.html, /DP-00013·DP-00014/);
  assert.doesNotMatch(pending.html, /<form hidden method="post" data-ai="conditions"/);
  const fresh = await render({ url: '/?view=requests&period=2026-06&group=D-011' });
  assert.match(fresh.html, /<form hidden method="post" data-ai="conditions"/);
  assert.doesNotMatch(fresh.html, /AI 검토 참고/);
});

test('support reviews a reply with grounded AI verdicts and a prefilled resend draft', async () => {
  const metadata = { occurredOn: '2026-07-02', effectiveOn: '2026-07-02', effectivePeriod: '2026-06', source: 'manual' };
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', role: 0,
    rows: [{ ...decision, action: 'reject', created_at: null, reason: '수취 명의 확인 필요' }], events: [
      { id: 1, group_id: 'D-011', role: '영업지원팀', action: 'send', reason: '경위와 수취계좌', acted_at: new Date('2026-07-02'), metadata },
      { id: 2, group_id: 'D-011', role: '대리점', action: 'reply', reason: '같은 계좌를 사용했습니다.', acted_at: new Date('2026-07-03'), metadata },
    ], calls: [{ kind: 'reply_check', group_id: 'D-011', created_at: new Date('2026-07-03'), finished_at: new Date('2026-07-03'), result: {
      replyId: '2', recommendation: 'resend', draft: '보완 초안 문장', items: [
        { id: 'history', label: '공동 입금계좌·등록정보 공유 경위', verdict: 'unclear', quote: '같은 계좌를 사용했습니다.' },
        { id: 'payee', label: '거래처별 지급 수취계좌·예금주 명의', verdict: 'missing', quote: null, note: '' },
        { id: 'evidence', label: '요청한 증빙 제출 또는 제출 위치', verdict: 'missing', quote: null, note: '' },
      ] } }] });
  assert.match(html, /AI 답변 판정/);
  assert.match(html, /verdict-unclear/);
  assert.match(html, /“같은 계좌를 사용했습니다.”/);
  assert.match(html, /AI 의견 <strong>보완 요청<\/strong>/);
  assert.match(html, /<textarea name="reason" maxlength="1000" required>보완 초안 문장<\/textarea>/);
  assert.doesNotMatch(html, /<form hidden method="post" data-ai="reply"/);
  assert.doesNotMatch(html, /AI 요청서 초안 제안/);
});

test('accounting must confirm every approval condition before payment evidence', async () => {
  const conditional = { ...decision, conditions: ['payeeProof'] };
  const { html } = await render({ url: '/?view=accounting&period=2026-06&group=D-011', role: 2, rows: [conditional] });
  assert.match(html, /임원 승인 조건 · 0\/1 확인/);
  assert.match(html, /value="condition_check"/);
  assert.match(html, /남은 승인 조건 1개를 확인하면/);
  assert.doesNotMatch(html, /value="payment"/);
  const blocked = await render({ url: '/?view=accounting&period=2026-06&group=D-011', role: 2, rows: [conditional],
    body: new URLSearchParams({ action: 'payment', revision: '0', occurredOn: '2026-07-05', sameEffectiveDate: 'yes', effectivePeriod: '2026-06',
      evidenceReference: '확인서', evidenceFinding: '확인 내용' }).toString() });
  assert.equal(blocked.status, 409);
  const confirmed = await render({ url: '/?view=accounting&period=2026-06&group=D-011', role: 2, rows: [conditional], events: [
    { id: 3, group_id: 'D-011', role: '회계', action: 'condition_check', reason: '명의 확인', acted_at: new Date('2026-07-05'),
      metadata: { condition: 'payeeProof', evidence: { reference: '통장 사본 A-03', finding: '명의 확인' } } },
  ] });
  assert.match(confirmed.html, /임원 승인 조건 · 1\/1 확인/);
  assert.match(confirmed.html, /value="payment"/);
});

test('past limit breaches are listed for post-review and the dealer sees what to answer', async () => {
  const support = await render({ url: '/?view=requests&period=2026-06', role: 0 });
  assert.match(support.html, /과거 권한 초과 지급/);
  assert.match(support.html, /15건 · 22,238,349원/);
  assert.match(support.html, /value="post_audit"/);
  const accounting = await render({ url: '/?view=accounting&period=2026-06', role: 2, events: [
    { id: 9, group_id: 'D-011', role: '영업지원팀', action: 'post_audit', reason: '요청', acted_at: new Date('2026-07-01') },
  ] });
  assert.match(accounting.html, /회계·감사 확인 대기/);
  assert.match(accounting.html, /value="post_audit_done"/);
  const dealer = await render({ url: '/?view=agency-replies&period=2026-06&group=D-011', role: 3, events: [
    { id: 4, group_id: 'D-011', role: '영업지원팀', action: 'resend', reason: '보완 요청', agency_id: 'D-011', acted_at: new Date('2026-07-04'),
      metadata: { ai: { recommendation: 'resend', agreed: true, unmet: [{ label: '거래처별 지급 수취계좌·예금주 명의', verdict: 'unclear' }] } } },
  ], rows: [{ ...decision, action: 'reject', created_at: null, reason: '확인 필요' }] });
  assert.match(dealer.html, /답변에 포함할 확인 항목/);
  assert.match(dealer.html, /지난 답변에서 확인되지 않은 항목/);
  assert.match(dealer.html, /거래처별 지급 수취계좌·예금주 명의 · 불명확/);
});
test('support sees current review before evidence, receives prior context and enters only a new occurrence date', async () => {
  const metadata = { occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' };
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', role: 0,
    rows: [{ ...decision, action: 'reject', created_at: null, reason: '수취 명의 확인 필요' }], events: [
      { id: 1, group_id: 'D-011', role: '영업지원팀', action: 'send', reason: '기존 요청문', acted_at: new Date('2026-07-02'), metadata },
      { id: 2, group_id: 'D-011', role: '대리점', action: 'reply', reason: '받은 회신 내용', acted_at: new Date('2026-07-03'), metadata },
    ] });
  assert.ok(html.indexOf('id="followup"') < html.indexOf('<h3>판단 근거'));
  assert.match(html, /name="occurredOn" value="" required/);
  assert.match(html, /name="effectiveOn" value="" disabled/);
  assert.match(html, /<details><summary>보낸 요청서/);
  const history = html.slice(html.indexOf('id="history"'));
  assert.match(history, /내림차순 · 최신 기록부터/);
  assert.ok(history.indexOf('받은 회신 내용') < history.indexOf('기존 요청문'));
});

test('same-date option does not allow accounting to bypass mandatory evidence', async () => {
  const result = await render({ url: '/?view=accounting&period=2026-06&group=D-011', role: 2, rows: [decision],
    body: new URLSearchParams({ action: 'payment', occurredOn: '2026-07-01', sameEffectiveDate: 'yes', effectivePeriod: '2026-06' }).toString() });
  assert.equal(result.status, 400);
});
test('resubmitted requests point back to executive decision and keep decision actions', async () => {
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', events: [
    { id: 7, group_id: 'D-011', action: 'resubmit', role: '영업지원팀', reason: '', acted_at: new Date('2026-07-01') },
  ] });
  assert.match(html, /현재 단계 · 재상신 · 임원 재결정/);
  assert.match(html, /value="approve"/);
  assert.match(html, /value="reject"/);
});
test('accounting rejects bare confirmation and renders evidence reference fields', async () => {
  const url = '/?view=accounting&period=2026-06&group=D-011';
  const { html } = await render({ url, role: 2, rows: [decision] });
  assert.match(html, /name="evidenceReference"/);
  assert.match(html, /name="evidenceFinding"/);
  const result = await render({ url, role: 2, rows: [decision], body: new URLSearchParams({ action: 'payment', reason: '1', occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06' }).toString() });
  assert.equal(result.status, 400);
});
test('dealer intake exposes source and business dates without claiming PDF attachment support', async () => {
  const { html } = await render({ url: '/?view=documents&period=2026-06', role: 3 });
  assert.match(html, /추가 시나리오 자료/);
  assert.match(html, /name="occurredOn"/);
  assert.match(html, /name="effectiveOn"/);
  assert.match(html, /이미지·PDF는 받지 않으며/);
});
