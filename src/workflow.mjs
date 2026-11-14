import { inputMetadata, paymentEvidence, summaryBasis } from './audit.mjs';
import { steps, labels, requestProgress, followupError } from './followup.mjs';
import { applyChanges, callAssistant, documentSamples, fields, individualExceedance, isOpenPeriod, reviewScope } from './condition.mjs';
import { conditionBasis, conditionCatalog, confirmedConditions, itemBasis, masterCheckResults, pastExceedances, pct, postAuditConclusions, precheckGroups, rateAnomaly, rebateRates, recommendationLabels, replyCriteria, verdictLabels } from './controls.mjs';
import { accountInput, buildRequestItems, composeReply, decisionSnapshot, effectiveCatalog, payeePlan, mergedAnswers, recipientsOf, replyText, requestItems, resendItems, resendText } from './requests.mjs';
import * as screens from './screens.mjs';
import { BASE_DATE, shell, styles as uiStyles } from './ui.mjs';
import { approveSupportRequests } from './bulk-approval.mjs';

const roles = ['영업지원팀', '영업임원', '회계', '대리점', '관리자'];
const roleDescriptions = [
  '팀 승인, 거래처 확인 요청, 서류 확인을 처리합니다.',
  '한도를 넘는 묶음의 근거를 보고 승인 여부를 결정합니다.',
  '승인 조건을 확인하고 지급 시스템에 반영합니다.',
  '거래처 확인 요청에 답변하고 서류를 제출합니다.',
  'AI 사용 기록, 확인 항목 목록, 묶음 이의 제기를 관리합니다.',
];
const roleViews = [
  ['requests', 'followup', 'documents', 'review', 'post-audit'],
  ['requests', 'post-audit'],
  ['accounting', 'post-audit'],
  ['agency-replies', 'documents'],
  ['ai-log', 'catalog'],
];
const decisions = { approve: '승인', reject: '거절', clarify: '추가 확인 요청' };
const eventLabels = {
  document_received: '서류 접수', account_changed: '계좌 변경 적용',
  review_approve: '재검토 승인, 보류 해제', review_reject: '재검토 거절', review_clarify: '재검토 추가 확인 요청',
  condition_check: '승인 조건 확인', post_audit: '사후 검토 요청', post_audit_done: '사후 검토 의견',
};
const money = amount => new Intl.NumberFormat('ko-KR').format(amount) + '원';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date(value));

