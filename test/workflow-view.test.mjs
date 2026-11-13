import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createWorkflow } from '../src/workflow.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';
const data = await readW07Data(fileURLToPath(new URL('../01_참가자_배포용/04_원본데이터/', import.meta.url)));
async function render({ url, role = 1, rows = [], events = [], documents = [], calls = [], reviews = [], catalog = [], body, dealer = 'D-011' }) {
  const db = { release() {}, async query(sql) {
    const items = /^SELECT/.test(sql) ? sql.includes('w07_review') ? reviews : sql.includes('w07_decision') ? rows :
      sql.includes('w07_event') ? events : sql.includes('w07_document') ? documents : sql.includes('w07_ai_call') ? calls :
        sql.includes('w07_catalog') ? catalog : [] : [];
    return { rows: items, rowCount: items.length };
  } };
  const workflow = createWorkflow({ connect: async () => db, query: db.query }, async () => data, calculateW07,
    async () => { throw Error('AI must not run in view tests'); });
  let html, status;
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, { url, method: body ? 'POST' : 'GET', headers: { cookie: 'w07_role=' + role + '; w07_dealer=' + dealer } });
  await workflow(request, { writeHead(code) { status = code; return this; }, end(text) { html = text; } });
  return { html, status };
}
const metadata = { occurredOn: '2026-07-02', effectiveOn: '2026-07-02', effectivePeriod: '2026-06', source: 'manual' };
const decision = { group_id: 'D-011', role: '영업임원', action: 'approve', reason: '', acted_at: new Date('2026-07-01'), created_at: new Date('2026-07-01') };
const rejected = { ...decision, action: 'reject', created_at: null, reason: '공동 입금계좌 경위와 실제 수취계좌가 확인되지 않음' };
const items = [
  { id: 'sharedAccount', label: '공동 입금계좌를 함께 쓴 이유', format: 'text', attachment: '', recipients: ['D-011', 'D-024', 'D-037'] },
  { id: 'payee', label: '장려금 받을 계좌와 예금주', format: 'account', attachment: '통장 사본', recipients: ['D-011', 'D-024', 'D-037'] },
];
const sent = { id: 1, group_id: 'D-011', role: '영업지원팀', action: 'send', reason: '확인 항목: 1) 공동 2) 계좌 · 기한 2026-07-08',
  acted_at: new Date('2026-07-02'), metadata: { ...metadata, items, dueDate: '2026-07-08' } };
const reply = (id, agency, answers, at = '2026-07-03') => ({ id, group_id: 'D-011', role: '대리점', action: 'reply', agency_id: agency,
  reason: '답변', acted_at: new Date(at), metadata: { ...metadata, answers } });

test('role entry offers five roles including the administrator', async () => {
  const { html } = await render({ url: '/?view=roles' });
  for (const name of ['영업지원팀', '영업임원', '회계', '대리점', '관리자']) assert.match(html, new RegExp('<strong>' + name + '</strong>'));
});

test('support detail leads with one next step, a plain summary and acknowledgeable checks', async () => {
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', role: 0 });
  assert.ok(html.indexOf('다음 단계') < html.indexOf('3곳을 한 거래처로 보고 합산했어요'));
  assert.match(html, /영업임원이 결정할 차례예요/);
  assert.match(html, /value="remind"/);
  assert.match(html, /각각은 한도 안이지만 합치면 넘어서/);
  assert.match(html, /188만원 초과/);
  assert.match(html, /성일상사24가 다른 곳 계좌로 2번 입금했어요/);
  assert.match(html, /value="ack"/);
  assert.match(html, /value="dispute"/);
  assert.match(html, /장려금을 받은 계좌라고 단정하지 않아요/);
  assert.match(html, /class="src src-raw"[^>]*>원본</);
  assert.match(html, /class="src src-calc"[^>]*>계산</);
  assert.match(html, /표시 읽는 법/);
});

