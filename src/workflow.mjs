import { steps, labels, followupState, followupError } from './followup.mjs';

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

function table(headers, rows) {
  return '<table><thead><tr>' + headers.map(header => '<th scope="col">' + header + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') +
    '</tr>').join('') + '</tbody></table>';
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

export function createWorkflow(pool, readData, calculate) {
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
    }).catch(error => { schema = undefined; throw error; });
    return schema;
  }

  return async function workflow(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams;
    const role = roles.includes(query.get('role')) ? query.get('role') : roles[0];
    const data = await readData();
    const result = calculate(data);
    const periods = [...new Set(result.requests.map(item => item.period))].sort().reverse();
    const period = query.get('period') ?? periods[0];
    const groupId = query.get('groupPeriod') && query.get('groupPeriod') !== period ? null : query.get('group');
    const list = result.requests.filter(item => item.period === period);
    const item = list.find(entry => entry.group.groupId === groupId);
    const view = query.get('view');
    const link = extras => '/?' + escape(new URLSearchParams({ period, role, ...extras }).toString());
    const send = (status, content) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(content);
    };

    if (!periods.includes(period) || (groupId && !item)) return send(404, '정산 요청을 찾을 수 없습니다.');
    await ensureSchema();

    if (request.method === 'POST') {
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
        return send(403, '앱 화면에서 다시 시도해 주세요.');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) return send(413, '입력 길이를 줄여 주세요.');
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const action = form.get('action');
      const reason = (form.get('reason') ?? '').trim();
      if (!item && action !== 'reset') return send(400, '잘못된 요청입니다.');
      const error = await transaction(pool, period, async db => {
        if (action === 'reset') {
          await db.query('DELETE FROM w07_event WHERE period = $1', [period]);
          await db.query('DELETE FROM w07_decision WHERE period = $1', [period]);
          return;
        }
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
          await db.query(`INSERT INTO w07_decision (period, group_id, role, action, reason)
            VALUES ($1,$2,$3,$4,$5)`, [...ids, role, action, reason]);
          if (action === 'approve') {
            await db.query('INSERT INTO w07_accounting_task (period, group_id) VALUES ($1,$2)', ids);
          }
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
        403: '현재 시연 역할에 해당 작업 권한이 없습니다.',
        409: '화면을 새로 열어 현재 처리 단계를 확인해 주세요.',
      }[error]);
      const next = new URLSearchParams({ period, role, ...(item && action !== 'reset' ? { group: groupId } : {}) });
      response.writeHead(303, { Location: '/?' + next.toString() }).end();
      return;
    }

    const [rows, events] = await transaction(pool, period, async db => {
      const decisions = await db.query(`SELECT d.*, t.created_at FROM w07_decision d
        LEFT JOIN w07_accounting_task t USING (period, group_id) WHERE d.period = $1`, [period]);
      const history = await db.query('SELECT * FROM w07_event WHERE period = $1 ORDER BY id', [period]);
      return [decisions.rows, history.rows];
    });
    const saved = new Map(rows.map(row => [row.group_id, row]));
    const eventsFor = id => events.filter(event => event.group_id === id);
    const stateFor = entry => followupState(saved.get(entry.group.groupId),
      eventsFor(entry.group.groupId).at(-1)?.action, entry.exceedsLimit);
    const onHold = state => ['draft', 'waiting', 'received', 'verified'].includes(state);
    const statusFor = entry => {
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
    if (view === 'accounting') {
      content = '<h2>회계 지급 검토</h2>' + table(['요청 · 계산', '거래처 · 원본', '합계 · 계산', '상태 · 모의', '생성 시각 · 모의'],
        list.filter(entry => saved.get(entry.group.groupId)?.created_at).map(entry => [
          groupLink(entry), members(entry), money(entry.totalKrw), statusFor(entry), time(saved.get(entry.group.groupId).created_at),
        ]));
    } else if (view === 'followup') {
      content = '<h2>소명 요청 작업</h2>' + table(['요청 · 계산', '거래처 · 원본', '상태 · 모의'],
        list.filter(entry => onHold(stateFor(entry))).map(entry => [groupLink(entry), members(entry), statusFor(entry)]));
    } else if (item) {
      const record = saved.get(groupId);
      const ids = new Set(item.group.members.map(member => member.agencyId));
      const historical = data.rebates.filter(row => ids.has(row.agency_id) && row.period_ym < period)
        .sort((a, b) => a.period_ym.localeCompare(b.period_ym));
      const deposits = data.collections.filter(row => ids.has(row.agency_id));
      const fields = { representative_name: '대표자', address: '주소', bank_account_no: '정산계좌' };
      const enabled = role === item.approver && !record;
      const history = eventsFor(groupId);
      const state = stateFor(item);
      const revision = '<input type="hidden" name="revision" value="' + escape(history.at(-1)?.id ?? '0') + '">';
      const actions = Object.entries(steps).filter(([, [from]]) => from === state);
      const followup = actions.length ? '<h3>후속 작업 · 모의</h3><form method="post" action="' + link({ group: groupId }) +
        '">' + revision + '<fieldset' + (role === actions[0][1][2] ? '' : ' disabled') + '><legend>' + labels[state] +
        '</legend>' + (state === 'verified' ? '' : '<label>내용 또는 확인 근거 <textarea name="reason" maxlength="1000" required></textarea></label> ') +
        actions.map(([action, step]) => '<button name="action" value="' + action + '">' + step[3] + '</button> ').join('') +
        '</fieldset></form>' : '';
      const timeline = [...history, ...(record ? [record] : []),
        ...(record?.created_at ? [{ acted_at: record.created_at, role: '시스템', action: 'accounting',
          reason: '승인 결과 반영' }] : [])].sort((a, b) => a.acted_at - b.acted_at);
      content = '<h2>요청 ' + escape(groupId) + '</h2><p>구성 거래처 · 원본 ' + members(item) +
        ' | 합계 · 계산 ' + money(item.totalKrw) + ' | 승인권자 · 계산 ' + escape(item.approver) +
        ' | 상태 · 모의 ' + statusFor(item) + '</p>' +
        '<h3>관련 거래처 근거 · 계산</h3>' +
        (item.group.links.length ? table(['거래처', '일치 항목', '원본 행'], item.group.links.map(entry =>
          [entry.agencyIds.map(escape).join(' ↔ '), entry.matchedFields.map(field => fields[field]).join(', '),
            entry.sources.map(source).join('<br>')])) : '<p>단독 거래처</p>') +
        '<h3>거래처별 장려금 · 원본</h3>' + table(['거래처', '금액', '원본 행'],
          item.rebateRows.map(row => [escape(row.agencyId), money(row.amountKrw), source(row.source)])) +
        '<h3>이전 정산월 지급 기록 · 원본</h3><p>현재 그룹 구성원 기준</p>' +
        table(['정산월', '거래처', '금액', '원본 상태', '승인자', '지급일', '원본 행'], historical.map(row =>
          [row.period_ym, row.agency_id, money(Number(row.rebate_amount_krw)), row.approval_status,
            row.approver, row.payment_date].map(escape).concat(source(row.source)))) +
        '<h3>입금 기록 · 원본</h3>' +
        table(['거래처', '입금일', '입금계좌', '원본 행'], deposits.map(row =>
          [escape(row.agency_id), escape(row.deposit_date), mask(row.bank_account_no), source(row.source)])) +
        '<h3>입금계좌 대조 · 원본과 계산</h3><p>회수 기록과 정산계좌 일치 근거 · 계좌 끝자리만 표시</p>' +
        table(['입금계좌 · 원본', '회수 기록 · 원본', '정산계좌 일치 · 계산'], item.collectionEvidence.map(entry => [
          mask(entry.account),
          entry.deposits.map(row => [escape(row.agencyId), escape(row.depositDate), source(row.source)].join(' · ')).join('<br>'),
          entry.registered.map(row => escape(row.agencyId) + ' · ' + source(row.source)).join('<br>'),
        ])) +
        '<h3>결정 · 모의 입력</h3><form method="post" action="' + link({ group: groupId }) +
        '">' + revision + '<fieldset' + (enabled ? '' : ' disabled') +
        '><legend>시연 역할 ' + escape(role) + '</legend><label>사유 <textarea name="reason" maxlength="1000"></textarea></label>' +
        '<p>거절과 추가 확인 요청은 사유 필수</p>' +
        Object.entries(decisions).map(([value, label]) => '<button name="action" value="' + value + '">' + label + '</button> ').join('') +
        '</fieldset></form>' + followup + '<h3>처리 이력 · 모의</h3>' +
        table(['시각', '시연 역할', '행동', '내용·사유'], timeline.map(event => [
          time(event.acted_at), escape(event.role),
          steps[event.action]?.[3] ?? decisions[event.action] ?? '회계 지급 검토 작업 생성', escape(event.reason),
        ]));
    } else {
      content = '<h2>승인 요청 <small>' + list.length + '건</small></h2>' +
        table(['요청 · 계산', '구성 거래처 · 원본', '합계 · 계산', '승인권자 · 계산', '현재 상태 · 모의'],
          list.map(entry => [groupLink(entry), members(entry), money(entry.totalKrw), escape(entry.approver),
            statusFor(entry)]));
    }

    send(200, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>W07 판매장려금 지급 검토</title><style>
body{font:16px system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:75rem;color:#17212d}
table{border-collapse:collapse;width:100%;margin:1rem 0;overflow-wrap:anywhere}
th,td{text-align:left;padding:.55rem;border:1px solid #ccd2db;vertical-align:top}
th{background:#f3f5f8}button,select,textarea{font:inherit}nav,form{margin:1rem 0}
fieldset{border:1px solid #ccd2db}textarea{vertical-align:middle;width:min(100%,34rem)}
</style></head><body><main><h1>W07 판매장려금 지급 검토</h1>
<form method="get"><label>정산월 <select name="period">${options(periods, period)}</select></label>
<label>시연 역할 <select name="role">${options(roles, role)}</select></label>
${groupId ? '<input type="hidden" name="group" value="' + escape(groupId) + '"><input type="hidden" name="groupPeriod" value="' + escape(period) + '">' : ''}
${['accounting', 'followup'].includes(view) ? '<input type="hidden" name="view" value="' + escape(view) + '">' : ''}
<button>적용</button></form>
<nav><a href="${link({})}">승인 요청 목록</a> · <a href="${link({ view: 'followup' })}">소명 요청 작업 목록</a> · <a href="${link({ view: 'accounting' })}">회계 작업 목록</a></nav>
${content}
<details><summary>정산월 초기화</summary><p>${escape(period)}의 공유 결정·소명·이력·회계 작업을 초기화합니다.</p>
<form method="post" action="${link({})}" onsubmit="return confirm('이 정산월의 시연 기록을 초기화할까요?')">
<button name="action" value="reset">정산월 초기화</button></form></details>
</main></body></html>`);
  };
}
