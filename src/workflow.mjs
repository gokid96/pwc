import { inputMetadata, metadataFields, metadataView, paymentEvidence, summaryBasis, newestFirstEvents } from './audit.mjs';
import { steps, labels, requestProgress, followupError } from './followup.mjs';
import { applyChanges, callAssistant, documentSamples, fields, individualExceedance, isOpenPeriod, reviewScope } from './condition.mjs';
import { conditionBasis, conditionCatalog, confirmedConditions, pastExceedances, recommendationLabels, replyCriteria, verdictLabels } from './controls.mjs';
import { aiLog, documentView, reviewView } from './condition-view.mjs';
import { workspaceStyles, statusBadge, originBadge } from './workspace-view.mjs';
import { approveSupportRequests } from './bulk-approval.mjs';

const roles = ['영업지원팀', '영업임원', '회계', '대리점'];
const roleDescriptions = [
  '승인 요청을 검토하고 소명과 대리점 서류를 처리합니다.',
  '임원 승인 대상의 근거를 확인하고 결정합니다.',
  '승인된 요청의 지급 증빙을 확인합니다.',
  '소명 요청에 답변하고 관련 서류를 제출합니다.',
];
const roleViews = [
  ['requests', 'followup', 'documents', 'review'],
  ['requests'],
  ['accounting'],
  ['agency-replies', 'documents'],
];
const decisions = { approve: '승인', reject: '거절', clarify: '추가 확인 요청' };
const eventLabels = {
  document_received: '서류 접수', account_changed: '계좌 변경 적용',
  review_approve: '재검토 승인 · 보류 해제', review_reject: '재검토 거절', review_clarify: '재검토 추가 확인 요청',
  condition_check: '승인 조건 확인', post_audit: '사후 검토 요청', post_audit_done: '사후 검토 의견',
};
const money = amount => new Intl.NumberFormat('ko-KR').format(amount) + '원';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const source = row => row ? escape(row.file + ':' + row.row) : '—';
const time = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date(value));
const mask = account => '•••• ' + escape(account.slice(-4));

