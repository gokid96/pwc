import { steps, labels, followupState, followupError } from './followup.mjs';
import { applyChanges, callAssistant, fields, individualExceedance, reviewScope, samples } from './condition.mjs';
import { aiLog, documentView, reviewView } from './condition-view.mjs';
import { workspaceStyles, statusBadge, originBadge } from './workspace-view.mjs';
import { approveSupportRequests } from './bulk-approval.mjs';

const roles = ['영업지원팀', '영업임원', '회계'];
const decisions = { approve: '승인', reject: '거절', clarify: '추가 확인 요청' };
const money = amount => new Intl.NumberFormat('ko-KR').format(amount) + '원';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const source = row => row ? escape(row.file + ':' + row.row) : '—';
const time = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
}).format(value);
const mask = account => '•••• ' + escape(account.slice(-4));

function table(headers, rows, { origins = [], highlight = [] } = {}) {
  if (!rows.length) return '<p class="empty-state">아직 없습니다</p>';
  const columnClass = headers.map(header => /^(합계|금액|장려금)(?:\s|$)/.test(header) ? ' class="amount"' : '');
  const origin = headers.map((header, index) => origins[index] ??
    (header.endsWith(' · 원본') || header === '원본 행' || header === '원본 상태' ? '원본' :
      header.endsWith(' · 계산') ? '계산' : ''));
  const title = header => header.replace(/ · (원본|계산|모의)$/, '').replace(/^원본 행$/, '자료 위치').replace(/^원본 상태$/, '지급 상태');
  return '<div class="table-scroll" tabindex="0" role="region" aria-label="데이터 표"><table><thead><tr>' +
    headers.map((header, index) => '<th scope="col"' + columnClass[index] + '>' + title(header) +
      (origin[index] ? originBadge(origin[index]) : '') + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map((row, rowIndex) => (highlight[rowIndex] ? '<tr class="executive-row">' : '<tr>') + row.map((cell, index) =>
      '<td' + columnClass[index] + '>' + cell + '</td>').join('') +
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

async function saveDecision(db, period, groupId, role, action, reason) {
  await db.query(`INSERT INTO w07_decision (period, group_id, role, action, reason)
    VALUES ($1,$2,$3,$4,$5)`, [period, groupId, role, action, reason]);
  if (action === 'approve') {
    await db.query('INSERT INTO w07_accounting_task (period, group_id) VALUES ($1,$2)', [period, groupId]);
  }
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
      await db.query(`CREATE TABLE IF NOT EXISTS w07_document (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, period text NOT NULL,
        agency_id text NOT NULL, original text NOT NULL, confirmed jsonb, applied boolean NOT NULL DEFAULT false
      )`);
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
    const role = roles.includes(query.get('role')) ? query.get('role') : roles[0];
    const data = await readData();
    const original = calculate(data);
    const periods = [...new Set(original.requests.map(item => item.period))].sort().reverse();
    const period = query.get('period') ?? periods[0];
    const groupId = query.get('groupPeriod') && query.get('groupPeriod') !== period ? null : query.get('group');
    const view = query.get('view');
    const documentId = query.get('document');
    const requestedCase = query.get('case');
    const link = extras => '/?' + escape(new URLSearchParams({ period, role, ...extras }).toString());
    const send = (status, content) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(content);
    };

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
    const { reviews, rows, events, documents, calls } = snapshot;
    const effective = calculate(applyChanges(data, reviews));
    const originalList = original.requests.filter(entry => entry.period === period);
    const current = effective.requests.filter(entry => entry.period === period);
    const affected = new Set(reviews.flatMap(review => review.details.scope.agencies));
    const isAffected = entry => entry.group.members.some(member => affected.has(member.agencyId));
    const retainedIds = new Set(reviews.filter(review => review.details.scope.retained.length)
      .flatMap(review => review.details.scope.agencies));
    const retained = entry => entry.group.members.some(member => retainedIds.has(member.agencyId));
    const hasRecord = entry => rows.some(row => row.group_id === entry.group.groupId);
    const list = [...current.filter(entry => !retained(entry)), ...originalList.filter(entry =>
      retained(entry) || (hasRecord(entry) && !current.some(now => now.group.groupId === entry.group.groupId)))]
      .sort((a, b) => a.group.groupId.localeCompare(b.group.groupId));
    const item = list.find(entry => entry.group.groupId === groupId);
    const caseContext = requestedCase && list.some(entry => entry.group.groupId === requestedCase)
      ? { case: requestedCase } : {};
    if (groupId && !item) return send(404, '정산 요청을 찾을 수 없습니다.');
    const document = documents.find(row => row.id === documentId);
    const redirect = extras => {
      response.writeHead(303, { Location: '/?' + new URLSearchParams({ period, role, ...extras }) }).end();
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
      const reason = (form.get('reason') ?? '').trim();
      if (['document_add', 'document_extract', 'document_timeout', 'document_confirm', 'group_confirm', 'account_apply', 'ai_draft', 'ai_summary'].includes(action)) {
        if (role !== roles[0] && action !== 'ai_summary') return send(403, '영업지원 역할이 필요합니다.');
        if (action === 'document_add') {
          const agency = form.get('agency');
          const original = form.get('text')?.trim();
          if (!data.agencies.some(row => row.agency_id === agency) || !original || original.length > 6000 ||
              /[\u0000-\u0008\u000e-\u001f]/.test(original)) return send(400, '거래처와 텍스트를 확인해 주세요.');
          const { rows: [saved] } = await transaction(pool, period, db => db.query(
            'INSERT INTO w07_document (period,agency_id,original) VALUES ($1,$2,$3) RETURNING id', [period, agency, original]));
          return redirect({ view: 'documents', document: saved.id, ...caseContext });
        }
        if (['document_extract', 'document_timeout', 'ai_draft', 'ai_summary'].includes(action)) {
          const draft = action === 'ai_draft';
          const summary = action === 'ai_summary';
          const groupCall = draft || summary;
          const decision = rows.find(row => row.group_id === groupId);
          const latest = events.filter(event => event.group_id === groupId).at(-1);
          const state = followupState(decision, latest?.action, item?.exceedsLimit);
          if (summary ? !item : draft ? !['draft', 'received'].includes(state) : !document) {
            return send(409, '현재 단계에서 사용할 수 없습니다.');
          }
          const timeoutCheck = action === 'document_timeout';
          if (timeoutCheck && !Object.values(samples).some(([, text]) => text === document.original)) {
            return send(400, '기본 모의 서류만 시간 초과를 확인할 수 있습니다.');
          }
          const input = groupCall ? {
            agencies: item.group.members.map(member => member.agencyId),
            matches: item.group.links.map(entry => ({ agencies: entry.agencyIds, fields: entry.matchedFields.map(key => fields[key]) })),
            sharedDeposits: item.collectionEvidence.map(entry => ({
              agencies: [...new Set(entry.deposits.map(row => row.agencyId))] })),
            ...(draft ? { reason: decision.reason } : {
              approver: item.approver, exceedsLimit: item.exceedsLimit, recheck: isAffected(item),
              options: !decision && !isAffected(item) ? Object.values(decisions) : [],
            }),
          } : { text: document.original };
          const kind = summary ? 'summary' : draft ? 'draft' : 'extract';
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
            await pool.query('UPDATE w07_ai_call SET request=$2,raw=$3,result=$4,finished_at=now() WHERE id=$1',
              [callId, JSON.stringify(output.request), JSON.stringify(output.raw ?? null), output.result]);
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
          const details = { scope, reason: stored.confirmed.reason,
            ...(kind === 'change' ? { beforeAccount: agency.bank_account_no, afterAccount: account } : {}) };
          const inserted = await db.query(`INSERT INTO w07_review (period,agency_id,document_id,kind,details)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [period, agency.agency_id, stored.id, kind, details]);
          if (!inserted.rowCount) return 409;
          if (kind === 'change') await db.query('UPDATE w07_document SET applied=true WHERE id=$1', [stored.id]);
        });
        if (error) return send(error, '확인 값과 현재 처리 단계를 다시 확인해 주세요.');
        return redirect(action === 'document_confirm'
          ? { view: 'documents', document: document.id, ...caseContext } : { view: 'review', ...caseContext });
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
        const { rows: currentReviews } = await db.query('SELECT details FROM w07_review WHERE period=$1', [period]);
        if (action === 'bulk_approve') {
          const { rows: currentDecisions } = await db.query('SELECT group_id FROM w07_decision WHERE period=$1', [period]);
          return approveSupportRequests({
            role, ids: form.getAll('request'), requests: originalList,
            savedIds: new Set(currentDecisions.map(row => row.group_id)),
            affected: new Set(currentReviews.flatMap(review => review.details.scope.agencies)),
            approve: id => saveDecision(db, period, id, role, 'approve', ''),
          });
        }
        if (currentReviews.some(review => review.details.scope.agencies.some(id =>
          item.group.members.some(member => member.agencyId === id)))) return 409;
        const ids = [period, groupId];
        const { rows: [record] } = await db.query(`SELECT d.*, t.created_at FROM w07_decision d
          LEFT JOIN w07_accounting_task t USING (period, group_id) WHERE d.period = $1 AND d.group_id = $2`, ids);
        const { rows: [latest] } = await db.query(`SELECT id, action FROM w07_event
          WHERE period = $1 AND group_id = $2 ORDER BY id DESC LIMIT 1`, ids);
        if (form.get('revision') !== (latest?.id ?? '0')) return 409;
        if (Object.hasOwn(decisions, action)) {
          if (role !== item.approver) return 403;
          if (reason.length > 1000 || (action !== 'approve' && !reason)) return 400;
          if (record) return 409;
          await saveDecision(db, period, groupId, role, action, reason);
          return;
        }
        const state = followupState(record, latest?.action, item.exceedsLimit);
        const invalid = followupError(action, state, role, reason);
        if (invalid) return invalid;
        if (action === 'resubmit') {
          await db.query(`INSERT INTO w07_event (period, group_id, role, action, reason, acted_at)
            VALUES ($1,$2,$3,$4,$5,$6)`, [...ids, record.role, record.action, record.reason, record.acted_at]);
          await db.query('DELETE FROM w07_decision WHERE period = $1 AND group_id = $2', ids);
        }
        await db.query('INSERT INTO w07_event (period, group_id, role, action, reason) VALUES ($1,$2,$3,$4,$5)',
          [...ids, role, action, reason]);
      });
      if (error) return send(error, {
        400: '필요한 내용이나 사유를 1~1,000자로 입력해 주세요.',
        403: '현재 업무 역할에 해당 작업 권한이 없습니다.',
        409: '화면을 새로 열어 현재 처리 단계를 확인해 주세요.',
      }[error]);
      const next = new URLSearchParams({ period, role, ...(item && action !== 'reset' ? { group: groupId } : {}) });
      response.writeHead(303, { Location: '/?' + next.toString() }).end();
      return;
    }

    const saved = new Map(rows.map(row => [row.group_id, row]));
    const eventsFor = id => events.filter(event => event.group_id === id);
    const stateFor = entry => followupState(saved.get(entry.group.groupId),
      eventsFor(entry.group.groupId).at(-1)?.action, entry.exceedsLimit);
    const onHold = state => ['draft', 'waiting', 'received', 'verified'].includes(state);
    const statusFor = entry => {
      if (isAffected(entry)) return '재검토 필요' + (saved.get(entry.group.groupId)?.created_at ? ' · 확인 대기' : '');
      const state = stateFor(entry);
      if (onHold(state)) return '보류 · ' + labels[state];
      return labels[state] ?? decisions[saved.get(entry.group.groupId)?.action] ?? '승인 대기';
    };
    const options = (values, selected) => values.map(value =>
      '<option' + (value === selected ? ' selected' : '') + '>' + escape(value) + '</option>').join('');
    const members = entry => entry.group.members.map(member => escape(member.agencyId)).join(', ');
    const groupLink = entry => '<a href="' + link({ group: entry.group.groupId }) + '">' +
      escape(entry.group.groupId) + '</a>';
    let content;
    let detailView = false;
    let nextTask = '승인 요청을 선택하세요.';
    if (view === 'documents') {
      nextTask = '대리점 서류를 접수하거나 접수 목록을 확인하세요.';
      content = documentView({ data, documents, calls, selectedId: documentId, selectedAgency: query.get('agency'),
        link: extras => link({ ...extras, ...caseContext }), escape, table, role });
    } else if (view === 'review') {
      nextTask = '변경된 승인 경로와 재검토 대상을 확인하세요.';
      content = reviewView(reviews, { escape, table, source, money, link });
    } else if (view === 'ai-log') {
      nextTask = '호출 기록을 열어 요청과 응답을 확인하세요.';
      content = aiLog(calls, escape, table, time);
    } else if (view === 'accounting') {
      nextTask = '지급 검토 작업을 선택하세요.';
      content = '<h2>회계 지급 검토</h2>' + table(['요청 · 계산', '거래처 · 원본', '합계 · 계산', '상태 · 모의', '생성 시각 · 모의'],
        list.filter(entry => (!groupId || entry.group.groupId === groupId) && saved.get(entry.group.groupId)?.created_at).map(entry => [
          groupLink(entry), members(entry), money(entry.totalKrw), statusBadge(statusFor(entry)), time(saved.get(entry.group.groupId).created_at),
        ]));
    } else if (view === 'followup') {
      nextTask = '소명할 요청을 선택하세요.';
      content = '<h2>소명 요청 작업</h2>' + table(['요청 · 계산', '거래처 · 원본', '상태 · 모의'],
        list.filter(entry => onHold(stateFor(entry))).map(entry => [groupLink(entry), members(entry), statusBadge(statusFor(entry))]));
    } else if (item) {
      detailView = true;
      const record = saved.get(groupId);
      const ids = new Set(item.group.members.map(member => member.agencyId));
      const historical = data.rebates.filter(row => ids.has(row.agency_id) && row.period_ym < period)
        .sort((a, b) => a.period_ym.localeCompare(b.period_ym));
      const deposits = data.collections.filter(row => ids.has(row.agency_id));
      const fields = { representative_name: '대표자', address: '주소', bank_account_no: '정산계좌' };
      const enabled = role === item.approver && !record && !isAffected(item);
      const history = eventsFor(groupId);
      const state = stateFor(item);
      const revision = '<input type="hidden" name="revision" value="' + escape(history.at(-1)?.id ?? '0') + '">';
      const actions = Object.entries(steps).filter(([, [from]]) => from === state);
      const draft = calls.filter(call => call.kind === 'draft' && call.group_id === groupId &&
        call.created_at >= (record?.acted_at ?? new Date(0))).at(-1);
      const canDraft = ['draft', 'received'].includes(state) && role === roles[0] && !isAffected(item);
      const draftForm = canDraft ? '<p>요청할 증빙 · 프로젝트 가정</p>' +
        (draft?.result ? '<ul>' + draft.result.evidence.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul>'
          : draft?.finished_at ? '<p>AI 초안 생성 실패, 직접 작성</p>' : '') +
        (draft?.result ? '<p><label>AI 요청서 초안 · 복사 후 수정 <textarea readonly>' +
          escape(draft.result.draft) + '</textarea></label></p>' : '') +
        '<form method="post" data-ai action="' + link({ group: groupId }) +
        '"><button name="action" value="ai_draft">AI 요청서 초안 제안</button></form>' : '';
      const followup = actions.length ? '<h3 id="followup">후속 작업</h3>' + draftForm + '<form method="post" action="' + link({ group: groupId }) +
        '">' + revision + '<fieldset' + (role === actions[0][1][2] && !isAffected(item) ? '' : ' disabled') + '><legend>' + labels[state] +
        '</legend>' + (state === 'verified' ? '' : '<label>내용 또는 확인 근거 <textarea name="reason" maxlength="1000" required>' +
          escape(state === 'draft' && canDraft ? draft?.result?.draft : '') + '</textarea></label> ') +
        actions.map(([action, step]) => '<button name="action" value="' + action + '">' + step[3].replace('모의 ', '') +
          (['send', 'resend', 'reply'].includes(action) ? originBadge('모의') : '') + '</button> ').join('') +
        '</fieldset></form>' : '';
      const timeline = [...history, ...(record ? [record] : []),
        ...(record?.created_at ? [{ acted_at: record.created_at, role: '시스템', action: 'accounting',
          reason: '승인 결과 반영' }] : [])].sort((a, b) => a.acted_at - b.acted_at);
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
      const amountReason = retainedReason
        ? '동일 입금계좌 기록으로 영업임원 승인 경로를 유지합니다.'
        : '합계가 200만원' + (item.exceedsLimit ? '을 넘어 ' : ' 이하여서 ') + item.approver + ' 승인 대상입니다.';
      if (isAffected(item)) {
        nextTask = '정보 변경 재검토에서 승인 경로를 확인하세요. <a href="' + link({ view: 'review' }) + '">바로 가기</a>';
      } else if (record?.action === 'approve') {
        nextTask = '회계 작업에서 지급 검토를 확인하세요. <a href="' + link({ view: 'accounting', role: '회계' }) + '">바로 가기</a>';
      } else if (onHold(state)) {
        const task = { draft: '소명 요청을 작성하세요', waiting: '대리점 답변을 등록하세요',
          received: '대리점 답변을 검토하세요', verified: '임원에게 재상신하세요' }[state];
        nextTask = '영업지원팀 역할로 ' + task + '. <a href="' +
          link({ group: groupId, role: '영업지원팀' }) + '#followup">바로 가기</a>';
      } else if (!record && role !== item.approver) {
        nextTask = escape(item.approver) + ' 승인 대상입니다. <a class="role-switch" href="' +
          link({ group: groupId, role: item.approver }) + '">' + escape(item.approver) + '으로 전환</a>';
      } else {
        nextTask = enabled ? '승인 여부를 결정하세요.' : '기록된 결정을 확인하세요.';
      }
      const decision = enabled ? '<section class="decision-panel"><h3>결정</h3>' +
        '<form method="post" action="' + link({ group: groupId }) +
        '">' + revision + '<label>사유 (거절·추가 확인 시 필수) <textarea name="reason" maxlength="1000"></textarea></label><p>' +
        Object.entries(decisions).map(([value, label]) => '<button' + (value === 'approve' ? ' class="primary"' : '') +
          ' name="action" value="' + value + '">' + label + '</button> ').join('') +
        '</p></form></section>' : '';
      const groupLinks = item.group.links;
      const summaryCall = calls.filter(call => call.kind === 'summary' && call.group_id === groupId &&
        call.created_at >= (record?.acted_at ?? new Date(0)) &&
        call.created_at >= (history.at(-1)?.acted_at ?? new Date(0)) &&
        !reviews.some(review => review.created_at > call.created_at && review.details.scope.agencies.some(id => ids.has(id)))).at(-1);
      const aiSummary = '<section class="ai-summary"><h3>AI 근거 요약</h3>' +
        (summaryCall?.result ? '<p>' + summaryCall.result.sentences.map(escape).join(' ') + '</p>' :
          summaryCall?.finished_at ? '<p>AI 설명 없음 · 근거 표만 확인</p>' : '') +
        '<form method="post" data-ai action="' + link({ group: groupId }) +
        '"><button name="action" value="ai_summary">근거 요약 생성</button></form></section>';
      const collectionRefs = item.collectionEvidence.flatMap(entry => [...entry.deposits, ...entry.registered]
        .map(row => [row.agencyId + (row.depositDate ? ' · ' + row.depositDate : ' · 등록 정보'), [row.source]]));
      const relatedDocs = documents.filter(row => ids.has(row.agency_id));
      const relatedReviews = reviews.filter(row => row.details.scope.agencies.some(id => ids.has(id)));
      const hasClarification = onHold(state) || history.some(row => ['send', 'reply', 'resend', 'verify', 'resubmit'].includes(row.action));
      const stages = [
        ['상신', true], ['임원 결정', item.exceedsLimit], ['소명', hasClarification],
        ['서류 확인', relatedDocs.length > 0], ['재검토', relatedReviews.length > 0],
        ['회계 지급 검토', Boolean(record?.created_at)],
      ];
      const active = relatedReviews.length ? 4 : relatedDocs.some(row => !row.confirmed) ? 3 :
        record?.created_at ? 5 : onHold(state) ? 2 : item.exceedsLimit ? 1 : 0;
      const progress = '<ol class="request-progress" aria-label="처리 단계">' + stages.map(([label, applicable], index) =>
        '<li' + (active === index ? ' aria-current="step"' : applicable ? '' : ' class="not-applicable"') + '>' + label + '</li>').join('') + '</ol>';
      const intake = '<form class="case-intake" method="get"><input type="hidden" name="period" value="' + escape(period) +
        '"><input type="hidden" name="role" value="영업지원팀"><input type="hidden" name="view" value="documents">' +
        '<input type="hidden" name="case" value="' + escape(groupId) + '">' +
        '<label>거래처 <select name="agency">' + options([...ids], groupId) +
        '</select></label> <button>서류 접수</button></form>';
      const related = '<section class="case-work"><h3>연결 작업</h3>' +
        table(['작업', '현황'], [
          ['소명 요청', hasClarification ? '<a href="' + link({ group: groupId, role: '영업지원팀' }) +
            (actions.length ? '#followup' : '#history') + '">' + (onHold(state) ? labels[state] : '소명 기록') + '</a>' : '아직 없습니다'],
          ['접수 서류', relatedDocs.length ? relatedDocs.map(row => '<a href="' +
            link({ view: 'documents', document: row.id, agency: row.agency_id, case: groupId }) + '">' +
            escape(row.agency_id) + ' · 접수 ' + escape(row.id) + '</a>').join('<br>') : '아직 없습니다'],
          ['정보 변경', relatedReviews.length ? relatedReviews.map(row => '<a href="' +
            link({ view: 'review', case: groupId }) + '#review-' + escape(row.id) + '">' +
            escape(row.agency_id) + ' · ' + (row.kind === 'change' ? '계좌 변경' : '그룹 확인') + '</a>').join('<br>') : '아직 없습니다'],
          ['회계 작업', record?.created_at ? '<a href="' + link({ view: 'accounting', group: groupId, role: '회계' }) +
            '">' + statusFor(item) + '</a>' : '아직 없습니다'],
        ]) + intake + '</section>';
      content = '<h2>요청 ' + escape(groupId) + '</h2><div class="summary-cards detail-cards">' +
        cards.map(([label, value, origin]) => '<div class="summary-card"><p>' + label +
          (origin ? originBadge(origin) : '') + '</p><strong>' + value + '</strong></div>').join('') + '</div>' +
        progress + '<p class="decision-explanation">' + escape(groupReason + ' ' + amountReason) + '</p>' +
        '<p class="next-task">' + nextTask + '</p>' +
        decision + aiSummary + related + followup +
        evidence('관련 거래처 근거', '계산', groupLinks.length
          ? table(['거래처', '일치 항목'], groupLinks.map(entry =>
            [entry.agencyIds.map(escape).join(' ↔ '), entry.matchedFields.map(field => fields[field]).join(', ')]))
          : '<p>단독 거래처</p>',
        item.group.members.map(member => [member.agencyId, [member.source]])) +
        evidence('거래처별 장려금', '원본', table(['거래처', '금액'],
          item.rebateRows.map(row => [escape(row.agencyId), money(row.amountKrw)])),
        item.rebateRows.map(row => [row.agencyId + ' · ' + row.rebateId, [row.source]])) +
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
        '<h3 id="history">처리 이력</h3>' +
        table(['시각', '업무 역할', '행동', '내용·사유'], timeline.map(event => [
          time(event.acted_at), escape(event.role),
          (steps[event.action]?.[3].replace('모의 ', '') ?? decisions[event.action] ?? '회계 지급 검토 작업 생성') +
            (['send', 'resend', 'reply'].includes(event.action) ? originBadge('모의') : ''), escape(event.reason),
        ]));
    } else {
      const cards = [
        ['이번 달 승인 요청 수', list.length + '건'],
        ['영업임원 승인 대상 수', list.filter(entry => entry.approver === '영업임원').length + '건'],
        ['200만원 초과 건', '거래처별로 보면 ' + individualExceedance(data.rebates, period) +
          '건 → 묶어서 보면 ' + current.filter(entry => entry.exceedsLimit).length + '건'],
      ];
      const priority = entry => isAffected(entry) || onHold(stateFor(entry)) ? 0 : entry.exceedsLimit ? 1 : 2;
      const ordered = [...list].sort((left, right) => priority(left) - priority(right));
      const selectable = entry => role === roles[0] && entry.approver === roles[0] &&
        !entry.exceedsLimit && !isAffected(entry) && !saved.has(entry.group.groupId);
      const bulk = ordered.some(selectable);
      const requestTable = table([...(bulk ? ['선택'] : []), '요청 · 계산', '구성 거래처 · 원본', '합계 · 계산', '승인권자 · 계산', '현재 상태'],
        ordered.map(entry => [
          ...(bulk ? [selectable(entry) ? '<input type="checkbox" name="request" value="' + escape(entry.group.groupId) +
            '" aria-label="' + escape(entry.group.groupId) + ' 선택">' : ''] : []),
          groupLink(entry), members(entry), money(entry.totalKrw), escape(entry.approver), statusBadge(statusFor(entry)),
        ]), { highlight: ordered.map(entry => priority(entry) < 2) });
      content = '<div class="summary-cards">' + cards.map(([label, value]) =>
        '<div class="summary-card"><p>' + label + originBadge('계산') + '</p><strong>' + value + '</strong></div>').join('') +
        '</div><h2>승인 요청 목록</h2>' + (bulk ? '<form method="post" action="' + link({}) +
          '" onsubmit="return confirm(\'선택한 영업지원팀 전결 건을 승인할까요?\')">' +
          '<button class="primary" name="action" value="bulk_approve">선택 건 승인</button>' + requestTable + '</form>' : requestTable);
    }

    const navigation = {
      requests: '승인 요청', followup: '소명 요청', documents: '대리점 서류 접수',
      review: '정보 변경 재검토', accounting: '회계 작업',
    };
    const activeView = Object.hasOwn(navigation, view) ? view : 'requests';
    const pageTitle = view === 'ai-log' ? 'AI 호출 기록' : navigation[activeView];
    const menu = Object.entries(navigation).map(([key, label]) =>
      '<a href="' + link(key === 'requests' ? {} : { view: key }) + '"' +
      (key === activeView && view !== 'ai-log' ? ' aria-current="page"' : '') + '>' + label + '</a>').join('');
    send(200, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle} | 판매장려금 지급 검토</title><style>${workspaceStyles}</style></head><body>
<div class="workspace">
<aside class="sidebar"><p class="brand">판매장려금 지급 검토</p><nav aria-label="업무 메뉴">${menu}</nav></aside>
<main><header class="toolbar"><h1>${pageTitle}</h1><div class="toolbar-controls">
<form method="get" class="filters"><label>정산월 <select name="period">${options(periods, period)}</select></label>
<label>업무 역할 <select name="role">${options(roles, role)}</select></label>
${groupId ? '<input type="hidden" name="group" value="' + escape(groupId) + '"><input type="hidden" name="groupPeriod" value="' + escape(period) + '">' : ''}
${['accounting', 'followup', 'documents', 'review', 'ai-log'].includes(view) ? '<input type="hidden" name="view" value="' + escape(view) + '">' : ''}
<button class="primary">적용</button></form>
<details class="settings"><summary>설정</summary><div class="settings-panel"><p><a href="${link({ view: 'ai-log' })}">AI 호출 기록</a></p>
<form method="post" action="${link({})}" onsubmit="return confirm('이 정산월의 시연 기록을 초기화할까요?')">
<button name="action" value="reset">정산월 초기화</button></form></div></details></div></header>
<div class="content">${detailView ? '' : '<p class="next-task">' + nextTask + '</p>'}${caseContext.case ? '<p><a href="' +
  link({ group: caseContext.case }) + '">요청 ' + escape(caseContext.case) + ' 상세로 돌아가기</a></p>' : ''}${content}</div>
<footer class="workspace-footer"><p>원본은 제공 자료의 값 · 계산은 시스템 산출값</p></footer>
</main></div><script>
for(const form of document.querySelectorAll('form[data-ai]')) form.addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter;
  button.disabled=true;
  const message=document.createElement('p');
  message.setAttribute('role','status');
  message.textContent='AI 요청 중 · 직접 입력 가능';
  form.after(message);
  try {
    const response=await fetch(form.getAttribute('action'),{method:'POST',body:new URLSearchParams([[button.name,button.value]])});
    if(!response.ok) throw Error();
    message.replaceChildren();
    const link=document.createElement('a');
    link.href=response.url;
    link.textContent='AI 결과 확인';
    message.append(link);
  } catch { message.textContent='AI 요청 실패, 직접 입력 또는 작성'; }
  finally { button.disabled=false; }
});
</script></body></html>`);
  };
}