test('executive empty list and evidence-based conditions while the AI proposal runs', async () => {
  const empty = await render({ url: '/?view=requests&period=2026-06', rows: [decision] });
  assert.match(empty.html, /지금 결정할 요청이 없어요/);
  const pending = await render({ url: '/?view=requests&period=2026-06&group=D-011', calls: [
    { kind: 'conditions', group_id: 'D-011', created_at: new Date('2026-07-01'), finished_at: null, result: null },
  ] });
  assert.match(pending.html, /AI가 고르는 중/);
  assert.equal((pending.html.match(/name="condition"/g) ?? []).length, 4);
  assert.match(pending.html, /DP-00013·DP-00014/);
  assert.doesNotMatch(pending.html, /data-ai data-auto/);
  const fresh = await render({ url: '/?view=requests&period=2026-06&group=D-011' });
  assert.match(fresh.html, /value="ai_conditions"/);
  assert.match(fresh.html, /data-ai data-auto/);
  assert.match(fresh.html, /name="decision" value="approve" checked/);
});

test('past conclusion of audit report adds the three-month precheck condition', async () => {
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', events: [
    { id: 5, group_id: 'D-011', role: '회계', action: 'post_audit_done', reason: '감사 보고', acted_at: new Date('2026-07-01'), metadata: { conclusion: 'audit_report' } },
  ] });
  assert.equal((html.match(/name="condition"/g) ?? []).length, 5);
  assert.match(html, /다음 3개월 이 묶음 지급 전 영업임원 사전 확인/);
});

test('compose screen lists catalog items with reasons and starts the AI proposal', async () => {
  const { html } = await render({ url: '/?view=followup&period=2026-06&group=D-011', role: 0, rows: [rejected] });
  assert.match(html, /거래처에 확인 요청하기/);
  assert.match(html, /임원 의견/);
  assert.match(html, /value="ai_items"/);
  assert.match(html, /name="item" value="payee" checked/);
  assert.match(html, /name="item" value="sameAddress">/);
  assert.match(html, /name="dueDate" value="2026-07-08"/, '기준일 2026-07-01 + 영업일 5일');
  assert.match(html, /name="occurredOn" value="2026-07-01"/);
  assert.match(html, /value="send"/);
});

test('reply review shows answers per agency, AI verdicts and a narrowed resend preview', async () => {
  const events = [sent, reply(2, 'D-011', { sharedAccount: { text: '공동 납품 정산용' }, payee: { account: '국민 412-27-556311', holder: '금강상사11', attachment: '사본.pdf' } }),
    reply(3, 'D-024', { sharedAccount: { text: '잘못 입금' } })];
  const { html } = await render({ url: '/?view=followup&period=2026-06&group=D-011', role: 0, rows: [rejected], events,
    calls: [{ id: 7, kind: 'reply_check', group_id: 'D-011', created_at: new Date('2026-07-03'), finished_at: new Date('2026-07-03'), result: {
      replyId: '3', recommendation: 'resend', draft: '', items: [
        { id: 'sharedAccount', label: items[0].label, verdict: 'partial', quote: '공동 납품 정산용', note: '답하지 않은 거래처가 있음' },
        { id: 'payee', label: items[1].label, verdict: 'missing', quote: null, note: '' },
      ] } }] });
  assert.match(html, /답변 2\/3곳/);
  assert.match(html, /AI 의견: <strong>보완 요청/);
  assert.match(html, /"공동 납품 정산용"/);
  assert.match(html, /장려금 받을 계좌와 예금주 → 성일상사24, 대륙상사37/);
  assert.match(html, /value="resend"/);
  assert.match(html, /name="resubmit" value="1"/);
  assert.doesNotMatch(html, /data-ai data-auto/);
});