function table(headers, rows, { origins = [], highlight = [], responsive = false } = {}) {
  if (!rows.length) return '<p class="empty-state">아직 없습니다</p>';
  const columnClass = headers.map(header => /^(합계|금액|장려금)(?:\s|$)/.test(header) ? ' class="amount"' : '');
  const origin = headers.map((header, index) => origins[index] ??
    (header.endsWith(' · 원본') || header === '원본 행' || header === '원본 상태' ? '원본' :
      header.endsWith(' · 계산') ? '계산' : ''));
  const title = header => header.replace(/ · (원본|계산)$/, '').replace(/^원본 행$/, '자료 위치').replace(/^원본 상태$/, '지급 상태');
  return '<div class="table-scroll' + (responsive ? ' responsive-requests' : '') + '" tabindex="0" role="region" aria-label="데이터 표"><table><thead><tr>' +
    headers.map((header, index) => '<th scope="col"' + columnClass[index] + '>' + title(header) +
      (origin[index] ? originBadge(origin[index]) : '') + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map((row, rowIndex) => (highlight[rowIndex] ? '<tr class="executive-row">' : '<tr>') + row.map((cell, index) =>
      '<td' + columnClass[index] + (responsive ? ' data-label="' + escape(title(headers[index])) + '"' : '') + '>' + cell + '</td>').join('') +
    '</tr>').join('') + '</tbody></table></div>';
}

function locations(rows) {
  if (!rows.length) return '';
  return '<details class="locations"><summary>자료 위치 보기</summary><ul>' +
    rows.map(([label, refs]) => '<li>' + escape(label) + ' · ' + refs.map(source).join(', ') + '</li>').join('') +
    '</ul></details>';
}

function evidence(title, origin, content, refs, collapsed = false) {
  const heading = title + (origin ? originBadge(origin) : '');
  const body = content + locations(refs);
  return collapsed ? '<details class="evidence"><summary>' + heading + '</summary>' + body + '</details>'
    : '<section class="evidence"><h3>' + heading + '</h3>' + body + '</section>';
}

async function transaction(pool, period, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['w07:' + period]);
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

async function saveDecision(db, period, groupId, role, action, reason, conditions = []) {
  await db.query(`INSERT INTO w07_decision (period, group_id, role, action, reason, conditions)
    VALUES ($1,$2,$3,$4,$5,$6)`, [period, groupId, role, action, reason, JSON.stringify(conditions)]);
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
      await db.query(`CREATE TABLE IF NOT EXISTS w07_ai_call (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, period text NOT NULL,
        document_id bigint REFERENCES w07_document(id), group_id text, kind text NOT NULL,
        request jsonb, raw jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`);
    }).catch(error => { schema = undefined; throw error; });
    return schema;
  }

  return async function workflow(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams;
    const roleIndex = Number(request.headers.cookie?.match(/(?:^|;\s*)w07_role=([0-3])(?:;|$)/)?.[1] ?? -1);
    const role = roles[roleIndex];
    const requestedPeriod = query.get('period');
    const periodQuery = /^\d{4}-\d{2}$/.test(requestedPeriod ?? '') ? { period: requestedPeriod } : {};
    const rolePageLink = '/';
    const send = (status, content) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(content);
    };
    const entryPage = (title, content) => '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title +
      '</title><style>' + workspaceStyles + '</style></head><body><main class="role-entry"><h1>' + title +
      '</h1>' + content + '</main></body></html>';
    const denied = () => send(403, entryPage('이 역할에서는 볼 수 없습니다',
      '<p><a href="' + rolePageLink + '">역할 바꾸기</a></p>'));
    const requestedView = query.get('view');
    const historicalReview = query.get('after') === 'historical-review';
    if (requestedView === 'roles' && request.method === 'POST') {
      const selected = query.get('select');
      if (!/^[0-3]$/.test(selected ?? '') || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return denied();
      response.writeHead(303, {
        Location: '/?' + new URLSearchParams({
          ...periodQuery, view: historicalReview && selected === '0' ? 'review' : roleViews[Number(selected)][0],
        }) + (historicalReview && selected === '0' ? '#historical-review' : ''),
        'Set-Cookie': ['w07_role=' + selected + '; Path=/; HttpOnly; Secure; SameSite=Lax',
          ...(selected === '3' ? ['w07_dealer=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'] : [])],
        'Cache-Control': 'no-store',
      }).end();
      return;
    }
    if (!role || !url.search || requestedView === 'roles') {
      if (request.method !== 'GET') return denied();
      return send(200, entryPage('업무 역할 선택', '<div class="role-cards">' +
        roles.map((name, index) => '<form class="summary-card" method="post" action="/?' +
          escape(new URLSearchParams({ ...periodQuery, view: 'roles', select: index,
            ...(historicalReview ? { after: 'historical-review' } : {}) }).toString()) +
          '"><button class="role-card-button"><span class="role-card-title">' + name + '</span><span class="role-card-description">' + roleDescriptions[index] + '</span><span class="role-card-action">선택 →</span></button></form>').join('') + '</div>'));
    }
    const view = requestedView ?? (query.has('group') ? 'requests' : roleViews[roleIndex][0]);
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
        : await db.query('SELECT * FROM w07_ai_call WHERE period = $1 ORDER BY id', [period]);
      return { reviews: reviews.rows, rows: decisions.rows, events: history.rows, documents: docs.rows, calls: calls.rows };
    });
    const { reviews, rows, events, calls } = snapshot;
    const effective = calculate(applyChanges(data, reviews));
    const originalList = original.requests.filter(entry => entry.period === period);
    const current = effective.requests.filter(entry => entry.period === period);
    const saved = new Map(rows.map(row => [row.group_id, row]));
    const eventsFor = id => events.filter(event => event.group_id === id);
    const progressFor = entry => entry ? requestProgress(saved.get(entry.group.groupId),
      eventsFor(entry.group.groupId), entry.exceedsLimit, latestReview(reviews, entry)) : {};
    const isAffected = entry => progressFor(entry).held;
    const latestReplyCheck = entry => {
      const answer = eventsFor(entry.group.groupId).findLast(event => event.action === 'reply');
      return answer && calls.filter(call => call.kind === 'reply_check' && call.group_id === entry.group.groupId &&
        (!call.finished_at || call.result?.replyId === String(answer.id))).at(-1);
    };
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
    const item = list.find(entry => entry.group.groupId === groupId);
    const dealer = request.headers.cookie?.match(/(?:^|;\s*)w07_dealer=(D-\d+)(?:;|$)/)?.[1];
    const agency = role === '대리점' && data.agencies.some(row => row.agency_id === dealer) ? dealer : null;
    if (role === '대리점' && (request.method === 'POST' && query.has('dealer') || !agency)) {
      const selectedDealer = query.get('dealer');
      if (request.method === 'POST') {
        if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) ||
            !data.agencies.some(row => row.agency_id === selectedDealer) || !/^D-\d+$/.test(selectedDealer ?? '')) return denied();
        response.writeHead(303, {
          Location: '/?' + new URLSearchParams({ period, view: 'agency-replies' }),
          'Set-Cookie': 'w07_dealer=' + selectedDealer + '; Path=/; HttpOnly; Secure; SameSite=Lax',
          'Cache-Control': 'no-store',
        }).end();
        return;
      }
      return send(200, entryPage('거래처 선택', '<div class="button-group">' + data.agencies.map(row =>
        '<form method="post" action="' + link({ dealer: row.agency_id }) + '"><button>' +
        escape(row.agency_id) + ' · ' + escape(row.agency_name) + '</button></form>').join('') + '</div>'));
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
      const action = form.get('action');
      let reason = (form.get('reason') ?? '').trim();
      const metadata = inputMetadata(form, period);
      if (['document_add', 'account_apply', 'group_confirm', 'condition_check', ...Object.keys(steps)].includes(action) && !metadata)
        return send(400, '업무 발생일·적용일·적용 정산월을 확인해 주세요.');
      if (['payment', 'condition_check'].includes(action)) {
        const evidence = paymentEvidence(form);
        if (!evidence) return send(400, '확인한 자료의 이름·위치와 수취계좌·명의 등 확인 내용을 입력해 주세요.');
        metadata.evidence = evidence;
        reason = evidence.finding;
      }
      if (role === '대리점' && !['document_add', 'reply'].includes(action)) return denied();
      if (!open && action !== 'reset') return send(403, '원본에 미지급 건이 없는 정산월은 조회만 할 수 있습니다.');
      if (['post_audit', 'post_audit_done'].includes(action)) {
        const target = pastExceedances(original, data, period).find(entry => entry.groupId === form.get('auditGroup'));
        if (!target) return send(404, '사후 검토 대상을 찾을 수 없습니다.');
        if (role !== (action === 'post_audit' ? roles[0] : roles[2])) return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        if (action === 'post_audit_done' && (!reason || reason.length > 1000)) return send(400, '검토 의견을 1~1,000자로 입력해 주세요.');
        const error = await transaction(pool, period, async db => {
          const { rows: existing } = await db.query(`SELECT action FROM w07_event WHERE period=$1 AND group_id=$2
            AND action IN ('post_audit','post_audit_done') ORDER BY id`, [period, target.groupId]);
          const last = existing.at(-1)?.action;
          if (action === 'post_audit' ? last : last !== 'post_audit') return 409;
          await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
            [period, target.groupId, role, action, action === 'post_audit'
              ? target.months.map(month => month.period).join('·') + ' · ' + target.rowCount + '건 · ' + money(target.totalKrw) + ' · 합산 한도 초과 전결 지급'
              : reason, { months: target.months.map(month => month.period), rows: target.rowCount, totalKrw: target.totalKrw }]);
        });
        if (error) return send(error, '화면을 새로 열어 사후 검토 상태를 확인해 주세요.');
        return redirect({}, '#past-exceedance');
      }
      if (['document_add', 'document_extract', 'document_timeout', 'document_confirm', 'group_confirm', 'account_apply', 'ai_draft', 'ai_reply', 'ai_conditions'].includes(action)) {
        if (action === 'document_add' ? role !== '대리점' : action === 'ai_conditions' ? role !== roles[1] : role !== roles[0]) {
          return send(403, '이 업무 역할에서는 처리할 수 없습니다.');
        }
        if (action === 'document_add') {
          const original = form.get('text')?.trim();
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
        if (['document_extract', 'document_timeout', 'ai_draft', 'ai_reply', 'ai_conditions'].includes(action)) {
          const kind = { ai_draft: 'draft', ai_reply: 'reply_check', ai_conditions: 'conditions' }[action] ?? 'extract';
          const groupCall = kind !== 'extract';
          const draft = kind === 'draft';
          const decision = rows.find(row => row.group_id === groupId);
          const state = progressFor(item).state;
          const groupEvents = eventsFor(groupId);
          const reviewDecision = groupEvents.findLast(event => ['review_reject', 'review_clarify'].includes(event.action));
          const sent = groupEvents.findLast(event => ['send', 'resend'].includes(event.action));
          const answer = groupEvents.findLast(event => event.action === 'reply');
          const allowed = item ? conditionBasis(item) : {};
          const unavailable = {
            draft: () => !item || state !== 'draft',
            reply_check: () => !item || state !== 'received' || !answer,
            conditions: () => !item || !Object.keys(allowed).length || !(item.exceedsLimit || isAffected(item)),
            extract: () => !document,
          }[kind]();
          if (unavailable) return send(409, '현재 단계에서 사용할 수 없습니다.');
          const timeoutCheck = action === 'document_timeout';
          if (timeoutCheck && !Object.values(documentSamples(data)).some(([, text]) => text === document.original)) {
            return send(400, '작성 양식으로 접수한 서류만 연결을 확인할 수 있습니다.');
          }
          const sharedDeposits = groupCall ? item.collectionEvidence.filter(entry =>
            new Set(entry.deposits.map(row => row.agencyId)).size > 1) : [];
          const agencyAccounts = new Map(applyChanges(data, reviews).agencies.map(row => [row.agency_id, row.bank_account_no]));
          const recipient = groupCall ? groupId : null;
          const recipientDeposits = sharedDeposits.filter(entry => entry.deposits.some(row => row.agencyId === recipient));
          const registration = agencyAccounts.get(recipient);
          const groupFacts = groupCall ? {
            agencies: item.group.members.map(member => member.agencyId),
            matches: item.group.links.map(entry => ({ agencies: entry.agencyIds, fields: entry.matchedFields.map(key => fields[key]) })),
            sharedDeposits: item.collectionEvidence.map(entry => ({
              agencies: [...new Set(entry.deposits.map(row => row.agencyId))] })),
          } : {};
          const input = {
            extract: () => ({ text: document.original }),
            reply_check: () => ({ criteria: replyCriteria, request: sent?.reason ?? '', reply: answer.reason }),
            conditions: () => ({ ...groupFacts,
              allowed: Object.entries(allowed).map(([id, basis]) => ({ id, label: conditionCatalog[id], basis })),
              replyCheck: (latestReplyCheck(item)?.result?.items ?? []).map(({ id, label, verdict }) => ({ id, label, verdict })) }),
            draft: () => ({ ...groupFacts,
              reason: reviewDecision?.reason || decision?.reason || latestReview(reviews, item)?.details.reason || '',
              recipient: { sharedDeposit: recipientDeposits.length > 0, registrationDiffers: Boolean(registration) &&
                registration !== 'NONE' && recipientDeposits.some(entry => entry.account !== registration) } }),
          }[kind]();
          const callId = await transaction(pool, period, async db => {
            const keys = [period, groupCall ? null : document.id, groupCall ? groupId : null, kind];
            const pending = await db.query(`SELECT id FROM w07_ai_call WHERE period=$1
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
              : kind === 'reply_check' ? { ...output.result, replyId: String(answer.id) }
                : kind === 'conditions' ? { ...output.result, basis: conditionsKey(item) } : output.result;
            await pool.query('UPDATE w07_ai_call SET request=$2,raw=$3,result=$4,finished_at=now() WHERE id=$1',
              [callId, JSON.stringify(output.request), JSON.stringify(output.raw ?? null), result]);
          }
          return redirect(groupCall ? { group: groupId } : { view: 'documents', document: document.id, ...caseContext });
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
              [period, target.group.groupId, role, '접수 번호 ' + stored.id + ' · ' + stored.confirmed.reason, stored.agency_id, metadata]);
          }
        });
        if (error) return send(error, '확인 값과 현재 처리 단계를 다시 확인해 주세요.');
        return action === 'document_confirm'
          ? redirect({ view: 'documents', document: document.id, ...caseContext }, '#document-confirmation')
          : redirect({ view: 'review', ...caseContext });
      }
      if (!item && !['reset', 'bulk_approve'].includes(action)) return send(400, '잘못된 요청입니다.');
      const error = await transaction(pool, period, async db => {
        if (action === 'reset') {
          await db.query('DELETE FROM w07_ai_call WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_review WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_document WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_event WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_decision WHERE period = $1', [period]);
          return;
        }
        const { rows: currentReviews } = await db.query('SELECT * FROM w07_review WHERE period=$1 ORDER BY id', [period]);
        if (action === 'bulk_approve') {
          const { rows: currentDecisions } = await db.query('SELECT group_id FROM w07_decision WHERE period=$1', [period]);
          return approveSupportRequests({
            role, ids: form.getAll('request'), requests: originalList,
            savedIds: new Set(currentDecisions.map(row => row.group_id)),
            affected: new Set(currentReviews.flatMap(review => review.details.scope.agencies)),
            approve: id => saveDecision(db, period, id, role, 'approve', ''),
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
        if (action === 'reply' && (!recipient || agency !== (recipient.agency_id ?? groupId))) return 403;
        const latest = currentEvents.at(-1);
        if (form.get('revision') !== String(latest?.id ?? '0')) return 409;
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
        if (action === 'payment') {
          const confirmed = confirmedConditions(record, currentEvents);
          if ((record?.conditions ?? []).some(condition => !confirmed.has(condition))) return 409;
        }
        if (Object.hasOwn(decisions, action)) {
          if (role !== (held ? '영업임원' : item.approver)) return 403;
          if (reason.length > 1000 || (action !== 'approve' && !reason)) return 400;
          const allowed = Object.keys(conditionBasis(item));
          const conditions = action === 'approve' && role === roles[1] ? [...new Set(form.getAll('condition'))] : [];
          if (conditions.some(condition => !allowed.includes(condition))) return 400;
          if (held) {
            if (state !== 'resubmitted') return 409;
            if (action === 'approve') {
              if (!record) await saveDecision(db, period, groupId, role, action, reason, conditions);
              else if (record.action !== 'approve') {
                await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,acted_at)
                  VALUES ($1,$2,$3,$4,$5,$6)`, [...ids, record.role, record.action, record.reason, record.acted_at]);
                await db.query(`UPDATE w07_decision SET role=$3, action='approve', reason=$4, acted_at=now()
                  WHERE period=$1 AND group_id=$2`, [...ids, role, reason]);
                await db.query('INSERT INTO w07_accounting_task (period,group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', ids);
              }
              if (record) await db.query('UPDATE w07_decision SET conditions=$3 WHERE period=$1 AND group_id=$2', [...ids, JSON.stringify(conditions)]);
            }
            await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,review_id)
              VALUES ($1,$2,$3,$4,$5,$6)`, [...ids, role, 'review_' + action, reason, review.id]);
            return;
          }
          if (record) return 409;
          await saveDecision(db, period, groupId, role, action, reason, conditions);
          return;
        }
        const invalid = followupError(action, state, role, reason);
        if (invalid) return invalid;
        if (action === 'resubmit' && !held) {
          await db.query(`INSERT INTO w07_event (period, group_id, role, action, reason, acted_at)
            VALUES ($1,$2,$3,$4,$5,$6)`, [...ids, record.role, record.action, record.reason, record.acted_at]);
          await db.query('DELETE FROM w07_decision WHERE period = $1 AND group_id = $2', ids);
        }
        let eventMetadata = metadata;
        if (['resend', 'verify'].includes(action)) {
          const answer = currentEvents.findLast(event => event.action === 'reply');
          const { rows: [check] } = await db.query(`SELECT id, result FROM w07_ai_call WHERE period=$1 AND group_id=$2
            AND kind='reply_check' AND result->>'replyId' = $3 ORDER BY id DESC LIMIT 1`, [...ids, String(answer?.id)]);
          if (check?.result?.items) {
            eventMetadata = { ...metadata, ai: { callId: String(check.id), recommendation: check.result.recommendation,
              agreed: check.result.recommendation === action,
              unmet: check.result.items.filter(entry => entry.verdict !== 'met').map(({ label, verdict }) => ({ label, verdict })) } };
          }
        }
        await db.query(`INSERT INTO w07_event (period,group_id,role,action,reason,review_id,agency_id,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [...ids, role, action, reason, review?.id ?? null,
            action === 'reply' ? agency : ['send', 'resend'].includes(action) ? groupId : null, eventMetadata]);
      });
      if (error) return send(error, {
        400: '필요한 내용이나 사유를 1~1,000자로 입력해 주세요.',
        403: '현재 업무 역할에 해당 작업 권한이 없습니다.',
        409: '화면을 새로 열어 현재 처리 단계를 확인해 주세요.',
      }[error]);
      const next = new URLSearchParams({ period, view, ...(item && action !== 'reset' ? { group: groupId } : {}) });
      response.writeHead(303, { Location: '/?' + next.toString() + (item && action !== 'reset' ? '#current-task' : '') }).end();
      return;
    }

    const stateFor = entry => progressFor(entry).state;
    const onHold = state => ['draft', 'waiting', 'received', 'verified'].includes(state);
    const statusFor = entry => {
      if (!open) {
        const ids = new Set(entry.rebateRows.map(row => row.rebateId));
        const statuses = [...new Set(data.rebates.filter(row => ids.has(row.rebate_id)).map(row =>
          /^\d{4}-\d{2}-\d{2}$/.test(row.payment_date) ? '지급 완료' : row.approval_status))];
        return statuses.join(' · ');
      }
      const state = stateFor(entry);
      if (isAffected(entry)) return role === roles[2] ? '재검토 필요 · 확인 대기' : '재검토 · ' + (labels[state] ?? '소명 대기');
      if (onHold(state)) return '보류 · ' + labels[state];
      return labels[state] ?? decisions[saved.get(entry.group.groupId)?.action] ?? '승인 대기';
    };
    const options = (values, selected) => values.map(value =>
      '<option' + (value === selected ? ' selected' : '') + '>' + escape(value) + '</option>').join('');
    const agencyNames = new Map(data.agencies.map(row => [row.agency_id, row.agency_name]));
    const members = entry => entry.group.members.map(member => escape(member.agencyId) + (agencyNames.get(member.agencyId) ? ' · ' + escape(agencyNames.get(member.agencyId)) : '')).join('<br>');
    const groupLink = entry => '<a href="' + link({ view: view === 'accounting' ? 'accounting' : 'requests', group: entry.group.groupId }) + '">' +
      escape(entry.group.groupId) + '</a>';
    const past = open ? pastExceedances(original, data, period) : [];
    const pastPanel = past.length ? '<section class="past-exceedance" id="past-exceedance"><h2>과거 권한 초과 지급 · 사후 검토</h2>' + past.map(entry => {
      const audit = eventsFor(entry.groupId).filter(event => ['post_audit', 'post_audit_done'].includes(event.action));
      const requested = audit.find(event => event.action === 'post_audit');
      const done = audit.findLast(event => event.action === 'post_audit_done');
      const status = done ? '사후 검토 완료' : requested ? '회계·감사 확인 대기' : '사후 검토 미등록';
      return '<p>' + entry.members.map(escape).join('·') + '을 합산하면 ' + entry.months.length +
        '개월 모두 한도 200만원을 넘었지만, 거래처별로 심사되어 영업지원팀 전결로 지급됐습니다. 놓친 원인은 자료가 아니라 <strong>승인 단위</strong>입니다. 이미 지급된 금액은 되돌리지 않고 사후 검토로 넘깁니다.</p>' +
        '<p><strong>' + entry.rowCount + '건 · ' + money(entry.totalKrw) + '</strong> ' + statusBadge(status) + '</p>' +
        table(['정산월 · 원본', '그룹 합계 · 계산', '당시 승인 · 원본', '정책상 승인권자 · 계산', '지급일 · 원본'], entry.months.map(month => [
          escape(month.period), money(month.paidKrw), '영업지원팀 전결 · ' + month.rows + '건', '영업임원', escape(month.paymentDates.join(', ')),
        ])) + locations(entry.months.map(month => [month.period, month.sources])) +
        (done ? '<p><strong>회계 검토 의견</strong> · ' + time(done.acted_at) + '<br>' + escape(done.reason) + '</p>' : '') +
        (!requested && role === roles[0] ? '<form method="post" action="' + link({}) + '"><input type="hidden" name="auditGroup" value="' + escape(entry.groupId) +
          '"><button class="primary" name="action" value="post_audit">사후 검토 요청 · 회계·감사</button></form>' : '') +
        (requested && !done && role === roles[2] ? '<form method="post" action="' + link({}) + '"><input type="hidden" name="auditGroup" value="' + escape(entry.groupId) +
          '"><label>검토 의견 <textarea name="reason" maxlength="1000" required></textarea></label> <button class="primary" name="action" value="post_audit_done">검토 의견 등록</button></form>' : '');
    }).join('') + '</section>' : '';
    let content;
    let detailView = false;
    let nextTask = '승인 요청을 선택하세요.';
    if (view === 'documents') {
      nextTask = role === '대리점' ? '제출할 서류를 선택하세요.' : '제출된 서류를 확인하세요.';
      content = documentView({ data, documents, calls, selectedId: documentId, selectedAgency: query.get('agency'),
        link: extras => link({ ...extras, ...caseContext }), escape, table, role, open, agency, period, time });
    } else if (view === 'review') {
      nextTask = '변경된 승인 경로와 재검토 대상을 확인하세요.';
      content = reviewView(reviews.map(review => ({ ...review, resolved: events.some(event =>
        event.review_id === review.id && event.action === 'review_approve') })), { escape, table, source, money, link });
    } else if (view === 'ai-log') {
      nextTask = '호출 기록을 열어 요청과 응답을 확인하세요.';
      content = aiLog(calls, escape, table, time);
    } else if (view === 'accounting' && !item) {
      nextTask = '지급 검토 작업을 선택하세요.';
      content = pastPanel + '<h2>회계 지급 검토</h2>' + table(['요청 · 계산', '거래처 · 원본', '합계 · 계산', '상태', '등록 시각'],
        list.filter(entry => (!groupId || entry.group.groupId === groupId) && saved.get(entry.group.groupId)?.created_at).map(entry => [
          groupLink(entry), members(entry), money(entry.totalKrw), statusBadge(statusFor(entry)), time(saved.get(entry.group.groupId).created_at),
        ]));
    } else if (view === 'agency-replies') {
      const ownEvent = (event, id) => (event.agency_id ?? id) === agency;
      const cases = list.filter(entry => belongsToAgency(entry) && eventsFor(entry.group.groupId)
        .some(event => ['send', 'resend'].includes(event.action) && ownEvent(event, entry.group.groupId)));
      nextTask = '소명 요청을 열어 답변을 제출하세요.';
      content = '<h2>소명 요청</h2>' + table(['요청', '거래처', '답변 상태'], cases.map(entry => [
        '<a href="' + link({ group: entry.group.groupId }) + '">' + escape(entry.group.groupId) + '</a>',
        escape(agency), stateFor(entry) === 'waiting' ? '답변 대기' : '답변 제출',
      ]));
      const history = item && cases.includes(item) ? eventsFor(groupId)
        .filter(event => ['send', 'resend', 'reply'].includes(event.action) && ownEvent(event, groupId)) : [];
      if (history.length) {
        const recipient = eventsFor(groupId).findLast(event => ['send', 'resend'].includes(event.action));
        const waiting = open && stateFor(item) === 'waiting' && recipient && ownEvent(recipient, groupId);
        const unmet = recipient?.action === 'resend' ? recipient.metadata?.ai?.unmet ?? [] : [];
        const guide = '<section class="reply-guide"><h4>답변에 포함할 확인 항목</h4><ul>' +
          replyCriteria.map(criterion => '<li>' + escape(criterion.label) + '</li>').join('') + '</ul>' +
          (unmet.length ? '<p><strong>지난 답변에서 확인되지 않은 항목</strong></p><ul>' + unmet.map(entry =>
            '<li>' + escape(entry.label) + ' · ' + escape(verdictLabels[entry.verdict] ?? entry.verdict) + '</li>').join('') + '</ul>' : '') +
          '<p class="muted">영업지원팀이 답변을 항목별로 확인합니다. 계좌번호·예금주 명의·자료 위치를 구체적으로 적어 주세요.</p></section>';
        content += '<h3>요청 ' + escape(groupId) + '</h3>' +
          table(['시각 · 최신순', '구분', '내용'], newestFirstEvents(history).map(event =>
            [time(event.acted_at), event.action === 'reply' ? '답변' : '소명 요청', escape(event.reason) + '<br>' + metadataView(event.metadata, escape)])) +
          (waiting ? '<form method="post" action="' + link({ group: groupId }) + '">' +
            '<input type="hidden" name="revision" value="' + escape(eventsFor(groupId).at(-1)?.id ?? '0') + '">' +
            guide + metadataFields(period, escape, history.findLast(event => event.action === 'reply')?.metadata) + '<label>답변 내용 <textarea name="reason" maxlength="1000" required></textarea></label> ' +
            '<button class="primary" name="action" value="reply">답변 제출</button></form>' : '') +
          '<p><a href="' + link({ view: 'documents', case: groupId }) + '">텍스트 서류 제출</a></p>';
      }
    } else if (view === 'followup') {
      nextTask = '소명할 요청을 선택하세요.';
      content = '<h2>소명 요청 작업</h2>' + table(['요청 · 계산', '거래처 · 원본', '상태'],
        list.filter(entry => onHold(stateFor(entry))).map(entry => [groupLink(entry), members(entry), statusBadge(statusFor(entry))]));
    } else if (item) {
      detailView = true;
      const record = saved.get(groupId);
      const ids = new Set(item.group.members.map(member => member.agencyId));
      const historical = data.rebates.filter(row => ids.has(row.agency_id) && row.period_ym < period)
        .sort((a, b) => a.period_ym.localeCompare(b.period_ym));
      const requestRebateIds = new Set(item.rebateRows.map(row => row.rebateId));
      const periodRecords = data.rebates.filter(row => requestRebateIds.has(row.rebate_id));
      const paidRecords = periodRecords.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.payment_date));
      const deposits = data.collections.filter(row => ids.has(row.agency_id));
      const fields = { representative_name: '대표자', address: '주소', bank_account_no: '정산계좌' };
      const history = eventsFor(groupId);
      const state = stateFor(item);
      const held = isAffected(item);
      const enabled = open && (held ? role === roles[1] && state === 'resubmitted' : role === item.approver && !record);
      const revision = '<input type="hidden" name="revision" value="' + escape(history.at(-1)?.id ?? '0') + '">';
      const actions = open ? Object.entries(steps).filter(([, [from]]) => from === state) : [];
      const draft = calls.filter(call => call.kind === 'draft' && call.group_id === groupId &&
        call.created_at >= (record?.acted_at ?? new Date(0)) && (!call.result || call.result.grounded)).at(-1);
      const canDraft = open && state === 'draft' && role === roles[0];
      const draftForm = canDraft ? '<section class="ai-draft"><p>요청할 증빙</p>' +
        (draft?.result ? '<ul>' + draft.result.evidence.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul>'
          : draft?.finished_at ? '<p>AI 초안 생성 실패, 직접 작성</p>' : '') +
        (draft?.result ? '<details><summary>AI 요청서 초안</summary><textarea readonly>' +
          escape(draft.result.draft) + '</textarea><button type="button" data-use-draft>작성란에 넣기</button></details>' : '') +
        '<form method="post" data-ai="draft" action="' + link({ group: groupId }) +
        '"><button name="action" value="ai_draft">AI 요청서 초안 제안</button></form></section>' : '';
      const sent = history.findLast(event => ['send', 'resend'].includes(event.action));
      const answer = history.findLast(event => event.action === 'reply');
      const correspondence = (answer ? '<p><strong>받은 답변 · 가상 회신</strong><br>' + escape(answer.reason) +
        '</p><details><summary>답변 기록 정보</summary>' + metadataView(answer.metadata, escape) + '</details>' : '') +
        (sent ? '<details><summary>보낸 요청서</summary><p>' + escape(sent.reason) + '</p></details>' : '');
      const previousMetadata = history.findLast(event => event.role === role && event.metadata)?.metadata;
      const verdictBadge = verdict => '<span class="verdict verdict-' + escape(verdict) + '">' + escape(verdictLabels[verdict] ?? verdict) + '</span>';
      const replyCheck = state === 'received' && role === roles[0] && answer ? latestReplyCheck(item) : null;
      const replyResult = replyCheck?.result;
      const replyPanel = state === 'received' && role === roles[0] && answer ? '<section class="ai-reply"><h4>AI 답변 판정 <small class="ai-mark">참고 · 결정은 담당자</small></h4>' +
        (replyResult ? '<p class="muted">생성 ' + time(replyCheck.created_at) + ' · 기준: 확인 항목 ' + replyCriteria.length + '개 · 인용 문장은 답변 원문과 대조됨</p>' +
          table(['확인 항목', '판정', '답변 근거'], replyResult.items.map(entry => [escape(entry.label), verdictBadge(entry.verdict),
            entry.quote ? '“' + escape(entry.quote) + '”' : '<span class="muted">' + escape(entry.note || '근거 문장 없음') + '</span>'])) +
          '<p>AI 의견 <strong>' + escape(recommendationLabels[replyResult.recommendation]) + '</strong>' +
          (replyResult.recommendation === 'resend' ? ' · ' + replyResult.items.filter(entry => entry.verdict !== 'met').length + '개 항목 미충족 · 아래 작성란에 보완 요청 초안을 넣었습니다' : '') + '</p>' +
          (replyResult.draft ? '<textarea hidden data-reply-draft>' + escape(replyResult.draft) + '</textarea>' : '')
          : replyCheck?.finished_at ? '<p>AI 판정 실패 · 답변을 직접 검토하세요.</p>' : replyCheck ? '<p>판정 중</p>' : '') +
        (open && !replyCheck ? '<form hidden method="post" data-ai="reply" action="' + link({ group: groupId }) +
          '"><button name="action" value="ai_reply">AI 답변 판정</button></form>' : '') + '</section>' : '';
      const conditionIds = record?.action === 'approve' ? record.conditions ?? [] : [];
      const confirmed = confirmedConditions(record, history);
      const unconfirmed = conditionIds.filter(id => !confirmed.has(id));
      const conditionsPanel = conditionIds.length && ['paymentPending', 'paymentReady'].includes(state) ? '<section class="conditions-panel"><h3>임원 승인 조건 · ' +
        (conditionIds.length - unconfirmed.length) + '/' + conditionIds.length + ' 확인</h3>' + conditionIds.map(id => {
          const done = confirmed.get(id);
          return '<div class="condition-row"><p><strong>' + escape(conditionCatalog[id] ?? id) + '</strong> ' +
            (done ? '<span class="verdict verdict-met">확인됨</span>' : '<span class="verdict verdict-missing">미확인</span>') + '</p>' +
            (done ? '<p class="muted">' + time(done.acted_at) + ' · 확인 자료 ' + escape(done.metadata?.evidence?.reference ?? '') + ' · ' + escape(done.reason) + '</p>'
              : open && role === roles[2] && state === 'paymentPending' ? '<form method="post" action="' + link({ group: groupId }) + '">' + revision +
                '<input type="hidden" name="condition" value="' + escape(id) + '">' + metadataFields(period, escape, previousMetadata) +
                '<label>확인 자료 이름·위치 <input name="evidenceReference" maxlength="200" required></label>' +
                '<label>확인 내용 <textarea name="evidenceFinding" maxlength="1000" required></textarea></label>' +
                '<button class="primary" name="action" value="condition_check">조건 확인 저장</button></form>' : '') + '</div>';
        }).join('') + '</section>' : '';
      const paymentBlocked = state === 'paymentPending' && unconfirmed.length > 0;
      const followup = paymentBlocked && role === roles[2] ? '<p class="next-task">남은 승인 조건 ' + unconfirmed.length + '개를 확인하면 지급 증빙을 확인할 수 있습니다.</p>'
        : actions.length && role === actions[0][1][2]
        ? '<section class="task-panel" id="followup"><h3>' + labels[state] + '</h3>' + (state === 'received' ? correspondence + replyPanel : '') + draftForm +
          '<form method="post" action="' + link({ group: groupId }) +
        '">' + revision + '<fieldset><legend>' + labels[state] +
        '</legend>' + metadataFields(period, escape, previousMetadata) + (state === 'paymentPending' ? '<label>확인 자료 이름·위치 <input name="evidenceReference" maxlength="200" required></label><label>수취계좌·명의 등 확인 내용 <textarea name="evidenceFinding" maxlength="1000" required></textarea></label>' : state === 'verified' ? '' : '<label>' + (state === 'draft' ? '보낼 요청서' : '검토 근거 또는 재요청 내용') + ' <textarea name="reason" maxlength="1000" required>' +
          escape(state === 'draft' && canDraft ? draft?.result?.draft : state === 'received' ? replyResult?.draft ?? '' : '') + '</textarea></label> ') +
        actions.map(([action, step]) => '<button name="action" value="' + action + '">' + step[3] + '</button> ').join('') +
        '</fieldset></form></section>' : '';
      const timeline = newestFirstEvents([...history, ...(record ? [record] : []),
        ...(record?.created_at ? [{ acted_at: record.created_at, role: '시스템', action: 'accounting',
          reason: '승인 결과 반영' }] : [])]);
      const cards = [
        ['구성 거래처', members(item), '원본'],
        ['합계', money(item.totalKrw), '계산'],
        ['승인권자', escape(item.approver), '계산'],
        ['현재 상태', statusBadge(statusFor(item))],
      ];
      const matching = [...new Set(item.group.links.flatMap(entry => entry.matchedFields))];
      const sameRepresentative = item.group.links.length > 0 &&
        item.group.links.every(entry => entry.matchedFields.includes('representative_name'));
      const groupReason = sameRepresentative && item.group.members.length === 3 &&
        matching.includes('address') && matching.includes('bank_account_no')
        ? '대표자가 같고 주소 또는 정산계좌가 일치해 세 거래처를 한 묶음으로 봅니다.'
        : matching.length ? matching.map(field => fields[field]).join('·') +
          ' 일치를 근거로 ' + item.group.members.length + '개 거래처를 한 묶음으로 봅니다.'
          : '단독 거래처로 심사합니다.';
      const retainedReason = retained(item);
      const amountReason = !open ? '묶어서 보면 ' + item.approver + ' 승인 대상입니다.' : retainedReason
        ? '동일 입금계좌 기록으로 영업임원 승인 경로를 유지합니다.'
        : '합계가 200만원' + (item.exceedsLimit ? '을 넘어 ' : ' 이하여서 ') + item.approver + ' 승인 대상입니다.';
      const recordedApprovers = [...new Set(paidRecords.map(row => row.approver).filter(Boolean))];
      const historicalReason = paidRecords.length === periodRecords.length && recordedApprovers.length === 1
        ? '당시 ' + recordedApprovers[0] + (recordedApprovers[0] === '영업지원팀' ? ' 전결' : ' 승인') + '로 지급됐습니다.'
        : paidRecords.length ? '당시 ' + periodRecords.length + '건 중 ' + paidRecords.length + '건이 지급됐습니다.'
          : '당시 지급된 기록이 없습니다.';
      const reviewPeriod = periods.find(month => month > period && isOpenPeriod(data.rebates, month));
      if (!open) {
        nextTask = reviewPeriod ? '<a href="' + (role === roles[0]
          ? link({ period: reviewPeriod, view: 'review' }) + '#historical-review'
          : '/?' + escape(new URLSearchParams({ period: reviewPeriod, view: 'roles', after: 'historical-review' }).toString())) +
          '">사후 검토 대상 보기</a>' : '지급 기록을 조회할 수 있습니다.';
      } else if (held && role === roles[2]) {
        nextTask = '재검토 승인 대기';
      } else if (held && state === 'resubmitted') {
        nextTask = enabled ? '변경 근거와 소명 답변을 검토하고 결정하세요.' : '영업임원 재검토 결정 대기';
      } else if (!held && record?.action === 'approve') {
        nextTask = state === 'paymentReady' ? '증빙 확인 완료 · 지급 실행과 은행 대사는 이 앱의 처리 범위 밖입니다.' :
          role === roles[2] ? (paymentBlocked ? '임원 승인 조건을 먼저 확인하세요.' : '지급 증빙을 확인하세요.') : '회계 지급 검토 대기';
      } else if (onHold(state)) {
        const task = { draft: '소명 요청을 작성하세요', waiting: '대리점 답변을 등록하세요',
          received: '대리점 답변을 검토하세요', verified: '임원에게 재상신하세요' }[state];
        nextTask = state === 'waiting' ? '대리점 답변 대기' :
          role === roles[0] ? task + '. <a href="#followup">바로 가기</a>' : '영업지원팀 소명 처리 대기';
      } else if (!record && role !== item.approver) {
        nextTask = escape(item.approver) + ' 결정 대기';
      } else {
        nextTask = enabled ? '승인 여부를 결정하세요.' : '기록된 결정을 확인하세요.';
      }
      const previousReason = timeline.find(event =>
        ['reject', 'clarify', 'review_reject', 'review_clarify'].includes(event.action) && event.reason);
      const clarificationReview = history.findLast(event => event.action === 'verify');
      const allowedBasis = conditionBasis(item);
      const showConditions = enabled && role === roles[1] && Object.keys(allowedBasis).length > 0 && (item.exceedsLimit || held);
      const conditionCall = (() => {
        const latest = calls.filter(call => call.kind === 'conditions' && call.group_id === groupId).at(-1);
        return latest && (!latest.finished_at || !latest.result || latest.result.basis === conditionsKey(item)) ? latest : null;
      })();
      const suggested = conditionCall?.result?.conditions ?? [];
      const conditionsSection = showConditions ? '<section class="ai-conditions"><h4>승인 조건 <small class="ai-mark">AI 제안 · 임원이 선택</small></h4>' +
        (conditionCall?.result ? '<p class="muted">생성 ' + time(conditionCall.created_at) + ' · 소명 판정과 관련자 근거 기준 · 정해진 조건 목록에서만 제안</p>'
          : conditionCall?.finished_at ? '<p class="muted">AI 제안 실패 · 조건을 직접 선택하세요.</p>' : conditionCall ? '<p class="muted">제안 중</p>' : '') +
        Object.entries(allowedBasis).map(([id, basis]) => '<label class="condition-option"><input type="checkbox" name="condition" value="' + escape(id) + '"' +
          (suggested.includes(id) ? ' checked' : '') + '><span><strong>' + escape(conditionCatalog[id]) + '</strong>' +
          (suggested.includes(id) ? ' <small class="ai-mark">AI 제안 ' + (suggested.indexOf(id) + 1) + '</small>' : '') +
          '<br><small class="muted">근거 · ' + escape(basis) + '</small></span></label>').join('') +
        '<p class="muted">선택한 조건은 승인 시 회계 확인 항목이 되고, 모두 확인되기 전까지 지급 검토가 열리지 않습니다.</p></section>' : '';
      const conditionsTrigger = showConditions && open && !conditionCall ? '<form hidden method="post" data-ai="conditions" action="' + link({ group: groupId }) +
        '"><button name="action" value="ai_conditions">승인 조건 제안</button></form>' : '';
      const decision = enabled ? '<section class="decision-panel"><h3>결정</h3>' +
        (role === roles[1] ? (previousReason ? '<p><strong>이전 결정 사유</strong><br>' + escape(previousReason.reason) + '</p>' : '') +
          correspondence + (clarificationReview ? '<p><strong>소명 검토 결과</strong><br>' + escape(clarificationReview.reason) + '</p>' : '') : '') +
        conditionsTrigger + '<form method="post" action="' + link({ group: groupId }) +
        '">' + revision + conditionsSection + '<label>사유 (거절·추가 확인 시 필수) <textarea name="reason" maxlength="1000"></textarea></label><p>' +
        Object.entries(decisions).map(([value, label]) => '<button' + (value === 'approve' ? ' class="primary"' : '') +
          ' name="action" value="' + value + '">' + label + '</button> ').join('') +
        '</p></form></section>' : '';
      const groupLinks = item.group.links;
      const collectionRefs = item.collectionEvidence.flatMap(entry => [...entry.deposits, ...entry.registered]
        .map(row => [row.agencyId + (row.depositDate ? ' · ' + row.depositDate : ' · 등록 정보'), [row.source]]));
      const relatedDocs = documents.filter(row => ids.has(row.agency_id));
      const relatedReviews = reviews.filter(row => row.details.scope.agencies.some(id => ids.has(id)));
      const hasClarification = onHold(state) || history.some(row => ['send', 'reply', 'resend', 'verify', 'resubmit'].includes(row.action));
      const stages = [
        ['상신', true], [state === 'resubmitted' ? '재상신 · 임원 재결정' : '임원 결정', item.exceedsLimit], ['소명', hasClarification],
        ['서류 확인', relatedDocs.length > 0], ['재검토', relatedReviews.length > 0],
        ['회계 지급 검토', Boolean(record?.created_at)],
      ];
      const active = state === 'resubmitted' ? 1 : held ? 2 : relatedDocs.some(row => !row.confirmed) ? 3 :
        record?.created_at ? 5 : onHold(state) ? 2 : item.exceedsLimit ? 1 : 0;
      const progress = '<details class="stage-details"><summary>현재 단계 · ' + stages[active][0] + '</summary><ol class="request-progress" aria-label="처리 단계">' + stages.map(([label, applicable], index) =>
        '<li' + (active === index ? ' aria-current="step"' : applicable ? '' : ' class="not-applicable"') + '>' + label + '</li>').join('') + '</ol></details>';
      const intake = '<form class="case-intake" method="get"><input type="hidden" name="period" value="' + escape(period) +
        '"><input type="hidden" name="view" value="documents">' +
        '<input type="hidden" name="case" value="' + escape(groupId) + '">' +
        '<label>거래처 <select name="agency">' + options([...ids], groupId) +
        '</select></label> <button>접수 서류 보기</button></form>';
      const related = '<details class="case-work"' + (role === roles[0] && relatedDocs.some(row => !row.applied) ? ' open' : '') + '><summary>연결 작업 · 서류 ' + relatedDocs.length + '건 · 정보 변경 ' + relatedReviews.length + '건</summary>' +
        table(['작업', '현황'], [
          ['소명 요청', hasClarification ? (role === roles[0] ? '<a href="' + link({ group: groupId, view: 'requests' }) +
            (followup ? '#followup' : '#history') + '">' + (onHold(state) ? labels[state] : '소명 기록') + '</a>' :
            onHold(state) ? '영업지원팀 소명 처리 대기' : '소명 기록 있음') : '아직 없습니다'],
          ['접수 서류', relatedDocs.length ? (role === roles[0] ? relatedDocs.map(row => '<a href="' +
            link({ view: 'documents', document: row.id, agency: row.agency_id, case: groupId }) + '">' +
            escape(row.agency_id) + ' · 접수 ' + escape(row.id) + '</a>').join('<br>') : relatedDocs.length + '건') : '아직 없습니다'],
          ['정보 변경', relatedReviews.length ? (role === roles[0] ? relatedReviews.map(row => '<a href="' +
            link({ view: 'review', case: groupId }) + '#review-' + escape(row.id) + '">' +
            escape(row.agency_id) + ' · ' + (row.kind === 'change' ? '계좌 변경' : '그룹 확인') + '</a>').join('<br>') : '재검토 필요') : '아직 없습니다'],
          ['회계 작업', record?.created_at ? statusFor(item) : '아직 없습니다'],
        ]) + (open && role === roles[0] ? intake : '') + '</details>';
      content = '<h2>요청 ' + escape(groupId) + '</h2><div class="summary-cards detail-cards">' +
        cards.map(([label, value, origin]) => '<div class="summary-card"><p>' + label +
          (origin ? originBadge(origin) : '') + '</p><strong>' + value + '</strong></div>').join('') + '</div>' +
        progress + '<div id="current-task">' +
        (nextTask === statusFor(item) ? '' : '<p class="next-task">' + nextTask + '</p>') +
        (role === roles[1] ? decision + conditionsPanel : conditionsPanel + decision + followup) + '</div>' + related +
        '<h3>판단 근거</h3><p class="decision-explanation">' + escape((open ? groupReason : historicalReason) + ' ' + amountReason) + '</p>' +
        evidence('관련 거래처 근거', '계산', groupLinks.length
          ? table(['거래처', '일치 항목'], groupLinks.map(entry =>
            [entry.agencyIds.map(escape).join(' ↔ '), entry.matchedFields.map(field => fields[field]).join(', ')]))
          : '<p>단독 거래처</p>',
        item.group.members.map(member => [member.agencyId, [member.source]]), true) +
        evidence('거래처별 장려금', '원본', table(['거래처', '금액'],
          item.rebateRows.map(row => [escape(row.agencyId), money(row.amountKrw)])),
        item.rebateRows.map(row => [row.agencyId + ' · ' + row.rebateId, [row.source]]), true) +
        evidence('이전 정산월 지급 기록', '원본', '<p>현재 그룹 구성원 기준</p>' +
          table(['정산월', '거래처', '금액', '지급 상태', '승인자', '지급일'], historical.map(row =>
            [row.period_ym, row.agency_id, money(Number(row.rebate_amount_krw)), row.approval_status,
              row.approver, row.payment_date].map(escape))),
        historical.map(row => [row.period_ym + ' · ' + row.agency_id, [row.source]]), true) +
        evidence('입금 기록', '원본', table(['거래처', '입금일', '입금계좌'], deposits.map(row =>
          [escape(row.agency_id), escape(row.deposit_date), mask(row.bank_account_no)])),
        deposits.map(row => [row.agency_id + ' · ' + row.deposit_date, [row.source]]), true) +
        evidence('입금계좌 대조', '', '<p>계좌 끝자리만 표시합니다.</p>' +
          table(['입금계좌 · 원본', '회수 기록 · 원본', '정산계좌 일치 · 계산'], item.collectionEvidence.map(entry => [
            mask(entry.account),
            entry.deposits.map(row => escape(row.agencyId) + ' · ' + escape(row.depositDate)).join('<br>'),
            entry.registered.map(row => escape(row.agencyId)).join('<br>'),
          ])), collectionRefs, true) +
        '<h3 id="history">처리 이력</h3><p class="muted">기록 시각 내림차순 · 최신 기록부터</p>' +
        table(['시각', '업무 역할', '행동', '내용·사유'], timeline.map(event => [
          time(event.acted_at), escape(event.role),
          event.action === 'approve' && event.conditions?.length ? '조건부 승인' :
            eventLabels[event.action] ?? steps[event.action]?.[3] ?? decisions[event.action] ?? '회계 지급 검토 작업 등록',
          (event.action === 'condition_check' ? escape(conditionCatalog[event.metadata?.condition] ?? '') + ' · ' : '') + escape(event.reason) +
            (event.conditions?.length ? '<br>승인 조건: ' + event.conditions.map(id => escape(conditionCatalog[id] ?? id)).join(', ') : '') +
            (event.metadata?.ai ? '<br>AI 의견 ' + escape(recommendationLabels[event.metadata.ai.recommendation] ?? '') +
              (event.metadata.ai.agreed ? ' · 담당자 결정과 같음' : ' · 담당자 결정과 다름') : '') +
            (event.metadata?.evidence ? '<br>확인 자료: ' + escape(event.metadata.evidence.reference) : '') +
            (event.metadata?.occurredOn || ['reply', 'document_received', 'account_changed', 'payment'].includes(event.action) ? '<br>' + metadataView(event.metadata, escape) : ''),
        ]));
    } else {
      const cards = [
        ['이번 달 전체 요청', list.length + '건'],
        ['이번 달 임원 대상 전체', list.filter(entry => entry.approver === '영업임원').length + '건'],
        ['200만원 초과 건', '거래처별로 보면 ' + individualExceedance(data.rebates, period) +
          '건 → 묶어서 보면 ' + current.filter(entry => entry.exceedsLimit).length + '건'],
      ];
      const priority = entry => role === roles[1] && (isAffected(entry) ? stateFor(entry) === 'resubmitted' :
        entry.exceedsLimit && !saved.has(entry.group.groupId)) ? -1 :
        isAffected(entry) || onHold(stateFor(entry)) ? 0 : entry.exceedsLimit ? 1 : 2;
      const allRequests = query.get('all') === '1';
      const ordered = list.filter(entry => role !== roles[1] || allRequests || priority(entry) === -1)
        .sort((left, right) => priority(left) - priority(right));
      const listToggle = role === roles[1] ? '<p><a href="' + link(allRequests ? {} : { all: '1' }) + '">' +
        (allRequests ? '임원 결정 대상만 보기' : '전체 보기') + '</a></p>' : '';
      const selectable = entry => open && role === roles[0] && entry.approver === roles[0] &&
        !entry.exceedsLimit && !isAffected(entry) && !saved.has(entry.group.groupId);
      const bulk = ordered.some(selectable);
      const requestTable = !ordered.length && role === roles[1] && !allRequests ? '<p class="empty-state">현재 결정할 요청이 없습니다. 처리된 요청은 전체 보기에서 확인하세요.</p>' : table([...(bulk ? ['선택'] : []), '요청 · 계산', '구성 거래처 · 원본', '합계 · 계산', '승인권자 · 계산', '현재 상태'],
        ordered.map(entry => [
          ...(bulk ? [selectable(entry) ? '<input type="checkbox" name="request" value="' + escape(entry.group.groupId) +
            '" aria-label="' + escape(entry.group.groupId) + ' 선택">' : ''] : []),
          groupLink(entry), members(entry), money(entry.totalKrw), escape(entry.approver), statusBadge(statusFor(entry)),
        ]), { highlight: ordered.map(entry => priority(entry) < 2), responsive: true });
      content = '<div class="summary-cards">' + cards.map(([label, value]) =>
        '<div class="summary-card"><p>' + label + originBadge('계산') + '</p><strong>' + value + '</strong></div>').join('') +
        '</div>' + pastPanel + '<h2>승인 요청 목록</h2>' + (role === roles[1] && !allRequests ? '<p>지금 결정할 요청 ' + ordered.length + '건</p>' : '') + listToggle + (bulk ? '<form method="post" action="' + link({}) +
          '" onsubmit="return confirm(\'선택한 영업지원팀 전결 건을 승인할까요?\')">' +
          '<button class="primary" name="action" value="bulk_approve">선택 건 승인</button>' + requestTable + '</form>' : requestTable);
    }

    const navigation = {
      requests: '승인 요청', followup: '소명 요청', documents: '대리점 서류 접수',
      review: '정보 변경 재검토', accounting: '회계 작업', 'agency-replies': '소명 답변',
    };
    const activeView = Object.hasOwn(navigation, view) ? view : 'requests';
    const pageTitle = view === 'ai-log' ? 'AI 호출 기록' : navigation[activeView];
    const menu = Object.entries(navigation).filter(([key]) => roleViews[roleIndex].includes(key)).map(([key, label]) =>
      '<a href="' + link({ view: key }) + '"' +
      (key === activeView && view !== 'ai-log' ? ' aria-current="page"' : '') + '>' + label + '</a>').join('');
    send(200, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle} | 판매장려금 지급 검토</title><style>${workspaceStyles}</style></head><body>
