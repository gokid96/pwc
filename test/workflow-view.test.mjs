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
test('historical AI text is preserved and explicitly marked as previous evidence', async () => {
  const { html } = await render({ url: '/?view=requests&period=2026-06&group=D-011', rows: [decision], calls: [
    { kind: 'summary', group_id: 'D-011', created_at: new Date('2026-07-01'), finished_at: new Date('2026-07-01'), result: { check: 'registration' } },
  ] });
  assert.match(html, /이전 근거 기준/);
  assert.match(html, /현재 등록 정보만으로/);
  assert.doesNotMatch(html, /value="approve"/);
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