test('dealer sees only own items and the narrowed request after a resend', async () => {
  const resend = { id: 4, group_id: 'D-011', role: '영업지원팀', action: 'resend', reason: 'D-024 · 장려금 받을 계좌와 예금주 보완이 필요합니다.\nD-037 · 공동 입금계좌를 함께 쓴 이유 보완이 필요합니다.',
    acted_at: new Date('2026-07-04'), metadata: { ...metadata, dueDate: '2026-07-08', items: [{ ...items[1], recipients: ['D-024'] }, { ...items[0], recipients: ['D-037'] }] } };
  const events = [sent, reply(2, 'D-024', { sharedAccount: { text: '잘못 입금' } }), resend];
  const dealer = await render({ url: '/?view=agency-replies&period=2026-06&group=D-011', role: 3, dealer: 'D-024', rows: [rejected], events });
  assert.match(dealer.html, /보완이 필요한 항목 1개/);
  assert.match(dealer.html, /name="acc_payee"/);
  assert.doesNotMatch(dealer.html, /name="ans_sharedAccount"/);
  assert.doesNotMatch(dealer.html, /D-037 ·|대륙상사37|공동 입금계좌 경위와 실제/);
  const other = await render({ url: '/?view=agency-replies&period=2026-06&group=D-011', role: 3, dealer: 'D-011', rows: [rejected], events });
  assert.doesNotMatch(other.html, /name="reply"|value="reply"/);
  const post = await render({ url: '/?view=agency-replies&period=2026-06&group=D-011', role: 3, dealer: 'D-011', rows: [rejected], events,
    body: new URLSearchParams({ action: 'reply', ...metadata, sameEffectiveDate: 'yes', acc_payee: '1', holder_payee: '2' }).toString() });
  assert.equal(post.status, 403);
});

test('accounting must confirm every approval condition before payment', async () => {
  const conditional = { ...decision, conditions: ['payeeProof'] };
  const url = '/?view=accounting&period=2026-06&group=D-011';
  const { html } = await render({ url, role: 2, rows: [conditional] });
  assert.match(html, /조건 0\/1 · 지급 보류/);
  assert.match(html, /value="condition_check"/);
  assert.match(html, /name="action" value="payment" disabled/);
  const blocked = await render({ url, role: 2, rows: [conditional],
    body: new URLSearchParams({ action: 'payment', revision: '0', ...metadata, sameEffectiveDate: 'yes' }).toString() });
  assert.equal(blocked.status, 409);
  const bare = await render({ url, role: 2, rows: [conditional],
    body: new URLSearchParams({ action: 'condition_check', condition: 'payeeProof', revision: '0', ...metadata, sameEffectiveDate: 'yes' }).toString() });
  assert.equal(bare.status, 400);
  const confirmed = await render({ url, role: 2, rows: [conditional], events: [
    { id: 3, group_id: 'D-011', role: '회계', action: 'condition_check', reason: '명의 확인', acted_at: new Date('2026-07-05'),
      metadata: { condition: 'payeeProof', evidence: { reference: '은행 예금주 조회', finding: '명의 확인' } } },
  ] });
  assert.match(confirmed.html, /조건 1\/1 · 지급 가능/);
  assert.match(confirmed.html, /class="primary" name="action" value="payment">/);
  assert.match(confirmed.html, /src-mock[^>]*>모의</);
  assert.match(confirmed.html, /가상 확인/);
});

test('payment goes only to registered settlement accounts; a different answered account blocks it', async () => {
  const url = '/?view=accounting&period=2026-06&group=D-011';
  const snapshot = { totalKrw: 3888097, members: [{ agencyId: 'D-011', amountKrw: 1373515, source: 'sales_rebate_payment_cv.csv:212' }] };
  const events = [sent, reply(2, 'D-011', { payee: { account: '국민 412-27-556311', holder: '금강상사11' } })];
  const { html } = await render({ url, role: 2, rows: [{ ...decision, snapshot }], events });
  assert.match(html, /1곳 확인 필요/);
  assert.match(html, /name="action" value="payment" disabled/);
  assert.match(html, /승인 당시 기록 · 합계 3,888,097원/);
  const blocked = await render({ url, role: 2, rows: [decision], events,
    body: new URLSearchParams({ action: 'payment', revision: '2', ...metadata, sameEffectiveDate: 'yes' }).toString() });
  assert.equal(blocked.status, 422);
  const same = [sent, reply(2, 'D-011', { payee: { account: '국민 412-27-556310', holder: '금강상사11' } })];
  const ok = await render({ url, role: 2, rows: [decision], events: same });
  assert.match(ok.html, /모두 등록 정산계좌/);
});