<div class="workspace">
<aside class="sidebar"><div class="brand"><span class="brand-mark" aria-hidden="true">A</span><div><strong>Aurora</strong><span>판매장려금 관리</span></div></div><nav aria-label="업무 메뉴">${menu}</nav></aside>
<main><header class="toolbar"><h1>${pageTitle}</h1><div class="toolbar-controls">
${role === '대리점' ? '' : `<form method="get" class="filters"><label>정산월 <select name="period">${options(periods, period)}</select></label>
${groupId ? '<input type="hidden" name="group" value="' + escape(groupId) + '"><input type="hidden" name="groupPeriod" value="' + escape(period) + '">' : ''}
<input type="hidden" name="view" value="${escape(view)}">
${view === 'requests' && query.get('all') === '1' ? '<input type="hidden" name="all" value="1">' : ''}
<button class="primary">적용</button></form>`}
<span class="toolbar-role"><strong>${escape(role)}</strong><a href="${rolePageLink}">역할 바꾸기</a></span>
${role === '대리점' ? '' : `<details class="settings"><summary>설정</summary><div class="settings-panel"><p><a href="${link({ view: 'ai-log' })}">AI 호출 기록</a></p>
<form method="post" action="${link({})}" onsubmit="return confirm('이 정산월의 업무 기록을 초기화할까요?')">
<button name="action" value="reset">정산월 초기화</button></form></div></details>`}</div></header>
<div class="content">${detailView ? '' : '<p class="next-task">' + nextTask + '</p>'}${caseContext.case ? '<p><a href="' +
  link({ view: role === '대리점' ? 'agency-replies' : 'requests', group: caseContext.case }) + '">요청 ' + escape(caseContext.case) + ' 상세로 돌아가기</a></p>' : ''}${content}</div>
