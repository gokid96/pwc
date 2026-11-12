import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createWorkflow } from '../src/workflow.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';
import { callAssistant, documentSamples } from '../src/condition.mjs';

// Only run against a disposable database explicitly selected by the caller.
test('isolated PostgreSQL: normal, rejection, change during clarification and change after approval reach accounting', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(process.env.TEST_DATABASE_URL).hostname), 'Use an isolated local database only');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const data = await readW07Data(fileURLToPath(new URL('../01_참가자_배포용/04_원본데이터/', import.meta.url)));
  // Deterministic stand-in for Gemini: the real validators still check every answer.
  const fakeAI = (kind, input) => kind === 'reply_check' ? { items: input.criteria.map(row => ({ id: row.id,
    verdict: input.reply.includes('A-02') || row.id === 'history' ? 'met' : 'missing',
    quote: input.reply.includes('A-02') || row.id === 'history' ? input.reply.slice(0, 8) : '' })) }
    : kind === 'conditions' ? { conditions: ['payeeProof', 'sharedAccountStatement'] } : (() => { throw Error('unused'); })();
  const workflow = createWorkflow(pool, async () => data, calculateW07, (kind, input) => callAssistant(kind, input, { run: async () => fakeAI(kind, input) }));
  const dates = { occurredOn: '2026-07-01', effectiveOn: '2026-07-01', effectivePeriod: '2026-06', source: 'scenario' };
  async function visit(role, values, extra = {}, expected = [200, 303]) {
    const query = new URLSearchParams({ view: role === 2 ? 'accounting' : 'requests', period: '2026-06', group: 'D-011', ...extra });
    const revision = (await pool.query("SELECT id FROM w07_event WHERE period='2026-06' AND group_id='D-011' ORDER BY id DESC LIMIT 1").catch(() => ({ rows: [] }))).rows[0]?.id ?? '0';
    const body = values ? new URLSearchParams(Array.isArray(values) ? [...Object.entries(dates), ['revision', revision], ...values]
      : { ...dates, revision, ...values }).toString() : null;
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(request, { url: '/?' + query, method: body ? 'POST' : 'GET', headers: { cookie: 'w07_role=' + role + '; w07_dealer=D-011' } });
    let status, html;
    await workflow(request, { writeHead(code) { status = code; return this; }, end(text) { html = text; } });
    assert.ok(expected.includes(status), String(status) + ': ' + html);
    return html;
  }
  const step = (role, action, reason = '추가 시나리오 확인') => visit(role, { action, reason }, role === 3 ? { view: 'agency-replies' } : {});
  async function payment() {
    await visit(2, { action: 'payment', evidenceReference: '추가 시나리오 확인서 A-01', evidenceFinding: '수취 명의와 계좌 확인 내용' });
    assert.match(await visit(2), /지급 검토 가능/);
    const event = (await pool.query("SELECT metadata FROM w07_event WHERE action='payment' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(event.metadata.effectivePeriod, '2026-06');
    assert.equal(event.metadata.evidence.reference, '추가 시나리오 확인서 A-01');
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
      { view: 'documents', document: doc.id });
    await visit(0, { action: 'account_apply' }, { view: 'documents', document: doc.id });
    const review = (await pool.query('SELECT * FROM w07_review ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(review.details.scope.history.length, 15);
    assert.equal(review.details.metadata.effectiveOn, '2026-07-01');
    assert.match(await visit(0), /3,888,097원/);
  }
  try {
    await visit(0);
    for (const scenario of ['normal', 'conditional', 'rejection', 'change-waiting', 'change-approved']) {
      await step(0, 'reset');
      if (scenario === 'normal') { await step(1, 'approve'); await payment(); continue; }
      if (scenario === 'conditional') {
        await visit(1, { action: 'ai_conditions' });
        assert.match(await visit(1), /AI 제안 1/);
        await visit(1, [['action', 'approve'], ['reason', '수취계좌 확인 조건부 승인'], ['condition', 'payeeProof'], ['condition', 'sharedAccountStatement']]);
        const stored = (await pool.query("SELECT conditions FROM w07_decision WHERE group_id='D-011'")).rows[0];
        assert.deepEqual(stored.conditions, ['payeeProof', 'sharedAccountStatement']);
        await visit(2, { action: 'payment', evidenceReference: '확인서', evidenceFinding: '확인 내용' }, {}, [409]);
        for (const condition of ['payeeProof', 'sharedAccountStatement']) {
          await visit(2, { action: 'condition_check', condition, evidenceReference: '추가 시나리오 자료 ' + condition, evidenceFinding: '가상 확인 회신' });
        }
        await payment();
        await visit(0, { action: 'post_audit', auditGroup: 'D-011' }, { view: 'requests', group: '' });
        await visit(2, { action: 'post_audit_done', auditGroup: 'D-011', reason: '권한 초과 전결 5개월 확인, 감사 보고 대상' }, { view: 'accounting', group: '' });
        assert.match(await visit(2, null, { view: 'accounting', group: '' }), /사후 검토 완료/);
        continue;
      }
      if (scenario === 'change-approved') { await step(1, 'approve'); await payment(); await change(); }
      else { await step(1, 'reject'); }
      await step(0, 'send', '공동 계좌 사용 경위와 수취 명의 자료 요청');
      if (scenario === 'change-waiting') await change();
      await step(3, 'reply', '자료가 아직 없습니다.');
      await step(0, 'ai_reply');
      assert.match(await visit(0), /AI 의견 <strong>보완 요청/);
      await step(0, 'resend', '근거가 부족합니다. 확인 자료를 다시 요청합니다.');
      const resend = (await pool.query("SELECT metadata FROM w07_event WHERE action='resend' ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(resend.metadata.ai.agreed, true);
      assert.equal(resend.metadata.ai.unmet.length, 2);
      assert.match(await visit(3, null, { view: 'agency-replies' }), /지난 답변에서 확인되지 않은 항목/);
      await step(3, 'reply', '추가 시나리오 자료 A-02로 공동 사용 경위와 명의를 회신합니다.');
      await step(0, 'ai_reply');
      await step(0, 'verify');
      await step(0, 'resubmit', '');
      assert.match(await visit(1), /재상신 · 임원 재결정/);
      await step(1, 'approve');
      assert.match(await visit(2), /확인 대기/);
      await payment();
      assert.equal((await pool.query("SELECT count(*) FROM w07_decision WHERE group_id <> 'D-011'")).rows[0].count, '0');
    }
  } finally { await pool.end(); }
});