async function transaction(pool, period, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['w07:' + (pool.lockScope ?? 'default') + ':' + period]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function saveDecision(db, period, groupId, role, action, reason, conditions = [], snapshot = null) {
  await db.query(`INSERT INTO w07_decision (period, group_id, role, action, reason, conditions, snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [period, groupId, role, action, reason, JSON.stringify(conditions), snapshot]);
  if (action === 'approve') {
    await db.query('INSERT INTO w07_accounting_task (period, group_id) VALUES ($1,$2)', [period, groupId]);
  }
}

function latestReview(reviews, entry) {
  return entry && reviews.findLast(review => review.details.scope.agencies.some(id =>
    entry.group.members.some(member => member.agencyId === id)));
}

export function createWorkflow(pool, readData, calculate, assistant = callAssistant) {
  let schema;
  function ensureSchema() {
    schema ??= transaction(pool, 'schema', async db => {
      await db.query(`CREATE TABLE IF NOT EXISTS w07_decision (
        period text NOT NULL, group_id text NOT NULL, role text NOT NULL, action text NOT NULL,
        reason text NOT NULL, acted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (period, group_id)
      )`);
      await db.query('ALTER TABLE w07_decision ADD COLUMN IF NOT EXISTS conditions jsonb');
      await db.query('ALTER TABLE w07_decision ADD COLUMN IF NOT EXISTS snapshot jsonb');
      await db.query(`CREATE TABLE IF NOT EXISTS w07_accounting_task (
        period text NOT NULL, group_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (period, group_id),
        FOREIGN KEY (period, group_id) REFERENCES w07_decision(period, group_id) ON DELETE CASCADE
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS w07_event (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        period text NOT NULL, group_id text NOT NULL, role text NOT NULL,
        action text NOT NULL, reason text NOT NULL, acted_at timestamptz NOT NULL DEFAULT now()
      )`);
      await db.query('ALTER TABLE w07_event ADD COLUMN IF NOT EXISTS review_id bigint');
      await db.query('ALTER TABLE w07_event ADD COLUMN IF NOT EXISTS agency_id text');
      await db.query('ALTER TABLE w07_event ADD COLUMN IF NOT EXISTS metadata jsonb');
      await db.query(`CREATE TABLE IF NOT EXISTS w07_document (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, period text NOT NULL,
        agency_id text NOT NULL, original text NOT NULL, confirmed jsonb, applied boolean NOT NULL DEFAULT false
      )`);
      await db.query('ALTER TABLE w07_document ADD COLUMN IF NOT EXISTS metadata jsonb');
      await db.query('ALTER TABLE w07_document ADD COLUMN IF NOT EXISTS received_at timestamptz');
      await db.query(`CREATE TABLE IF NOT EXISTS w07_review (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, period text NOT NULL, agency_id text NOT NULL,
        document_id bigint NOT NULL REFERENCES w07_document(id), kind text NOT NULL, details jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id, kind)
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS w07_catalog (
        id text PRIMARY KEY, kind text NOT NULL DEFAULT 'item', label text NOT NULL, format text,
        attachment text, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS w07_ai_call (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, period text NOT NULL,
        document_id bigint REFERENCES w07_document(id), group_id text, kind text NOT NULL,
        request jsonb, raw jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`);
      await db.query('ALTER TABLE w07_ai_call ADD COLUMN IF NOT EXISTS archived_at timestamptz');
    }).catch(error => { schema = undefined; throw error; });
    return schema;
  }

  return async function workflow(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams;
    const roleIndex = Number(request.headers.cookie?.match(/(?:^|;\s*)w07_role=([0-4])(?:;|$)/)?.[1] ?? -1);
    const role = roles[roleIndex];
    const requestedPeriod = query.get('period');
    const periodQuery = /^\d{4}-\d{2}$/.test(requestedPeriod ?? '') ? { period: requestedPeriod } : {};
    const rolePageLink = '/';
    const caseId = query.get('case');
    const roleContext = /^D-\d+$/.test(caseId ?? '') ? { case: caseId } : {};
    const send = (status, content) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(content);
    };
    const entryPage = (title, content) => '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title +
      '</title><style>' + uiStyles + '.entry{max-width:880px;margin:48px auto;padding:0 16px;display:flex;flex-direction:column;gap:20px}.role-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.role-cards button{width:100%;height:auto;min-height:120px;flex-direction:column;align-items:flex-start;justify-content:flex-start;text-align:left;padding:18px;border-radius:14px}.role-cards small{color:#526074;font-weight:400}</style></head><body><main class="entry"><h1>' + title +
      '</h1>' + content + '</main></body></html>';
    const denied = () => send(403, entryPage('이 역할에서는 볼 수 없습니다',
      '<p><a href="' + rolePageLink + '">역할 바꾸기</a></p>'));
    const requestedView = query.get('view');
    const historicalReview = query.get('after') === 'historical-review';
    if (requestedView === 'roles' && request.method === 'POST') {
      const selected = query.get('select');
      if (!/^[0-4]$/.test(selected ?? '') || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return denied();
      response.writeHead(303, {
        Location: '/?' + new URLSearchParams({
          ...periodQuery, ...roleContext, view: roleContext.case && selected === '0' ? 'requests' : historicalReview && selected === '0' ? 'review' : roleViews[Number(selected)][0],
        }) + (historicalReview && selected === '0' ? '#historical-review' : ''),
        'Set-Cookie': [...(response.getHeader?.('Set-Cookie') ? [response.getHeader('Set-Cookie')] : []), 'w07_role=' + selected + '; Path=/; HttpOnly; Secure; SameSite=Lax',
          ...(selected === '3' ? ['w07_dealer=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'] : [])],
        'Cache-Control': 'no-store',
      }).end();
      return;
    }
    if (!role || !url.search || requestedView === 'roles') {
      if (request.method !== 'GET') return denied();
      if (role && !url.search) {
        response.writeHead(303, { Location: '/?view=' + roleViews[roleIndex][0], 'Cache-Control': 'no-store' }).end();
        return;
      }
      return send(200, entryPage('판매장려금 운영', '<p class="muted">담당 업무를 선택하세요. 업무 기록은 현재 브라우저의 작업 공간에 저장됩니다.</p><div class="role-cards">' +
        roles.map((name, index) => '<form method="post" action="/?' +
          escape(new URLSearchParams({ ...periodQuery, ...roleContext, view: 'roles', select: index,
            ...(historicalReview ? { after: 'historical-review' } : {}) }).toString()) +
          '"><button><strong>' + name + '</strong><small>' + roleDescriptions[index] + '</small><span style="margin-top:auto;color:#2467d6">들어가기 →</span></button></form>').join('') + '</div>'));
    }
    // 예전 주소(view=home)는 영업지원팀 첫 화면인 승인 요청으로 보낸다.
    const view = requestedView === 'home' && roleIndex === 0 ? 'requests' : requestedView ?? (query.has('group') ? 'requests' : roleViews[roleIndex][0]);
    if (!roleViews[roleIndex].includes(view) && (view !== 'ai-log' || role === '대리점')) return denied();
    const data = await readData();
    const original = calculate(data);
    const periods = [...new Set(original.requests.map(item => item.period))].sort().reverse();
    const period = query.get('period') ?? periods[0];
    const open = isOpenPeriod(data.rebates, period);
    const groupId = query.get('groupPeriod') && query.get('groupPeriod') !== period ? null : query.get('group');
    const documentId = query.get('document');
    const requestedCase = query.get('case');
    const link = extras => '/?' + escape(new URLSearchParams({ period, view, ...extras }).toString());

    if (!periods.includes(period)) return send(404, '정산 요청을 찾을 수 없습니다.');
    await ensureSchema();
    const snapshot = await transaction(pool, period, async db => {
      const reviews = await db.query('SELECT * FROM w07_review WHERE period = $1 ORDER BY id', [period]);
      const decisions = await db.query(`SELECT d.*, t.created_at FROM w07_decision d
        LEFT JOIN w07_accounting_task t USING (period, group_id) WHERE d.period = $1`, [period]);
      const history = await db.query('SELECT * FROM w07_event WHERE period = $1 ORDER BY id', [period]);
      const docs = await db.query('SELECT * FROM w07_document WHERE period = $1 ORDER BY id', [period]);
      const calls = view === 'ai-log'
        ? await db.query('SELECT * FROM w07_ai_call ORDER BY id')
        : await db.query('SELECT * FROM w07_ai_call WHERE period = $1 AND archived_at IS NULL ORDER BY id', [period]);
      const catalogRows = await db.query('SELECT * FROM w07_catalog ORDER BY created_at, id');
      const audits = await db.query("SELECT * FROM w07_event WHERE action = 'post_audit_done'");
      const allEvents = ['catalog', 'ai-log'].includes(view) ? (await db.query('SELECT * FROM w07_event ORDER BY id')).rows : null;
      return { reviews: reviews.rows, rows: decisions.rows, events: history.rows, documents: docs.rows, calls: calls.rows, catalogRows: catalogRows.rows, allEvents, audits: audits.rows };
    });
    const { reviews, rows, events, calls, catalogRows } = snapshot;
    const precheck = precheckGroups(snapshot.audits ?? [], period);
    const approverOf = entry => precheck.has(entry.group.groupId) ? roles[1] : entry.approver;
    const catalog = effectiveCatalog(catalogRows);
    const activeItems = Object.fromEntries(Object.entries(catalog.items).filter(([, entry]) => entry.status === 'active'));
    const effective = calculate(applyChanges(data, reviews));
    const originalList = original.requests.filter(entry => entry.period === period);
    const current = effective.requests.filter(entry => entry.period === period);
    const saved = new Map(rows.map(row => [row.group_id, row]));
    const eventsFor = id => events.filter(event => event.group_id === id);
    const progressFor = entry => entry ? requestProgress(saved.get(entry.group.groupId),
      eventsFor(entry.group.groupId), entry.exceedsLimit, latestReview(reviews, entry)) : {};
    const isAffected = entry => progressFor(entry).held;
    // 팀 승인 건 보류·반려: 마지막 보류/반려/해제 기록으로 판단한다(해제면 다시 승인 대기).
    const teamState = entry => {
      const last = eventsFor(entry.group.groupId).filter(event => ['team_hold', 'team_reject', 'team_release'].includes(event.action)).at(-1);
      return last && last.action !== 'team_release' && !saved.has(entry.group.groupId) ? last : null;
    };
    const latestReplyCheck = entry => {
      const answer = eventsFor(entry.group.groupId).findLast(event => event.action === 'reply');
      return answer && calls.filter(call => call.kind === 'reply_check' && call.group_id === entry.group.groupId &&
        (!call.finished_at || call.result?.replyId === String(answer.id))).at(-1);
    };
    // 답변 판정 후처리: 받을 곳 중 미답변 거래처가 있으면 충족으로 두지 않는다(코드 규칙).
    const withRecipients = (result, groupEvents) => {
      const asked = requestItems(groupEvents, query.get('group'));
      const merged = mergedAnswers(groupEvents);
      const answered = (row, id) => row.recipients.every(agencyId => {
        const answer = merged[agencyId]?.items[id];
        return answer && Object.values(answer).some(value => String(value ?? '').trim());
      });
      const items = result.items.map(entry => {
        const row = asked.find(candidate => candidate.id === entry.id);
        return row && entry.verdict === 'met' && !answered(row, entry.id)
          ? { ...entry, verdict: 'partial', note: '답하지 않은 거래처가 있음' } : entry;
      });
      const recommendation = items.every(entry => entry.verdict === 'met') ? 'verify' : 'resend';
      return { ...result, items, recommendation, draft: recommendation === 'resend' ? resendText(resendItems(asked, merged, items)) : '',
        replyId: String(groupEvents.findLast(event => event.action === 'reply').id) };
    };
    const pastConclusionFor = id => eventsFor(id).findLast(event => event.action === 'post_audit_done')?.metadata?.conclusion;
    const basisFor = entry => Object.fromEntries(Object.entries(conditionBasis(entry, { pastConclusion: pastConclusionFor(entry.group.groupId) }))
      .filter(([id]) => catalog.conditions[id]?.status !== 'disabled'));
    // 임원 검토 요약과 이상 표시에 쓰는 사실 목록: 모두 코드가 원본·기록에서 계산한다.
    const rates = rebateRates(data, period);
    const nameOf = id => data.agencies.find(row => row.agency_id === id)?.agency_name ?? id;
    const won = amount => new Intl.NumberFormat('ko-KR').format(amount) + '원';
    const pastAll = pastExceedances(original, data, period);
    const summaryFacts = entry => {
      const ids = entry.group.members.map(member => member.agencyId);
      const facts = [{ id: 'total', text: Number(period.slice(5)) + '월 합계 ' + won(entry.totalKrw) + ', 팀 승인 한도 ' + won(entry.limitKrw) +
        (entry.totalKrw > entry.limitKrw ? ', ' + won(entry.totalKrw - entry.limitKrw) + ' 초과' : '') }];
      const known = ids.filter(id => rates.byAgency.has(id));
      if (known.length) facts.push({ id: 'rate', text: known.map(id => nameOf(id) + ' 장려금률 ' + pct(rates.byAgency.get(id).rate)).join(', ') + ', 전체 평균 ' + pct(rates.mean) });
      const usual = known.filter(id => rates.byAgency.get(id).usual !== null);
      if (usual.length) facts.push({ id: 'usual', text: usual.map(id => nameOf(id) + ' 평소 ' + pct(rates.byAgency.get(id).usual)).join(', ') });
      const check = latestReplyCheck(entry)?.result;
      const asked = requestItems(eventsFor(entry.group.groupId), entry.group.groupId);
      if (check?.items?.length) facts.push({ id: 'reply', text: '거래처 답변 판정: ' + check.items.map(row => (asked.find(item => item.id === row.id)?.label ?? row.id) + ' ' + verdictLabels[row.verdict]).join(', ') });
      const outside = entry.collectionEvidence.flatMap(evidence => evidence.deposits.filter(row => evidence.registered.length &&
        !evidence.registered.some(owner => owner.agencyId === row.agencyId)));
      if (outside.length) facts.push({ id: 'deposit', text: [...new Set(outside.map(row => nameOf(row.agencyId)))].join(', ') + ' 다른 거래처 등록 계좌로 입금 ' + outside.length + '번' });
      const past = pastAll.find(row => row.groupId === entry.group.groupId);
      if (past) facts.push({ id: 'past', text: Number(past.months[0].period.slice(5)) + '~' + Number(past.months.at(-1).period.slice(5)) + '월 한도 초과분 ' + past.rowCount + '건 ' + won(past.totalKrw) + ' 팀 승인으로 지급' +
        (pastConclusionFor(entry.group.groupId) ? ', 지난 지급 점검 결론 ' + postAuditConclusions[pastConclusionFor(entry.group.groupId)] : '') });
      const payees = payeePlan(entry, eventsFor(entry.group.groupId), applyChanges(data, reviews).agencies).filter(row => row.status === 'mismatch');
      if (payees.length) facts.push({ id: 'payee', text: payees.map(row => nameOf(row.agencyId)).join(', ') + ' 답변 계좌가 등록 정산계좌와 다름' });
      return facts;
    };
    const factsKey = facts => facts.map(fact => fact.id + ':' + fact.text).join('|');
    const anomalyFacts = entries => entries.flatMap(entry => entry.group.members.length > 1 || entry.exceedsLimit ? [] : entry.group.members.flatMap(({ agencyId }) => {
      const flag = rateAnomaly(rates, agencyId);
      return flag ? [{ id: agencyId, text: nameOf(agencyId) + ' 장려금률 ' + flag.rate + ', 평소 ' + flag.usual + ', ' + flag.diff + ' 높음' }] : [];
    }));
    const conditionsKey = entry => summaryBasis(entry, latestReview(reviews, entry),
      eventsFor(entry.group.groupId).filter(event => !['post_audit', 'post_audit_done', 'condition_check'].includes(event.action)),
      saved.get(entry.group.groupId));
    const retainedIds = new Set(reviews.filter(review => review.details.scope.retained.length)
      .flatMap(review => review.details.scope.agencies));
    const retained = entry => entry.group.members.some(member => retainedIds.has(member.agencyId));
    const hasRecord = entry => rows.some(row => row.group_id === entry.group.groupId);
    const list = [...current.filter(entry => !retained(entry)), ...originalList.filter(entry =>
      retained(entry) || (hasRecord(entry) && !current.some(now => now.group.groupId === entry.group.groupId)))]
      .sort((a, b) => a.group.groupId.localeCompare(b.group.groupId));
    const continued = list.find(entry => entry.group.groupId === roleContext.case);
    const item = list.find(entry => entry.group.groupId === groupId);
    const dealer = request.headers.cookie?.match(/(?:^|;\s*)w07_dealer=(D-\d+)(?:;|$)/)?.[1];
    const agency = role === '대리점' && data.agencies.some(row => row.agency_id === dealer) ? dealer : null;
    if (role === '대리점' && (request.method === 'POST' && query.has('dealer') || !agency)) {
      const selectedDealer = query.get('dealer');
      if (request.method === 'POST') {
        if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) ||
            !data.agencies.some(row => row.agency_id === selectedDealer) || !/^D-\d+$/.test(selectedDealer ?? '')) return denied();
        response.writeHead(303, {
          Location: '/?' + new URLSearchParams({ period, view: 'agency-replies',
            ...(continued?.group.members.some(member => member.agencyId === selectedDealer)
              ? { group: continued.group.groupId } : {}) }),
          'Set-Cookie': 'w07_dealer=' + selectedDealer + '; Path=/; HttpOnly; Secure; SameSite=Lax',
          'Cache-Control': 'no-store',
        }).end();
        return;
      }
      return send(200, entryPage('대리점 포털 거래처 선택', '<p class="muted">실제 서비스에서는 거래처 계정으로 로그인해요. 시연용으로 거래처를 골라 주세요.</p><div class="role-cards">' + data.agencies.map(row =>
        '<form method="post" action="' + link({ ...roleContext, dealer: row.agency_id }) + '"><button style="min-height:56px"><strong>' +
        escape(row.agency_name) + '</strong><small>' + escape(row.agency_id) + '</small></button></form>').join('') + '</div>'));
    }
    if (request.method === 'GET' && !groupId && continued &&
        ((view === 'requests' && roleIndex <= 1) ||
         (view === 'accounting' && rows.some(row => row.group_id === caseId && row.created_at)) ||
         (view === 'agency-replies' && continued.group.members.some(member => member.agencyId === agency)))) {
      response.writeHead(303, {
        Location: '/?' + new URLSearchParams({ period, view, group: continued.group.groupId }),
        'Cache-Control': 'no-store',
      }).end();
      return;
    }
    const belongsToAgency = entry => entry && entry.group.members.some(member => member.agencyId === agency);
    if (agency && item && !belongsToAgency(item)) return denied();
    const documents = agency ? snapshot.documents.filter(row => row.agency_id === agency) : snapshot.documents;
    if (view === 'accounting' && groupId && !rows.some(row => row.group_id === groupId && row.created_at)) return denied();
    const caseContext = requestedCase && list.some(entry => entry.group.groupId === requestedCase && (!agency || belongsToAgency(entry)))
      ? { case: requestedCase } : {};
    if (groupId && !item) return send(404, '정산 요청을 찾을 수 없습니다.');
    const document = documents.find(row => String(row.id) === documentId);
    if (agency && documentId && !document) return denied();
    const redirect = (extras, hash = '') => {
      response.writeHead(303, { Location: '/?' + new URLSearchParams({ period, view, ...extras }) + hash }).end();
    };

    if (request.method === 'POST') {
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
        return send(403, '앱 화면에서 다시 시도해 주세요.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) return send(413, '입력 길이를 줄여 주세요.');
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const rawAction = form.get('action');
      const action = rawAction === 'decide' ? form.get('decision')
        : rawAction === 'payment_result' ? ([...form.keys()].filter(key => key.startsWith('result_')).some(key => form.get(key) === 'rejected') ? 'payment_returned' : 'payment_ok')
          : rawAction;
      let reason = (form.get('reason') ?? '').trim();
      const metadata = inputMetadata(form, period);
      // 지급 배치 번호: 가상 업무일 + 그날 순번 (예: B-20260708-01)
      const batchId = occurredOn => {
        const day = String(occurredOn ?? BASE_DATE).replace(/-/g, '');
        const used = new Set(events.map(event => event.metadata?.batch ?? event.metadata?.evidence?.reference?.match(/B-\d{8}-\d{2}/)?.[0]).filter(id => id?.startsWith('B-' + day)));
        return 'B-' + day + '-' + String(used.size + 1).padStart(2, '0');
      };
      if (['document_add', 'account_apply', 'group_confirm', 'condition_check', ...Object.keys(steps)].includes(action) && !metadata)
        return send(400, '업무 발생일, 적용일, 적용 정산월을 확인해 주세요.');
      if (['payment', 'condition_check'].includes(action)) {
        const evidence = paymentEvidence(form) ?? (action === 'payment' ? { reference: '지급 배치 ' + batchId(metadata?.occurredOn) + ' (모의)', finding: '승인 조건 확인 후 지급 시스템 반영(모의)' } : null);
        if (!evidence) return send(400, '확인한 자료의 이름과 확인 결과를 입력해 주세요.');
        metadata.evidence = evidence;
        reason = evidence.finding;
      }
      if (role === '대리점' && !['document_add', 'reply'].includes(action)) return denied();
      if (!open && action !== 'reset') return send(403, '원본에 미지급 건이 없는 정산월은 조회만 할 수 있습니다.');
      if (action === 'post_audit_done') {
        const target = pastExceedances(original, data, period).find(entry => entry.groupId === form.get('auditGroup'));
        if (!target) return send(404, '지난 지급 점검 대상을 찾을 수 없습니다.');
        if (role !== roles[2]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const conclusion = form.get('conclusion');
        if (!Object.hasOwn(postAuditConclusions, conclusion)) return send(400, '결론을 하나 골라 주세요.');
        if (!reason || reason.length > 1000) return send(400, '검토 의견을 1~1,000자로 입력해 주세요.');
        const error = await transaction(pool, period, async db => {
          const { rows: existing } = await db.query(`SELECT id FROM w07_event WHERE period=$1 AND group_id=$2
            AND action='post_audit_done'`, [period, target.groupId]);
          if (existing.length) return 409;
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
            [period, target.groupId, role, action, reason, { conclusion,
              masterCheck: eventsFor(target.groupId).findLast(event => event.action === 'audit_master_check')?.metadata?.result ?? 'unverified',
              months: target.months.map(month => month.period),
              rows: target.rowCount, totalKrw: target.totalKrw }]);
        });
        if (error) return send(error, '화면을 새로 열어 지난 지급 점검 상태를 확인해 주세요.');
        return redirect({ view: 'post-audit', audit: target.groupId });
      }
      if (action === 'audit_master_check') {
        const target = pastExceedances(original, data, period).find(entry => entry.groupId === form.get('auditGroup'));
        if (!target) return send(404, '지난 지급 점검 대상을 찾을 수 없습니다.');
        if (role !== roles[2]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const result = form.get('masterCheck');
        if (!Object.hasOwn(masterCheckResults, result) || !reason || reason.length > 1000) return send(400, '확인 결과와 근거를 입력해 주세요.');
        if (eventsFor(target.groupId).some(event => event.action === 'post_audit_done')) return send(409, '이미 결론이 났습니다.');
        await pool.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'audit_master_check',$4,$5)`,
          [period, target.groupId, role, reason, { result }]);
        return redirect({ view: 'post-audit', audit: target.groupId });
      }
      if (action === 'recovery_done') {
        if (role !== roles[0]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const target = pastExceedances(original, data, period).find(entry => entry.groupId === form.get('auditGroup'));
        const audited = target && eventsFor(target.groupId).findLast(event => event.action === 'post_audit_done');
        if (!audited || audited.metadata?.conclusion !== 'recovery') return send(409, '회수 검토 결론이 난 건만 처리할 수 있습니다.');
        if (eventsFor(target.groupId).some(event => event.action === 'recovery_done')) return send(409, '이미 처리했습니다.');
        if (!reason || reason.length > 1000) return send(400, '확인 내용을 1~1,000자로 입력해 주세요.');
        await pool.query(`INSERT INTO w07_event (period,group_id,role,action,reason) VALUES ($1,$2,$3,'recovery_done',$4)`,
          [period, target.groupId, role, reason]);
        return redirect({ view: 'post-audit', audit: target.groupId });
      }
      if (['catalog_add', 'catalog_status'].includes(action)) {
        if (role !== roles[4]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        if (action === 'catalog_add') {
          const label = (form.get('label') ?? '').replace(/\s+/g, ' ').trim();
          const kind = form.get('kind') === 'condition' ? 'condition' : 'item';
          const format = ['text', 'account', 'yesno'].includes(form.get('format')) ? form.get('format') : 'text';
          if (!label || label.length > 60) return send(400, '항목 이름을 1~60자로 입력해 주세요.');
          await pool.query(`INSERT INTO w07_catalog (id,kind,label,format,attachment,status) VALUES ($1,$2,$3,$4,$5,'active')`,
            ['c' + Date.now().toString(36), kind, label, kind === 'item' ? format : null, (form.get('attachment') ?? '').trim().slice(0, 40)]);
        } else {
          const id = form.get('id');
          const status = form.get('status');
          const known = Object.hasOwn(catalog.items, id) || Object.hasOwn(catalog.conditions, id);
          if (!known || !['active', 'disabled'].includes(status)) return send(400, '잘못된 요청입니다.');
          const kind = Object.hasOwn(catalog.conditions, id) ? 'condition' : 'item';
          const entry = catalog[kind === 'condition' ? 'conditions' : 'items'][id];
          await pool.query(`INSERT INTO w07_catalog (id,kind,label,format,attachment,status) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status`, [id, kind, entry.label, entry.format ?? null, entry.attachment ?? null, status]);
        }
        return redirect({ view: 'catalog' });
      }
      if (action === 'dispute_close') {
        if (role !== roles[4]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const target = form.get('disputeGroup');
        const open = events.filter(event => event.group_id === target && ['dispute', 'dispute_close'].includes(event.action)).at(-1);
        if (open?.action !== 'dispute') return send(409, '열린 이의 제기가 없습니다.');
        const result = form.get('result');
        if (!['kept', 'fixed'].includes(result) || !reason || reason.length > 1000) return send(400, '결과와 검토 내용을 입력해 주세요.');
        await pool.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'dispute_close',$4,$5)`,
          [period, target, role, reason, { result }]);
        return redirect({ view: 'catalog' }, '#disputes');
      }
      if (action === 'batch_result_ok') {
        if (role !== roles[2]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const ready = list.filter(entry => !entry.exceedsLimit && !isAffected(entry) && progressFor(entry).state === 'paymentReady' &&
          eventsFor(entry.group.groupId).findLast(event => event.action === 'payment')?.metadata?.batch);
        if (!ready.length) return send(409, '은행 회신을 기다리는 일괄 지급이 없습니다.');
        const updated = await transaction(pool, period, async db => {
          const latest = await db.query(`SELECT DISTINCT ON (group_id) group_id, id FROM w07_event
            WHERE period = $1 AND group_id = ANY($2::text[]) ORDER BY group_id, id DESC`,
          [period, ready.map(entry => entry.group.groupId)]);
          const revisions = new Map(latest.rows.map(row => [row.group_id, row.id]));
          if (ready.some(entry => revisions.get(entry.group.groupId) !== eventsFor(entry.group.groupId).at(-1)?.id)) return false;
          for (const entry of ready) {
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'payment_ok',$4,$5)`,
              [period, entry.group.groupId, role, '은행 회신(모의), 전부 지급', { ...(metadata ?? {}), mock: true,
                results: Object.fromEntries(entry.group.members.map(member => [member.agencyId, { result: 'success' }])) }]);
          }
          return true;
        });
        if (!updated) return send(409, '화면을 새로 열어 현재 처리 단계를 확인해 주세요.');
        return redirect({ view: 'accounting' });
      }
      if (action === 'batch_pay') {
        if (role !== roles[2]) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        const ready = list.filter(entry => {
          const record = saved.get(entry.group.groupId);
          return record?.action === 'approve' && record.created_at && !(record.conditions ?? []).length &&
            !entry.exceedsLimit && !isAffected(entry) && progressFor(entry).state === 'paymentPending';
        });
        if (!ready.length) return send(409, '반영할 팀 승인 건이 없습니다.');
        const batch = batchId(metadata?.occurredOn);
        const updated = await transaction(pool, period, async db => {
          const latest = await db.query(`SELECT DISTINCT ON (group_id) group_id, id FROM w07_event
            WHERE period = $1 AND group_id = ANY($2::text[]) ORDER BY group_id, id DESC`,
          [period, ready.map(entry => entry.group.groupId)]);
          const revisions = new Map(latest.rows.map(row => [row.group_id, row.id]));
          if (ready.some(entry => revisions.get(entry.group.groupId) !== eventsFor(entry.group.groupId).at(-1)?.id)) return false;
          for (const entry of ready) {
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'payment',$4,$5)`,
              [period, entry.group.groupId, role, '팀 승인 일괄 반영, ' + batch, { batch, mock: true,
                payees: payeePlan(entry, eventsFor(entry.group.groupId), applyChanges(data, reviews).agencies),
                evidence: { reference: '지급 배치 ' + batch + ' (모의)', finding: '팀 승인 ' + ready.length + '건 일괄 반영' } }]);
          }
          return true;
        });
        if (!updated) return send(409, '화면을 새로 열어 현재 처리 단계를 확인해 주세요.');
        return redirect({ view: 'accounting' });
      }
      if (['document_add', 'document_extract', 'document_timeout', 'document_confirm', 'group_confirm', 'account_apply', 'ai_draft', 'ai_items', 'ai_reply', 'ai_conditions', 'ai_summary', 'ai_anomaly'].includes(action)) {
        if (action === 'document_add' ? role !== '대리점' : ['ai_conditions', 'ai_summary'].includes(action) ? role !== roles[1] : role !== roles[0]) {
          return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        }
        if (action === 'document_add') {
          const info = applyChanges(data, reviews).agencies.find(row => row.agency_id === agency);
          const kind = form.get('kind');
          const typedAccount = kind === 'account' && form.has('bank_new') ? accountInput(form.get('bank_new'), form.get('acc_new'), form.get('holder_new') || '-') : null;
          if (typedAccount?.errors.length) return send(400, typedAccount.errors.join(' '));
          const newValue = typedAccount ? typedAccount.account : (form.get('newValue') ?? '').trim();
          const composed = info && ['account', 'address', 'representative'].includes(kind) && newValue && (form.get('why') ?? '').trim()
            ? ['등록 정보 변경 신청서 (' + { account: '정산계좌', address: '사업장 주소', representative: '대표자' }[kind] + ')',
              '거래처명: ' + info.agency_name + ' (' + agency + ')',
              '대표자: ' + (kind === 'representative' ? newValue : info.representative_name),
              '사업장 주소: ' + (kind === 'address' ? newValue : info.address),
              ...(kind === 'account' ? ['신규 정산계좌: ' + newValue] : []),
              '변경 사유: ' + form.get('why').trim(),
              ...(form.get('attachment')?.trim() ? ['첨부: ' + form.get('attachment').trim()] : []),
              '신청일: ' + metadata.occurredOn].join('\n') : '';
          const original = form.get('text')?.trim() || composed;
          if (form.get('agency') !== agency) return denied();
          if (!original || original.length > 6000 ||
              /[\u0000-\u0008\u000e-\u001f]/.test(original)) return send(400, '거래처와 텍스트를 확인해 주세요.');
          const id = await transaction(pool, period, async db => {
            const { rows: [saved] } = await db.query(
              'INSERT INTO w07_document (period,agency_id,original,metadata,received_at) VALUES ($1,$2,$3,$4,now()) RETURNING id', [period, agency, original, metadata]);
            const target = list.find(entry => entry.group.groupId === caseContext.case) ?? list.find(belongsToAgency);
            if (target) await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,agency_id,metadata)
              VALUES ($1,$2,$3,'document_received',$4,$5,$6)`,
              [period, target.group.groupId, role, '접수 번호 ' + saved.id, agency, metadata]);
            return saved.id;
          });
          return redirect({ view: 'documents', document: id, ...caseContext });
        }
        if (['document_extract', 'document_timeout', 'ai_draft', 'ai_items', 'ai_reply', 'ai_conditions', 'ai_summary', 'ai_anomaly'].includes(action)) {
          const kind = { ai_draft: 'draft', ai_items: 'items', ai_reply: 'reply_check', ai_conditions: 'conditions', ai_summary: 'review_summary', ai_anomaly: 'anomaly_note' }[action] ?? 'extract';
          const groupCall = !['extract', 'anomaly_note'].includes(kind);
          const draft = kind === 'draft';
          const decision = rows.find(row => row.group_id === groupId);
          const state = progressFor(item).state;
          const groupEvents = eventsFor(groupId);
          const reviewDecision = groupEvents.findLast(event => ['review_reject', 'review_clarify'].includes(event.action));
          const sent = groupEvents.findLast(event => ['send', 'resend'].includes(event.action));
          const answer = groupEvents.findLast(event => event.action === 'reply');
          const allowed = item ? basisFor(item) : {};
          const unavailable = {
            draft: () => !item || state !== 'draft',
            items: () => !item || state !== 'draft' || !Object.keys(itemBasis(item, activeItems)).length,
            reply_check: () => !item || state !== 'received' || !answer,
            conditions: () => !item || !Object.keys(allowed).length || !(item.exceedsLimit || isAffected(item)),
            review_summary: () => !item,
            anomaly_note: () => !anomalyFacts(list).length,
            extract: () => !document,
          }[kind]();
          if (unavailable) return send(409, '현재 단계에서 사용할 수 없습니다.');
          const timeoutCheck = action === 'document_timeout';
          if (timeoutCheck && !Object.values(documentSamples(data)).some(([, text]) => text === document.original)) {
            return send(400, '작성 양식으로 접수한 서류만 연결을 확인할 수 있습니다.');
          }
          const sharedDeposits = groupCall && item ? item.collectionEvidence.filter(entry =>
            new Set(entry.deposits.map(row => row.agencyId)).size > 1) : [];
          const agencyAccounts = new Map(applyChanges(data, reviews).agencies.map(row => [row.agency_id, row.bank_account_no]));
          const recipient = groupCall ? groupId : null;
          const recipientDeposits = sharedDeposits.filter(entry => entry.deposits.some(row => row.agencyId === recipient));
          const registration = agencyAccounts.get(recipient);
          const groupFacts = groupCall && item ? {
            agencies: item.group.members.map(member => member.agencyId),
            matches: item.group.links.map(entry => ({ agencies: entry.agencyIds, fields: entry.matchedFields.map(key => fields[key]) })),
            sharedDeposits: item.collectionEvidence.map(entry => ({
              agencies: [...new Set(entry.deposits.map(row => row.agencyId))] })),
          } : {};
          const input = {
            extract: () => ({ text: document.original }),
            review_summary: () => ({ facts: summaryFacts(item) }),
            anomaly_note: () => ({ facts: anomalyFacts(list) }),
            reply_check: () => {
              const asked = requestItems(groupEvents, groupId);
              return { criteria: asked.map(({ id, label, format, attachment }) => ({ id, label, format, attachment })),
                request: sent?.reason ?? '', reply: replyText(mergedAnswers(groupEvents), asked) };
            },
            items: () => ({ ...groupFacts,
              reason: reviewDecision?.reason || decision?.reason || latestReview(reviews, item)?.details.reason || '',
              allowed: Object.entries(itemBasis(item, activeItems)).map(([id, basis]) => ({ id, label: activeItems[id].label, basis })) }),
            conditions: () => ({ ...groupFacts,
              allowed: Object.entries(allowed).map(([id, basis]) => ({ id, label: conditionCatalog[id], basis })),
              replyCheck: (latestReplyCheck(item)?.result?.items ?? []).map(({ id, label, verdict }) => ({ id, label, verdict })) }),
            draft: () => ({ ...groupFacts,
              reason: reviewDecision?.reason || decision?.reason || latestReview(reviews, item)?.details.reason || '',
              recipient: { sharedDeposit: recipientDeposits.length > 0, registrationDiffers: Boolean(registration) &&
                registration !== 'NONE' && recipientDeposits.some(entry => entry.account !== registration) } }),
          }[kind]();
          const callId = await transaction(pool, period, async db => {
            const keys = [period, groupCall || !document ? null : document.id, groupCall ? groupId : null, kind];
            const pending = await db.query(`SELECT id FROM w07_ai_call WHERE period=$1 AND archived_at IS NULL
              AND document_id IS NOT DISTINCT FROM $2::bigint AND group_id IS NOT DISTINCT FROM $3::text
              AND kind=$4 AND finished_at IS NULL AND created_at > now() - interval '30 seconds'`, keys);
            if (pending.rowCount) return null;
            const { rows: [saved] } = await db.query(`INSERT INTO w07_ai_call (period,document_id,group_id,kind)
              VALUES ($1,$2,$3,$4) RETURNING id`, keys);
            return saved.id;
          });
          if (callId) {
            const output = await assistant(kind, input, timeoutCheck ? { timeout: 1 } : undefined);
            const result = !output.result ? null
              : kind === 'reply_check' ? withRecipients(output.result, groupEvents)
              : kind === 'review_summary' ? { ...output.result, basis: factsKey(input.facts) }
              : kind === 'anomaly_note' ? { ...output.result, basis: factsKey(input.facts) }
                : kind === 'conditions' ? { ...output.result, basis: conditionsKey(item) } : output.result;
            await pool.query('UPDATE w07_ai_call SET request=$2,raw=$3,result=$4,finished_at=now() WHERE id=$1',
              [callId, JSON.stringify(output.request), JSON.stringify(output.raw ?? null), result]);
            if (kind === 'items' && result?.newItem && !Object.values(catalog.items).some(entry => entry.label === result.newItem)) {
              await pool.query(`INSERT INTO w07_catalog (id,kind,label,format,status) VALUES ($1,'item',$2,'text','proposed')
                ON CONFLICT DO NOTHING`, ['p' + callId, result.newItem]);
            }
          }
          return redirect(kind === 'anomaly_note' ? { view: 'requests', group: '' } : groupCall ? { group: groupId } : { view: 'documents', document: document.id, ...caseContext });
        }
        if (!document) return send(404, '접수 서류를 찾을 수 없습니다.');
        const error = await transaction(pool, period, async db => {
          const { rows: [stored] } = await db.query('SELECT * FROM w07_document WHERE id=$1 AND period=$2', [document.id, period]);
          if (!stored || stored.applied) return 409;
          if (action === 'document_confirm') {
            if (!reason || reason.length > 1000) return 400;
            const { rows: [latest] } = await db.query(`SELECT result FROM w07_ai_call
              WHERE document_id=$1 AND kind='extract' ORDER BY id DESC LIMIT 1`, [stored.id]);
            const confirmed = { reason };
            for (const key of Object.keys(fields)) {
              const decision = form.get(key + '_decision');
              const value = form.get(key)?.trim();
              if (!['accept', 'edit', 'reject'].includes(decision)) return 400;
              if (decision !== 'reject' && (!value || value.length > 200)) return 400;
              if (decision === 'accept' && !latest?.result?.[key]?.candidates.some(candidate => candidate.value === value)) return 400;
              confirmed[key] = { decision, value: decision === 'reject' ? null : value };
            }
            await db.query('UPDATE w07_document SET confirmed=$2 WHERE id=$1', [stored.id, confirmed]);
            return;
          }
          if (!stored.confirmed || !Object.keys(fields).some(key => stored.confirmed[key]?.value)) return 409;
          const { rows: changes } = await db.query('SELECT * FROM w07_review WHERE period=$1 ORDER BY id', [period]);
          const prior = applyChanges(data, changes);
          const agency = prior.agencies.find(row => row.agency_id === stored.agency_id);
          const account = stored.confirmed.bank_account_no?.value;
          const kind = action === 'account_apply' ? 'change' : 'group';
          if (kind === 'change' && (!account || account === agency.bank_account_no)) return 409;
          const after = kind === 'change' ? applyChanges(prior, [
            { kind, agency_id: agency.agency_id, details: { afterAccount: account } },
          ]) : prior;
          const scope = reviewScope(data, period, calculate(prior), calculate(after), agency.agency_id);
          if (kind === 'group' && scope.agencies.length < 2) return 409;
          const details = { scope, metadata, reason: stored.confirmed.reason,
            ...(kind === 'change' ? { beforeAccount: agency.bank_account_no, afterAccount: account } : {}) };
          const inserted = await db.query(`INSERT INTO w07_review (period,agency_id,document_id,kind,details)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [period, agency.agency_id, stored.id, kind, details]);
          if (!inserted.rowCount) return 409;
          if (kind === 'change') {
            await db.query('UPDATE w07_document SET applied=true WHERE id=$1', [stored.id]);
            const target = list.find(entry => entry.group.members.some(member => member.agencyId === stored.agency_id));
            if (target) await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,agency_id,metadata)
              VALUES ($1,$2,$3,'account_changed',$4,$5,$6)`,
              [period, target.group.groupId, role, '접수 번호 ' + stored.id + ', ' + stored.confirmed.reason, stored.agency_id, metadata]);
          }
        });
        if (error) return send(error, '확인 값과 현재 처리 단계를 다시 확인해 주세요.');
        return action === 'document_confirm'
          ? redirect({ view: 'documents', document: document.id, ...caseContext }, '#document-confirmation')
          : redirect({ view: 'review', ...caseContext });
      }
      if (!item && !['reset', 'bulk_approve', 'bulk_hold', 'bulk_reject'].includes(action)) return send(400, '잘못된 요청입니다.');
      if (action === 'reset' && role !== roles[4]) return send(403, '초기화는 관리자만 할 수 있습니다.');
      const error = await transaction(pool, period, async db => {
        if (action === 'reset') {
          if (role !== roles[4]) return 403;
          if (form.get('confirm') !== period + ' 초기화') return 400;
          await db.query('UPDATE w07_ai_call SET archived_at = now(), document_id = NULL WHERE period = $1 AND archived_at IS NULL', [period]);
          await db.query('DELETE FROM w07_review WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_document WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_event WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_decision WHERE period = $1', [period]);
          return;
        }
        const { rows: currentReviews } = await db.query('SELECT * FROM w07_review WHERE period=$1 ORDER BY id', [period]);
        if (['bulk_hold', 'bulk_reject'].includes(action)) {
          if (role !== roles[0]) return 403;
          const picked = [...new Set(form.getAll('request'))];
          if (!picked.length) return { status: 400, message: '보류하거나 반려할 건을 골라 주세요.' };
          if (action === 'bulk_reject' && !reason) return { status: 400, message: '반려 사유를 적어 주세요. 거래처 담당 영업에게 그대로 전달돼요.' };
          const { rows: currentDecisions } = await db.query('SELECT group_id FROM w07_decision WHERE period=$1', [period]);
          const { rows: teamEvents } = await db.query("SELECT group_id, action FROM w07_event WHERE period=$1 AND action IN ('team_hold','team_reject','team_release') ORDER BY id", [period]);
          for (const id of picked) {
            const target = originalList.find(entry => entry.group.groupId === id);
            const last = teamEvents.filter(event => event.group_id === id).at(-1)?.action;
            if (!target || target.exceedsLimit || approverOf(target) !== roles[0] || currentDecisions.some(row => row.group_id === id) || last === 'team_reject') return 409;
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
              [period, id, role, action === 'bulk_hold' ? 'team_hold' : 'team_reject', reason || '보류', metadata]);
          }
          return;
        }
        if (action === 'bulk_approve') {
          const { rows: currentDecisions } = await db.query('SELECT group_id FROM w07_decision WHERE period=$1', [period]);
          const { rows: teamEvents } = await db.query("SELECT group_id, action FROM w07_event WHERE period=$1 AND action IN ('team_hold','team_reject','team_release') ORDER BY id", [period]);
          const parked = form.getAll('request').filter(id => ['team_hold', 'team_reject'].includes(teamEvents.filter(event => event.group_id === id).at(-1)?.action));
          if (parked.length) return { status: 409, message: '보류나 반려한 건은 바로 승인할 수 없어요. 보류를 먼저 풀어 주세요.' };
          return approveSupportRequests({
            role, ids: form.getAll('request'), requests: originalList.map(entry => ({ ...entry, approver: approverOf(entry) })),
            savedIds: new Set(currentDecisions.map(row => row.group_id)),
            affected: new Set(currentReviews.flatMap(review => review.details.scope.agencies)),
            approve: id => saveDecision(db, period, id, role, 'approve', '', [], { ...decisionSnapshot(originalList.find(entry => entry.group.groupId === id)), occurredOn: metadata?.occurredOn }),
          });
        }
        const review = latestReview(currentReviews, item);
        if (review?.id !== latestReview(reviews, item)?.id) return 409;
        const ids = [period, groupId];
        const { rows: [record] } = await db.query(`SELECT d.*, t.created_at FROM w07_decision d
          LEFT JOIN w07_accounting_task t USING (period, group_id) WHERE d.period = $1 AND d.group_id = $2`, ids);
        const { rows: currentEvents } = await db.query(`SELECT * FROM w07_event
          WHERE period = $1 AND group_id = $2 ORDER BY id`, ids);
        const recipient = currentEvents.findLast(event => ['send', 'resend'].includes(event.action));
        const currentItems = requestItems(currentEvents, groupId);
        if (action === 'reply' && (!recipient || !recipientsOf(currentEvents, groupId).includes(agency))) return 403;
        if (['dispute', 'remind', 'ack', 'team_release'].includes(action)) {
          if (role !== roles[0]) return 403;
          if (action === 'team_release') {
            if (currentEvents.filter(event => ['team_hold', 'team_reject', 'team_release'].includes(event.action)).at(-1)?.action !== 'team_hold') return 409;
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'team_release',$4,$5)`,
              [period, groupId, role, reason || '보류 해제', metadata]);
            return;
          }
          if (action === 'dispute') {
            const last = currentEvents.filter(event => ['dispute', 'dispute_close'].includes(event.action)).at(-1);
            if (last?.action === 'dispute') return 409;
            const kind = ['not_same', 'changed', 'other'].includes(form.get('disputeKind')) ? form.get('disputeKind') : null;
            if (!kind || !reason || reason.length > 1000) return 400;
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,'dispute',$4,$5)`,
              [...[period, groupId], role, reason, { kind }]);
            return;
          }
          if (action === 'ack') {
            const key = form.get('key');
            if (!['deposit', 'past'].includes(key)) return 400;
            const done = currentEvents.some(event => event.action === 'ack' && event.metadata?.key === key);
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
              [period, groupId, role, done ? 'unack' : 'ack', done ? '확인 취소' : '확인함', { key }]);
            return;
          }
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason) VALUES ($1,$2,$3,'remind',$4)`,
            [period, groupId, role, '영업임원에게 다시 알림']);
          return;
        }
        const latest = currentEvents.at(-1);
        if (action !== 'reply' && form.get('revision') !== String(latest?.id ?? '0')) return 409;
        const { state, held } = requestProgress(record, currentEvents, item.exceedsLimit, review);
        if (action === 'condition_check') {
          if (role !== roles[2]) return 403;
          if (state !== 'paymentPending') return 409;
          const condition = form.get('condition');
          if (!(record?.conditions ?? []).includes(condition)) return 400;
          if (confirmedConditions(record, currentEvents).has(condition)) return 409;
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata)
            VALUES ($1,$2,$3,'condition_check',$4,$5)`, [...ids, role, reason, { ...metadata, condition }]);
          return;
        }
        const agencyNamesFor = agencyId => data.agencies.find(row => row.agency_id === agencyId)?.agency_name ?? agencyId;
        if (['payee_resolve', 'payee_change_request'].includes(action)) {
          if (role !== roles[2]) return 403;
          if (!['paymentPending', 'repayReady'].includes(state)) return 409;
          const target = form.get('agencyId');
          const payee = payeePlan(item, currentEvents, applyChanges(data, currentReviews).agencies).find(row => row.agencyId === target);
          if (!payee || payee.status !== 'mismatch') return 409;
          if (action === 'payee_resolve' && !reason) return { status: 400, message: '등록 계좌로 지급하는 이유를 적어 주세요.' };
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,agency_id,metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...ids, role, action,
            reason || agencyNamesFor(target) + ' 정산계좌 변경 신청 요청', target, { ...metadata, agencyId: target }]);
          return;
        }
        if (action === 'payment') {
          const confirmed = confirmedConditions(record, currentEvents);
          const missing = (record?.conditions ?? []).filter(condition => !confirmed.has(condition));
          if (missing.length) return { status: 409, message: '아직 확인하지 않은 승인 조건이 있어요: ' + missing.map(id => conditionCatalog[id] ?? id).join(', ') };
          const payees = payeePlan(item, currentEvents, applyChanges(data, currentReviews).agencies);
          const blocked = payees.filter(row => row.status === 'mismatch');
          if (blocked.length) return { status: 422, message: blocked.map(row => agencyNamesFor(row.agencyId)).join(', ') +
            '의 받을 계좌가 등록 정산계좌와 달라요. 등록 계좌로 지급할지, 변경 요청을 보낼지 먼저 골라 주세요.' };
          metadata.payees = payees;
        }
        if (Object.hasOwn(decisions, action)) {
          if (role !== (held ? '영업임원' : approverOf(item))) return 403;
          if (reason.length > 1000 || (action !== 'approve' && !reason)) return 400;
          const allowed = Object.keys(basisFor(item));
          const conditions = action === 'approve' && role === roles[1] ? [...new Set(form.getAll('condition'))] : [];
          if (conditions.some(condition => !allowed.includes(condition))) return 400;
          if (held) {
            if (state !== 'resubmitted') return 409;
            if (action === 'approve') {
              if (!record) await saveDecision(db, period, groupId, role, action, reason, conditions, { ...decisionSnapshot(item), occurredOn: metadata?.occurredOn });
              else if (record.action !== 'approve') {
                await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,acted_at,metadata)
                  VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...ids, record.role, record.action, record.reason, record.acted_at, { occurredOn: record.snapshot?.occurredOn ?? null }]);
                await db.query(`UPDATE w07_decision SET role=$3, action='approve', reason=$4, acted_at=now(), snapshot=$5
                  WHERE period=$1 AND group_id=$2`, [...ids, role, reason, decisionSnapshot(item)]);
                await db.query('INSERT INTO w07_accounting_task (period,group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', ids);
              }
              if (record) await db.query('UPDATE w07_decision SET conditions=$3 WHERE period=$1 AND group_id=$2', [...ids, JSON.stringify(conditions)]);
            }
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,review_id)
              VALUES ($1,$2,$3,$4,$5,$6)`, [...ids, role, 'review_' + action, reason, review.id]);
            return;
          }
          if (record) return 409;
          await saveDecision(db, period, groupId, role, action, reason, conditions, { ...decisionSnapshot(item), occurredOn: metadata?.occurredOn });
          return;
        }
        let stepMetadata = {};
        if (action === 'send' && state === 'draft' && role === roles[0]) {
          const ids = [...new Set(form.getAll('item'))].filter(id => Object.hasOwn(activeItems, id));
          const chosen = buildRequestItems(ids, form.get('customItem'), { items: activeItems }, item);
          const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(form.get('dueDate') ?? '') ? form.get('dueDate') : null;
          if (!chosen.length || !dueDate) return 400;
          const proposal = calls.filter(call => call.kind === 'items' && call.group_id === groupId && call.result).at(-1);
          const proposed = proposal?.result.items.map(row => row.id) ?? [];
          stepMetadata = { items: chosen, dueDate, ...(proposal ? { ai: { callId: String(proposal.id), proposed,
            agreed: proposed.length === ids.length && proposed.every(id => ids.includes(id)) && !form.get('customItem')?.trim() } } : {}) };
          const message = reason;
          reason = '확인 항목: ' + chosen.map((row, index) => (index + 1) + ') ' + row.label).join(' ') + ', 기한 ' + dueDate +
            (message ? '\n' + message : '');
        }
        if (action === 'resend' && state === 'received' && role === roles[0]) {
          const answerEvent = currentEvents.findLast(event => event.action === 'reply');
          const { rows: [lastCheck] } = await db.query(`SELECT result FROM w07_ai_call WHERE period=$1 AND archived_at IS NULL AND group_id=$2
            AND kind='reply_check' AND result->>'replyId' = $3 ORDER BY id DESC LIMIT 1`, [period, groupId, String(answerEvent?.id)]);
          const picked = form.getAll('target').map(value => String(value).split(':'));
          const narrowed = form.get('picked') === '1'
            ? currentItems.map(item => ({ ...item, recipients: item.recipients.filter(agencyId =>
              picked.some(([itemId, target]) => itemId === item.id && target === agencyId)) })).filter(item => item.recipients.length)
            : resendItems(currentItems, mergedAnswers(currentEvents), lastCheck?.result?.items ?? []);
          if (!narrowed.length) return { status: 400, message: '보완 요청을 보낼 거래처를 하나 이상 골라 주세요.' };
          const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(form.get('dueDate') ?? '') ? form.get('dueDate') : recipient?.metadata?.dueDate ?? null;
          stepMetadata = { items: narrowed, dueDate };
          reason = reason || resendText(narrowed);
        }
        if (action === 'reply' && role === roles[3]) {
          const mine = currentItems.filter(row => row.recipients.includes(agency));
          const composed = composeReply(form, mine);
          if (composed.errors.length) return { status: 400, message: composed.errors.join(' ') };
          if (!composed.text) return { status: 400, message: '답변할 항목을 하나 이상 입력해 주세요.' };
          reason = composed.text;
          stepMetadata = { answers: composed.answers };
        }
        if (action === 'verify' && !reason) reason = '거래처 답변 확인 완료';
        if (['payment_ok', 'payment_returned'].includes(action)) {
          const reasons = { holder: '예금주 불일치', closed: '계좌 해지 또는 없음', other: '기타' };
          const results = {};
          for (const { agencyId } of item.group.members) {
            const result = form.get('result_' + agencyId);
            if (!['success', 'rejected'].includes(result)) return 400;
            const why = form.get('why_' + agencyId);
            if (result === 'rejected' && !Object.hasOwn(reasons, why)) return 400;
            results[agencyId] = result === 'rejected' ? { result, reason: reasons[why], note: (form.get('note_' + agencyId) ?? '').trim().slice(0, 200) } : { result };
          }
          stepMetadata = { results, mock: true };
          const rejected = Object.entries(results).filter(([, row]) => row.result === 'rejected');
          reason = rejected.length ? '은행 회신(모의), 반려 ' + rejected.map(([id, row]) => id + ' ' + row.reason).join(', ') : '은행 회신(모의), 전부 지급';
        }
        if (action === 'payment' && state === 'repayReady') {
          const returned = currentEvents.findLast(event => event.action === 'payment_returned');
          stepMetadata = { repay: Object.entries(returned?.metadata?.results ?? {}).filter(([, row]) => row.result === 'rejected').map(([id]) => id) };
          reason = '반려분 재지급 반영, ' + stepMetadata.repay.join(', ');
        }
        const invalid = followupError(action, state, role, reason);
        if (invalid) return invalid;
        if (action === 'resubmit' && !held) {
          await db.query(`INSERT INTO w07_event (period, group_id, role, action, reason, acted_at, metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...ids, record.role, record.action, record.reason, record.acted_at, { occurredOn: record.snapshot?.occurredOn ?? null }]);
          await db.query('DELETE FROM w07_decision WHERE period = $1 AND group_id = $2', ids);
        }
        let eventMetadata = { ...metadata, ...stepMetadata };
        if (['resend', 'verify'].includes(action)) {
          const answer = currentEvents.findLast(event => event.action === 'reply');
          const { rows: [check] } = await db.query(`SELECT id, result FROM w07_ai_call WHERE period=$1 AND archived_at IS NULL AND group_id=$2
            AND kind='reply_check' AND result->>'replyId' = $3 ORDER BY id DESC LIMIT 1`, [...ids, String(answer?.id)]);
          if (check?.result?.items) {
            eventMetadata = { ...eventMetadata, ai: { callId: String(check.id), recommendation: check.result.recommendation,
              agreed: check.result.recommendation === action,
              unmet: check.result.items.filter(entry => entry.verdict !== 'met').map(({ label, verdict }) => ({ label, verdict })) } };
          }
        }
        await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,review_id,agency_id,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [...ids, role, action, reason, review?.id ?? null,
            action === 'reply' ? agency : null, eventMetadata]);
        if (action === 'verify' && form.get('resubmit') === '1') {
          if (!held) {
            await db.query(`INSERT INTO w07_event (period, group_id, role, action, reason, acted_at, metadata)
              VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...ids, record.role, record.action, record.reason, record.acted_at, { occurredOn: record.snapshot?.occurredOn ?? null }]);
            await db.query('DELETE FROM w07_decision WHERE period = $1 AND group_id = $2', ids);
          }
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,review_id,metadata)
            VALUES ($1,$2,$3,'resubmit',$4,$5,$6)`, [...ids, role, '임원에게 다시 올림', review?.id ?? null, metadata]);
        }
      });
      if (error?.status) return send(error.status, error.message);
      if (error) return send(error, {
        400: '필요한 내용이나 사유를 1~1,000자로 입력해 주세요.',
        403: '현재 업무 역할에 해당 작업 권한이 없습니다.',
        422: '거래처가 답한 받을 계좌가 등록 정산계좌와 달라요. 정산계좌 변경 신청을 먼저 확인하고 적용해 주세요.',
        409: '화면을 새로 열어 현재 처리 단계를 확인해 주세요.',
      }[error]);
      const next = new URLSearchParams({ period, view, ...(item && action !== 'reset' ? { group: groupId } : {}) });
      response.writeHead(303, { Location: '/?' + next.toString() + (item && action !== 'reset' ? '#current-task' : '') }).end();
      return;
    }

    const stateFor = entry => progressFor(entry).state;
    const agencyNames = new Map(data.agencies.map(row => [row.agency_id, row.agency_name]));
    const changedData = applyChanges(data, reviews);
    const auditEvents = id => eventsFor(id);
    const past = (open ? pastExceedances(original, data, period) : []).map(entry => {
      const done = auditEvents(entry.groupId).findLast(event => event.action === 'post_audit_done');
      const check = auditEvents(entry.groupId).findLast(event => event.action === 'audit_master_check');
      return { ...entry, conclusion: done?.metadata?.conclusion ?? null, doneAt: done?.acted_at, opinion: done?.reason,
        masterCheck: check?.metadata?.result ?? null, masterCheckNote: check?.reason ?? '', masterCheckOn: check?.metadata?.occurredOn ?? (check ? time(check.acted_at) : ''), doneOn: done?.metadata?.occurredOn ?? '', concludedUnverified: done?.metadata?.masterCheck === 'unverified',
        recoveryDone: auditEvents(entry.groupId).findLast(event => event.action === 'recovery_done') ?? null };
    });
    const decisionReason = entry => {
      const id = entry.group.groupId;
      const record = saved.get(id);
      const history = eventsFor(id);
      const archived = history.findLast(event => ['reject', 'clarify', 'review_reject', 'review_clarify'].includes(event.action) && event.reason);
      return (record && ['reject', 'clarify'].includes(record.action) ? record.reason : '') || archived?.reason ||
        latestReview(reviews, entry)?.details.reason || '';
    };
    // 지난 결정 업무일: 결정 기록이나 보관된 결정 이벤트에 남긴 가상 업무일
    const decisionDate = entry => {
      const id = entry.group.groupId;
      const record = saved.get(id);
      if (record && ['reject', 'clarify'].includes(record.action)) return record.snapshot?.occurredOn ?? '';
      return eventsFor(id).findLast(event => ['reject', 'clarify', 'review_reject', 'review_clarify'].includes(event.action))?.metadata?.occurredOn ?? '';
    };
    const execDue = entry => isAffected(entry) ? stateFor(entry) === 'resubmitted' : (entry.exceedsLimit || precheck.has(entry.group.groupId)) && !saved.has(entry.group.groupId);
    // 가상 업무일: 기준일 2026-07-01부터 시작해 이 정산월 기록의 마지막 업무 발생일을 이어받는다(실제 오늘 날짜를 쓰지 않음).
    const businessDate = [BASE_DATE, ...events.map(event => event.metadata?.occurredOn), ...snapshot.documents.map(row => row.metadata?.occurredOn)]
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')).sort().at(-1);
    const c = {
      businessDate, role, roles, roleIndex, period, periods, open, view, query, data, list, saved, events, eventsFor, stateFor, isAffected,
      calls, reviews, catalog, activeItems, item, groupId, agency, document, past, agencyNames,
      documents, allDocuments: snapshot.documents, allEvents: snapshot.allEvents ?? events,
      link: extras => link(extras), isOpenPeriod: month => isOpenPeriod(data.rebates, month),
      precheck, teamState, selectable: entry => open && approverOf(entry) === roles[0] && !entry.exceedsLimit && !isAffected(entry) && !saved.has(entry.group.groupId) && !teamState(entry),
      decisionReason, decisionDate, execDue, latestReplyCheck, basisFor, pastConclusion: pastConclusionFor,
      itemBasis: entry => itemBasis(entry, activeItems),
      previousMetadata: entry => eventsFor(entry.group.groupId).findLast(event => event.metadata?.occurredOn)?.metadata,
      conditionCall: entry => {
        const latest = calls.filter(call => call.kind === 'conditions' && call.group_id === entry.group.groupId).at(-1);
        return latest && (!latest.finished_at || !latest.result || latest.result.basis === conditionsKey(entry)) ? latest : null;
      },
      summaryFacts,
      summaryCall: entry => {
        const latest = calls.filter(call => call.kind === 'review_summary' && call.group_id === entry.group.groupId).at(-1);
        return latest && (!latest.finished_at || !latest.result || latest.result.basis === factsKey(summaryFacts(entry))) ? latest : null;
      },
      anomalies: () => anomalyFacts(list),
      anomalyCall: () => {
        const latest = calls.filter(call => call.kind === 'anomaly_note').at(-1);
        return latest && (!latest.finished_at || !latest.result || latest.result.basis === factsKey(anomalyFacts(list))) ? latest : null;
      },
      recipientsFor: entry => recipientsOf(eventsFor(entry.group.groupId), entry.group.groupId),
      currentAgency: id => changedData.agencies.find(row => row.agency_id === id),
      catalogLabel: id => catalog.items[id]?.label ?? id,
      payees: entry => payeePlan(entry, eventsFor(entry.group.groupId), changedData.agencies),
    };
    const h = screens.helpers(c);
    let content;
    let title;
    if (role === roles[0]) {
      if (view === 'requests') [title, content] = item ? ['요청 상세', open ? screens.supportDetail(c, h) : screens.pastMonthDetail(c, h)] : ['승인 요청', screens.supportList(c, h)];
      else if (view === 'followup') {
        const state = item && stateFor(item);
        [title, content] = item && state === 'draft' && open ? ['확인 요청', screens.composeRequest(c, h)]
          : item && ['waiting', 'received', 'verified'].includes(state) ? ['답변 검토', screens.replyReview(c, h)]
            : item ? ['요청 상세', screens.supportDetail(c, h)] : ['거래처 확인', screens.followupList(c, h)];
      } else if (view === 'documents') [title, content] = document ? ['서류 확인', screens.documentDetail(c, h)] : ['서류 확인', screens.documentList(c, h)];
      else if (view === 'review') [title, content] = ['정보 변경', screens.reviewList(c, h)];
      else if (view === 'post-audit') [title, content] = ['지난 지급 점검', screens.postAudit(c, h)];
      else [title, content] = ['AI 사용 기록', screens.aiLog(c, h)];
    } else if (role === roles[1]) {
      if (view === 'post-audit') [title, content] = ['지난 지급 점검', screens.postAudit(c, h)];
      else if (view === 'ai-log') [title, content] = ['AI 사용 기록', screens.aiLog(c, h)];
      else [title, content] = item ? ['결정', screens.execDecision(c, h)] : ['결정할 요청', screens.execList(c, h)];
    } else if (role === roles[2]) {
      if (view === 'post-audit') [title, content] = ['지난 지급 점검', screens.postAudit(c, h)];
      else if (view === 'ai-log') [title, content] = ['AI 사용 기록', screens.aiLog(c, h)];
      else if (item && saved.get(groupId)?.created_at) [title, content] = ['지급 검토', screens.accountingDetail(c, h)];
      else [title, content] = ['지급 검토', screens.accountingList(c, h)];
    } else if (role === roles[3]) {
      if (view === 'documents') [title, content] = ['서류', screens.dealerDocs(c, h)];
      else if (item && c.recipientsFor(item).includes(agency) && eventsFor(groupId).some(event => ['send', 'resend'].includes(event.action))) [title, content] = ['확인 요청', screens.dealerReply(c, h)];
      else [title, content] = ['홈', screens.dealerHome(c, h)];
    } else {
      [title, content] = view === 'catalog' ? ['확인 항목 목록', screens.catalogAdmin(c, h)] : ['AI 사용 기록', screens.aiLog(c, h)];
    }

    const countOf = key => ({
      requests: role === roles[1] ? list.filter(execDue).length : list.filter(c.selectable).length,
      followup: list.filter(entry => ['draft', 'received', 'verified'].includes(stateFor(entry))).length,
      documents: role === roles[3] ? null : documents.filter(row => !row.applied).length,
      review: reviews.filter(review => !events.some(event => event.review_id === review.id && event.action === 'review_approve')).length,
      'post-audit': past.filter(row => !row.conclusion).length,
      accounting: list.filter(entry => saved.get(entry.group.groupId)?.created_at && ['paymentPending', 'paymentReady', 'repayReady'].includes(stateFor(entry))).length,
      'agency-replies': role === roles[3] ? list.filter(entry => belongsToAgency(entry) && c.recipientsFor(entry).includes(agency) && stateFor(entry) === 'waiting').length : null,
      'ai-log': null, home: null, catalog: catalog.items && Object.values(catalog.items).filter(row => row.status === 'proposed').length || null,
    })[key];
    const menuLabels = { home: '홈', requests: role === roles[1] ? '결정할 요청' : '승인 요청', followup: '거래처 확인 <small>(소명)</small>', documents: role === roles[3] ? '서류' : '서류 확인',
      review: '정보 변경', 'post-audit': '지난 지급 점검 <small>(사후 검토)</small>', accounting: '지급 검토', 'agency-replies': '홈', 'ai-log': 'AI 사용 기록', catalog: '확인 항목 목록' };
    const nav = roleViews[roleIndex].map(key => [link({ view: key }), menuLabels[key], countOf(key),
      key === view || (key === 'agency-replies' && view === 'agency-replies')]);
    const subtitle = role === roles[3] ? agencyNames.get(agency) + ' 대리점' : 'Corevia ' + role;
    let notifications = null;
    if (role === roles[0]) {
      notifications = events.filter(event => ['reply', 'dispute_close', 'post_audit_done', 'review_reject', 'review_clarify', 'document_received'].includes(event.action))
        .concat(rows.filter(row => ['reject', 'clarify'].includes(row.action)).map(row => ({ ...row, action: row.action, group_id: row.group_id })))
        .sort((a, b) => new Date(b.acted_at) - new Date(a.acted_at)).slice(0, 6).map(event => {
          const entry = list.find(candidate => candidate.group.groupId === event.group_id);
          const name = entry ? h.title(entry) : agencyNames.get(event.group_id) ?? event.group_id;
          const text = { reply: name + ' 답변 도착', dispute_close: name + ' 이의 제기 처리됨', post_audit_done: name + ' 지난 지급 점검 결론',
            review_reject: name + ' 임원 재검토 거절', review_clarify: name + ' 임원 추가 확인 요청', document_received: name + ' 서류 접수',
            reject: name + ' 임원 거절', clarify: name + ' 임원 추가 확인 요청' }[event.action];
          const href = { reply: link({ view: 'followup', group: event.group_id }), post_audit_done: link({ view: 'post-audit', audit: event.group_id }),
            document_received: link({ view: 'documents' }) }[event.action] ?? link({ view: 'requests', group: event.group_id });
          return [href, escape(text), time(event.acted_at)];
        });
    } else if (role === roles[1]) {
      notifications = events.filter(event => ['resubmit', 'remind'].includes(event.action)).slice(-5).reverse().map(event => {
        const entry = list.find(candidate => candidate.group.groupId === event.group_id);
        return [link({ view: 'requests', group: event.group_id }), escape((entry ? h.title(entry) : event.group_id) + (event.action === 'remind' ? ' 결정 요청 알림' : ' 다시 올라옴')), time(event.acted_at)];
      });
    }
    const flash = { sent: '보냈어요', saved: '저장했어요' }[query.get('done')];
    send(200, shell({ title, subtitle, nav, role, period,
      roleLink: '/?' + new URLSearchParams({ view: 'roles', period,
        ...(item || continued ? { case: (item ?? continued).group.groupId } : {}) }), periods, periodLink: view, wide: ['requests', 'ai-log', 'catalog'].includes(view) && !item,
      notifications, content: (flash ? '<p class="flash" role="status">' + flash + '</p>' : '') + content }));
  };
}