${role === '대리점' ? '' : '<footer class="workspace-footer"><p>원본은 제공 자료의 값 · 계산은 시스템 산출값</p></footer>'}
</main></div><script>
document.addEventListener('change',event=>{
  if(event.target.name!=='sameEffectiveDate') return;
  const field=event.target.form.elements.effectiveOn;
  field.disabled=event.target.checked;
  field.required=!event.target.checked;
});
document.addEventListener('invalid',event=>{
  let parent=event.target.parentElement;
  while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
},true);
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-use-draft]');
  if(!button)return;
  const panel=button.closest('.task-panel');
  const field=panel?.querySelector('textarea[name=reason]');
  const draft=button.closest('.ai-draft').querySelector('textarea[readonly]');
  if(field&&draft&&(!field.value.trim()||confirm('작성 중인 내용을 AI 초안으로 바꿀까요?'))){field.value=draft.value;field.focus();}
});
document.addEventListener('submit',event=>{
  if(!event.target.matches('[data-preserve-scroll]'))return;
  try{sessionStorage.setItem('document-scroll',JSON.stringify({url:location.pathname+location.search,y:scrollY}));}catch{}
});
try{
  const saved=JSON.parse(sessionStorage.getItem('document-scroll')||'null');
  sessionStorage.removeItem('document-scroll');
  if(saved&&saved.url===location.pathname+location.search)requestAnimationFrame(()=>scrollTo(0,saved.y));
}catch{}
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!form.matches('form[data-ai]')) return;
  event.preventDefault();
  const button=event.submitter;
  if(!button) return;
  button.disabled=true;
  const kind=form.dataset.ai;
  const selector={reply:'.ai-reply',conditions:'.ai-conditions',draft:'.ai-draft',extract:'.document-review'}[kind];
  const message=document.createElement('p');
  message.setAttribute('role','status');
  message.textContent={reply:'AI 답변 판정 중 · 직접 검토 가능',conditions:'AI 조건 제안 중 · 직접 선택 가능'}[kind]??'AI 요청 중 · 직접 입력 가능';
  form.after(message);
  try {
    const response=await fetch(form.getAttribute('action'),{method:'POST',body:new URLSearchParams([[button.name,button.value]])});
    if(!response.ok) throw Error();
    const page=new DOMParser().parseFromString(await response.text(),'text/html');
    const updated=page.querySelector(selector);
    const current=form.closest(selector)??document.querySelector(selector);
    if(!updated||!current) throw Error();
    if(kind==='extract'){
      for(const field of current.querySelectorAll('input:not([type=hidden]),select')){
        const changed=field.tagName==='SELECT' ? field.value!==(Array.from(field.options).find(option=>option.defaultSelected)??field.options[0]).value : field.value!==field.defaultValue;
        const next=Array.from(updated.querySelectorAll('input,select')).find(candidate=>candidate.name===field.name);
        if(changed&&next) next.value=field.value;
      }
    }
    if(kind==='draft'){
      const field=current.parentElement.querySelector('textarea[name=reason]');
      const draft=updated.querySelector('textarea[readonly]');
      if(field&&draft&&!field.value.trim()&&current.parentElement.querySelector('button[value=send],button[value=resend]')) field.value=draft.value;
    }
    if(kind==='reply'){
      const field=document.querySelector('#followup textarea[name=reason]');
      const draft=updated.querySelector('[data-reply-draft]');
      if(field&&draft&&!field.value.trim()) field.value=draft.value;
    }
    current.replaceWith(updated);
    if(kind==='conditions') message.remove();
  } catch {
    message.textContent={reply:'AI 판정 실패 · 답변을 직접 검토하세요',conditions:'AI 제안 실패 · 조건을 직접 선택하세요'}[kind]??'AI 요청 실패, 직접 입력 또는 작성';
  }
  finally { button.disabled=false; }
});
for(const automatic of document.querySelectorAll('form[data-ai="reply"],form[data-ai="conditions"]')) automatic.requestSubmit(automatic.querySelector('button'));
</script></body></html>`);
  };
}