test('past breaches: accounting decides one of three conclusions, others only read', async () => {
  const support = await render({ url: '/?view=post-audit&period=2026-06', role: 0 });
  assert.match(support.html, /15건, 22,238,349원/);
  assert.match(support.html, /첫 지급\(2026-02-04\) 전부터 등록돼 있어/);
  assert.match(support.html, /현재 등록일·지급일로 계산한 추정/);
  assert.doesNotMatch(support.html, /value="post_audit_done"/);
  const accounting = await render({ url: '/?view=post-audit&period=2026-06', role: 2 });
  for (const value of ['closed', 'audit_report', 'recovery']) assert.match(accounting.html, new RegExp('name="conclusion" value="' + value + '"'));
  assert.match(accounting.html, /value="audit_master_check"/);
  assert.match(accounting.html, /미확인 상태 결론/);
  const missing = await render({ url: '/?view=post-audit&period=2026-06', role: 2,
    body: new URLSearchParams({ action: 'post_audit_done', auditGroup: 'D-011', reason: '의견' }).toString() });
  assert.equal(missing.status, 400);
  const recovery = await render({ url: '/?view=post-audit&period=2026-06', role: 0, events: [
    { id: 5, group_id: 'D-011', role: '회계', action: 'post_audit_done', reason: '회수 검토', acted_at: new Date('2026-07-01'), metadata: { conclusion: 'recovery' } },
  ] });
  assert.match(recovery.html, /value="recovery_done"/);
  const home = await render({ url: '/?view=home&period=2026-06', role: 0, events: recovery.html ? [
    { id: 5, group_id: 'D-011', role: '회계', action: 'post_audit_done', reason: '회수 검토', acted_at: new Date('2026-07-01'), metadata: { conclusion: 'recovery' } },
  ] : [] });
  assert.match(home.html, /회수 확인/);
});

test('history is newest first and records stay collapsed with defaults', async () => {
  const events = [sent, reply(2, 'D-011', { sharedAccount: { text: '받은 회신 내용' } })];
  const { html } = await render({ url: '/?view=followup&period=2026-06&group=D-011', role: 0, rows: [rejected], events });
  const history = html.slice(html.indexOf('id="history"'));
  assert.ok(history.indexOf('거래처 답변') < history.indexOf('거래처 확인 요청'));
  assert.match(html, /<details class="record"><summary>기록 정보/);
  assert.match(html, /name="occurredOn" value="2026-07-02" required/, '가상 업무일: 마지막 기록의 업무일을 이어받음');
  assert.match(html, /<th scope="col">기록 시각<\/th>/);
});

test('dealer documents offer a structured change request without other agencies', async () => {
  const { html } = await render({ url: '/?view=documents&period=2026-06', role: 3 });
  assert.match(html, /등록 정보 변경 신청/);
  assert.match(html, /name="kind" value="account" checked/);
  assert.match(html, /name="newValue"/);
  assert.doesNotMatch(html, /성일상사24|대륙상사37/);
});

test('administrator sees the catalog and AI log; others cannot', async () => {
  const catalog = await render({ url: '/?view=catalog&period=2026-06', role: 4, catalog: [
    { id: 'p9', kind: 'item', label: '공동 납품 계약 여부', format: 'text', attachment: '', status: 'proposed' },
  ] });
  assert.match(catalog.html, /공동 납품 계약 여부/);
  assert.match(catalog.html, /AI 제안 · 검토 대기/);
  assert.match(catalog.html, /value="catalog_add"/);
  const denied = await render({ url: '/?view=catalog&period=2026-06', role: 0 });
  assert.equal(denied.status, 403);
  const log = await render({ url: '/?view=ai-log&period=2026-06', role: 4 });
  assert.match(log.html, /AI 사용 기록/);
});
