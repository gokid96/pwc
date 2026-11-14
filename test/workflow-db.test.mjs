import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { sourceDirectory } from './fixtures/source-directory.mjs';
import { createWorkflow } from '../src/workflow.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';
import { callAssistant, documentSamples } from '../src/condition.mjs';

// Only run against a disposable database explicitly selected by the caller.
test('isolated PostgreSQL: normal, rejection, change during clarification and change after approval reach accounting', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(process.env.TEST_DATABASE_URL).hostname), 'Use an isolated local database only');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const data = await readW07Data(sourceDirectory);
  // Deterministic stand-in for Gemini: the real validators still check every answer.
  const fakeAI = (kind, input) => {
    if (kind === 'items') return { items: input.allowed.filter(row => ['sharedAccount', 'payee', 'sameRep'].includes(row.id)).map(row => ({ id: row.id,
      quote: row.id === 'payee' && input.reason.includes('수취') ? '수취' : '' })), newItem: '공동 납품 계약 여부' };
    if (kind === 'reply_check') return { items: input.criteria.map(row => {
      const line = input.reply.split('\n').find(text => text.startsWith(row.label + ':'));
      return { id: row.id, verdict: line ? 'met' : 'missing', quote: line ? line.slice(0, 12) : '', note: line ? '' : '답 없음' }; }) };
    if (kind === 'conditions') return { conditions: ['payeeProof', 'sharedAccountStatement'] };
    if (kind === 'review_summary') return { points: [{ facts: ['rate'], text: input.facts.find(fact => fact.id === 'rate').text.slice(0, 70) },
      { facts: ['total'], text: '합계가 99,999,999원이에요' }] };
    if (kind === 'anomaly_note') return { points: input.facts.map(fact => ({ facts: [fact.id], text: '평소보다 장려금률이 높아요' })) };
    throw Error('unused');
  };
  const workflow = createWorkflow(pool, async () => data, calculateW07, (kind, input) => callAssistant(kind, input, { run: async () => fakeAI(kind, input) }));
  const dates = { occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' };
  async function visit(role, values, extra = {}, expected = [200, 303], dealer = 'D-011') {
    const query = new URLSearchParams({ view: role === 2 ? 'accounting' : role === 3 ? 'agency-replies' : 'requests', period: '2026-06', group: 'D-011', ...extra });
    const revision = (await pool.query("SELECT id FROM w07_event WHERE period='2026-06' AND group_id='D-011' ORDER BY id DESC LIMIT 1").catch(() => ({ rows: [] }))).rows[0]?.id ?? '0';
    const body = values ? new URLSearchParams(Array.isArray(values) ? [...Object.entries(dates), ['revision', revision], ...values]
      : { ...dates, revision, ...values }).toString() : null;
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(request, { url: '/?' + query, method: body ? 'POST' : 'GET', headers: { cookie: 'w07_role=' + role + '; w07_dealer=' + dealer } });
    let status, html;
    await workflow(request, { writeHead(code) { status = code; return this; }, end(text) { html = text; } });
    assert.ok(expected.includes(status), String(status) + ': ' + html);
    return html;
  }
  const step = (role, action, reason = '추가 시나리오 확인') => visit(role, { action, reason }, role === 0 ? { view: 'followup' } : {});
  const followup = (values, expected) => visit(0, values, { view: 'followup' }, expected);
  const answer = (dealer, values, expected) => visit(3, { action: 'reply', ...values }, {}, expected, dealer);
  async function payment() {
    await visit(2, { action: 'payment' });
    assert.match(await visit(2), /은행 회신 입력/);
    const event = (await pool.query("SELECT metadata FROM w07_event WHERE action='payment' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(event.metadata.effectivePeriod, '2026-06');
    assert.match(event.metadata.evidence.reference, /지급 배치 B-\d{8}-\d{2} \(모의\)/);
    assert.equal(event.metadata.payees.length, 3);
    assert.ok(event.metadata.payees.every(row => row.status !== 'mismatch'));
    const decision = (await pool.query("SELECT snapshot FROM w07_decision WHERE group_id='D-011'")).rows[0];
    assert.equal(decision.snapshot.totalKrw, 3_888_097);
  }
  async function change() {
    const text = documentSamples(data).change[1];
    await visit(3, { action: 'document_add', text, agency: 'D-011' }, { view: 'documents', group: '' });
    const doc = (await pool.query('SELECT * FROM w07_document ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(doc.metadata.occurredOn, '2026-07-01');
    assert.ok(doc.received_at);
    const original = data.agencies.find(row => row.agency_id === 'D-011');
    await visit(0, { action: 'document_confirm', reason: '신청서 확인', representative_name: original.representative_name,
      address: original.address, bank_account_no: text.split('신규 정산계좌: ')[1], representative_name_decision: 'edit', address_decision: 'edit', bank_account_no_decision: 'edit' },
      { view: 'documents', document: doc.id, group: '' });
    await visit(0, { action: 'account_apply' }, { view: 'documents', document: doc.id, group: '' });
    const review = (await pool.query('SELECT * FROM w07_review ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(review.details.scope.history.length, 15);
    assert.equal(review.details.metadata.effectiveOn, '2026-07-01');
    assert.match(await visit(0), /3,888,097원/);
  }
  // 정보 부족 → 보완 요청 → 재답변 → 임원에게 다시 올리기까지의 거래처 확인 흐름
  async function clarify({ during, account = '국민 412-27-556311' } = {}) {
    await followup({ action: 'ai_items' });
    const proposal = (await pool.query("SELECT result FROM w07_ai_call WHERE kind='items' ORDER BY id DESC LIMIT 1")).rows[0].result;
    assert.deepEqual(proposal.items.map(row => row.id), ['sharedAccount', 'payee', 'sameRep']);
    assert.equal((await pool.query("SELECT status FROM w07_catalog WHERE label='공동 납품 계약 여부'")).rows[0].status, 'proposed');
    await followup([['action', 'send'], ['item', 'sharedAccount'], ['item', 'payee'], ['item', 'sameRep'], ['dueDate', '2026-07-08']]);
    const sent = (await pool.query("SELECT metadata FROM w07_event WHERE action='send' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
    assert.equal(sent.items.length, 3);
    assert.equal(sent.ai.agreed, true);
    if (during) await during();
    await answer('D-099', { ans_sharedAccount: '외부' }, [403]);
    await answer('D-011', { ans_sharedAccount: '공동 납품 정산용 계좌', acc_payee: account, holder_payee: '금강상사11', att_payee: '통장사본.pdf',
      yn_sameRep: '예', ans_sameRep: '대표 동일', att_sameRep: '사업자등록증.pdf' });
    await answer('D-024', { ans_sharedAccount: '잘못 입금했습니다' });
    await followup({ action: 'ai_reply' });
    const check = (await pool.query("SELECT result FROM w07_ai_call WHERE kind='reply_check' ORDER BY id DESC LIMIT 1")).rows[0].result;
    assert.equal(check.recommendation, 'resend');
    assert.equal(check.items.find(row => row.id === 'sharedAccount').verdict, 'partial', '미답변 거래처가 있으면 충족이 아님');
    assert.match(await visit(0, null, { view: 'followup' }), /보완 요청 <strong>성일상사24, 대륙상사37/);
    await followup({ action: 'resend', picked: '1' }, [400]);
    await followup([['action', 'resend'], ['picked', '1'], ['target', 'payee:D-024'], ['target', 'payee:D-037'], ['target', 'sharedAccount:D-024'], ['target', 'sharedAccount:D-037'], ['target', 'sameRep:D-037']]);
    const resend = (await pool.query("SELECT metadata FROM w07_event WHERE action='resend' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
    assert.deepEqual(resend.items.find(row => row.id === 'payee').recipients, ['D-024', 'D-037']);
    assert.deepEqual(resend.items.find(row => row.id === 'sharedAccount').recipients, ['D-024', 'D-037']);
    assert.match(await visit(3, null, {}, [200], 'D-024'), /보완이 필요한 항목/);
    await answer('D-024', { acc_payee: '하나 233-91-004417', holder_payee: '성일상사24', att_payee: '통장사본.pdf', yn_sameRep: '예', ans_sameRep: '동일', att_sameRep: '등록증.pdf' });
    await answer('D-037', { ans_sharedAccount: '공동 정산용', acc_payee: '국민 412-27-556310', holder_payee: '대륙상사37', att_payee: '통장사본.pdf',
      yn_sameRep: '예', ans_sameRep: '동일', att_sameRep: '등록증 사본' });
    await followup({ action: 'ai_reply' });
    await followup({ action: 'verify', resubmit: '1' });
    const verify = (await pool.query("SELECT metadata FROM w07_event WHERE action='verify' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
    assert.equal(verify.ai.recommendation, 'verify');
  }
  try {
    await visit(0);
    for (const scenario of ['normal', 'conditional', 'rejection', 'mismatch', 'change-waiting', 'change-approved']) {
      const callsBefore = Number((await pool.query('SELECT count(*) FROM w07_ai_call')).rows[0].count);
      await visit(4, { action: 'reset', confirm: '2026-06 초기화' }, { view: 'catalog', group: '' });
      assert.equal(Number((await pool.query('SELECT count(*) FROM w07_ai_call')).rows[0].count), callsBefore, '초기화해도 AI 기록은 남음');
      assert.equal((await pool.query("SELECT count(*) FROM w07_ai_call WHERE archived_at IS NULL AND period='2026-06'")).rows[0].count, '0');
      if (scenario === 'normal') await visit(0, { action: 'reset' }, { group: '' }, [403]);
      if (scenario === 'normal') {
        await visit(0, [['action', 'bulk_reject'], ['request', 'D-003']], { group: '' }, [400]);
        await visit(0, [['action', 'bulk_hold'], ['request', 'D-003'], ['reason', '매출 증빙 확인 중']], { group: '' });
        await visit(0, [['action', 'bulk_approve'], ['request', 'D-003']], { group: '' }, [409]);
        await visit(0, { action: 'team_release', reason: '증빙 확인' }, { group: 'D-003' });
        await visit(0, [['action', 'bulk_reject'], ['request', 'D-004'], ['reason', '매출 실적 중복 계상']], { group: '' });
        assert.match(await visit(0, null, { group: '', tab: 'rejected' }), /D-004|반려/);
        await visit(0, [['action', 'bulk_approve'], ['request', 'D-001'], ['request', 'D-002']], { group: '' });
        await Promise.all([
          visit(2, { action: 'batch_pay' }, { group: '' }, [303, 409]),
          visit(2, { action: 'batch_pay' }, { group: '' }, [303, 409]),
        ]);
        const batch = (await pool.query("SELECT group_id, metadata FROM w07_event WHERE action='payment' ORDER BY group_id")).rows;
        assert.deepEqual(batch.map(row => row.group_id), ['D-001', 'D-002']);
        assert.equal(batch[0].metadata.batch, batch[1].metadata.batch);
        await Promise.all([
          visit(2, { action: 'batch_result_ok' }, { group: '' }, [303, 409]),
          visit(2, { action: 'batch_result_ok' }, { group: '' }, [303, 409]),
        ]);
        assert.equal((await pool.query("SELECT count(*) FROM w07_event WHERE action='payment_ok'")).rows[0].count, '2');
        await step(1, 'approve'); await payment(); continue;
      }
      if (scenario === 'conditional') {
        await visit(2, { action: 'post_audit_done', auditGroup: 'D-011', reason: '5개월 확인' }, { view: 'post-audit', group: '' }, [400]);
        await visit(2, { action: 'audit_master_check', auditGroup: 'D-011', masterCheck: 'unknown', reason: '승인 당시 품의서에 등록 정보 기록 없음' }, { view: 'post-audit', group: '' });
        assert.match(await visit(2, null, { view: 'post-audit', group: '' }), /원본에 없어 확인이 필요함/);
        await visit(2, { action: 'post_audit_done', auditGroup: 'D-011', conclusion: 'audit_report', reason: '5개월 연속 팀 승인, 감사 보고 대상' }, { view: 'post-audit', group: '' });
        const concluded = (await pool.query("SELECT metadata FROM w07_event WHERE action='post_audit_done' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
        assert.equal(concluded.masterCheck, 'unknown');
        await visit(2, { action: 'audit_master_check', auditGroup: 'D-011', masterCheck: 'same', reason: '늦은 확인' }, { view: 'post-audit', group: '' }, [409]);
        await visit(2, { action: 'post_audit_done', auditGroup: 'D-011', conclusion: 'closed', reason: '중복' }, { view: 'post-audit', group: '' }, [409]);
        assert.match(await visit(2, null, { view: 'post-audit', group: '' }), /감사 보고/);
        await visit(1, { action: 'ai_conditions' });
        await visit(1, { action: 'ai_summary' });
        const summary = (await pool.query("SELECT result FROM w07_ai_call WHERE kind='review_summary' ORDER BY id DESC LIMIT 1")).rows[0].result;
        assert.equal(summary.points.length, 1, '사실에 없는 숫자를 쓴 문장은 버림');
        assert.match(summary.points[0].text, /금강상사11 장려금률/);
        await visit(0, { action: 'ai_anomaly' }, { group: '' });
        const anomaly = (await pool.query("SELECT result FROM w07_ai_call WHERE kind='anomaly_note' ORDER BY id DESC LIMIT 1")).rows[0].result;
        assert.ok(anomaly.points.some(point => point.facts[0] === 'D-018'), '한라인상사18 이상 표시');
        const page = await visit(1);
        assert.match(page, /검토 요약/);
        assert.match(page, /AI 제안/);
        assert.match(page, /value="precheck3m"/);
        await visit(1, [['action', 'decide'], ['decision', 'approve'], ['reason', ''], ['condition', 'payeeProof'], ['condition', 'sharedAccountStatement'], ['condition', 'precheck3m']]);
        const stored = (await pool.query("SELECT conditions FROM w07_decision WHERE group_id='D-011'")).rows[0];
        assert.deepEqual(stored.conditions, ['payeeProof', 'sharedAccountStatement', 'precheck3m']);
        await visit(2, { action: 'payment' }, {}, [409]);
        for (const condition of stored.conditions) {
          await visit(2, { action: 'condition_check', condition, evidenceReference: '은행 예금주 조회', evidenceFinding: '가상 확인 회신 ' + condition });
        }
        await payment();
        // 모의 은행 회신: 성일상사24 반려 → 영업지원 재확인 → 반려분 재지급 → 전부 지급(대사 완료)
        await visit(2, { action: 'payment_result', result_D_011: 'x' }, {}, [400]);
        await visit(2, { action: 'payment_result', 'result_D-011': 'success', 'result_D-024': 'rejected', 'why_D-024': 'holder', 'result_D-037': 'success' });
        assert.match(await visit(0), /은행이 일부 지급을 반려했어요/);
        await visit(2, { action: 'payment' }, {}, [409]);
        await visit(0, { action: 'payee_recheck', reason: '예금주 표기(성일상사24 → (주)성일상사24) 정정 확인' });
        await visit(2, { action: 'payment' });
        const repay = (await pool.query("SELECT metadata FROM w07_event WHERE action='payment' ORDER BY id DESC LIMIT 1")).rows[0].metadata;
        assert.deepEqual(repay.repay, ['D-024']);
        await visit(2, { action: 'payment_result', 'result_D-011': 'success', 'result_D-024': 'success', 'result_D-037': 'success' });
        assert.match(await visit(2), /지급 완료/);
        continue;
      }
      if (scenario === 'mismatch') {
        await visit(1, { action: 'reject', reason: '공동 입금계좌 경위와 실제 수취계좌 확인 필요' });
        await clarify({ account: '국민 412-27-999999', during: async () => {
          const bad = await answer('D-011', { bank_payee: '국민', acc_payee: '고성민', holder_payee: '' }, [400]);
          assert.match(bad, /계좌번호는 숫자와 하이픈/);
        } });
        await step(1, 'approve');
        const blocked = await visit(2, { action: 'payment' }, {}, [422]);
        assert.match(blocked, /금강상사11의 받을 계좌가 등록 정산계좌와 달라요/);
        assert.match(await visit(2), /변경 요청 보내기/);
        await visit(2, { action: 'payee_resolve', agencyId: 'D-011', reason: '' }, {}, [400]);
        await visit(2, { action: 'payee_change_request', agencyId: 'D-011' });
        await visit(2, { action: 'payment' }, {}, [422]);
        await visit(2, { action: 'payee_resolve', agencyId: 'D-011', reason: '대표자 전화 확인, 등록 계좌 유지' });
        await payment();
        continue;
      }
      if (scenario === 'change-approved') { await step(1, 'approve'); await payment(); await change(); }
      else { await visit(1, { action: 'reject', reason: '공동 입금계좌 경위와 실제 수취계좌 확인 필요' }); }
      await clarify(scenario === 'rejection' ? { account: '국민 412-27-556310' } : scenario === 'change-waiting' ? { during: change } : {});
      assert.match(await visit(1), /다시 올라옴/);
      await step(1, 'approve');
      assert.match(await visit(2), /지급 시스템 반영|지급 가능/);
      await payment();
      assert.equal((await pool.query("SELECT count(*) FROM w07_decision WHERE group_id <> 'D-011'")).rows[0].count, '0');
    }
    await visit(0, { action: 'dispute', disputeKind: 'other', reason: '시연' });
    await visit(0, { action: 'dispute', disputeKind: 'other', reason: '중복' }, {}, [409]);
    await visit(4, { action: 'dispute_close', disputeGroup: 'D-011', result: 'kept', reason: '규칙대로 유지' }, { view: 'catalog', group: '' });
    await visit(4, { action: 'catalog_add', label: '공동 납품 계약서', format: 'yesno', attachment: '계약서' }, { view: 'catalog', group: '' });
    await visit(4, { action: 'catalog_status', id: 'relation', status: 'disabled' }, { view: 'catalog', group: '' });
    const rows = (await pool.query("SELECT id, status FROM w07_catalog ORDER BY id")).rows;
    assert.ok(rows.some(row => row.id === 'relation' && row.status === 'disabled'));
  } finally { await pool.end(); }
});
