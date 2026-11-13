// 역할별 화면(S01~S20). workflow.mjs가 만든 업무 상태(c)를 받아 HTML 조각을 돌려준다.
import { conditionCatalog, confirmedConditions, masterCheckResults, postAuditCause, postAuditConclusions, verdictLabels } from './controls.mjs';
import { addBusinessDays, allRequestedItems, itemMarks, mergedAnswers, requestItems, resendItems } from './requests.mjs';
import { fields as extractFields } from './condition.mjs';
import { bar, escape, icon, manwon, mask, money, pill, recordFields, src, table, time, today } from './ui.mjs';
import { metadataView } from './audit.mjs';

const LIMIT = 2_000_000;
const fieldNames = { representative_name: '대표자', address: '주소', bank_account_no: '계좌' };
const onHold = state => ['draft', 'waiting', 'received', 'verified'].includes(state);
const formatHints = { text: '글로 답변', account: '계좌·예금주', yesno: '예/아니오' };
const conclusionTone = { closed: 'gray', audit_report: 'amber', recovery: 'red' };

export function helpers(c) {
  const name = id => c.agencyNames.get(id) ?? id;
  const title = entry => name(entry.group.members[0].agencyId) +
    (entry.group.members.length > 1 ? ' 외 ' + (entry.group.members.length - 1) + '곳' : '');
  const record = entry => c.saved.get(entry.group.groupId);
  const revision = entry => '<input type="hidden" name="revision" value="' + escape(c.eventsFor(entry.group.groupId).at(-1)?.id ?? '0') + '">';
  const post = (extras, body, attrs = '') => '<form method="post" action="' + c.link(extras) + '"' + attrs + '>' + body + '</form>';
  const status = entry => {
    if (!c.open) return ['gray', '✓ 지급 완료'];
    const state = c.stateFor(entry);
    const saved = record(entry);
    const held = c.isAffected(entry);
    if (held && state === 'resubmitted') return ['blue', '◷ 정보 변경 · 임원 재결정 대기'];
    if (held) return ['amber', '! 정보 변경 · 재검토 중'];
    if (state === 'reconciled') return ['green', '✓ 지급 완료 · 대사 끝'];
    if (state === 'paymentReady') return ['blue', '◷ 지급 반영 · 은행 회신 대기'];
    if (state === 'paymentReturned') return ['red', '✕ 지급 반려 · 계좌 재확인'];
    if (state === 'repayReady') return ['blue', '◷ 재지급 대기'];
    if (state === 'paymentPending') {
      const left = (saved.conditions ?? []).filter(id => !confirmedConditions(saved, c.eventsFor(entry.group.groupId)).has(id)).length;
      return left ? ['blue', '◷ 승인 · 회계 조건 확인 중'] : ['blue', '◷ 승인 · 지급 대기'];
    }
    if (state === 'resubmitted') return ['blue', '◷ 영업임원 재결정 대기'];
    if (state === 'draft') return ['red', '✕ 임원 거절 · 확인 요청 필요'];
    if (state === 'waiting') return ['amber', '◷ 거래처 답변 대기'];
    if (state === 'received') return ['amber', '! 거래처 답변 도착'];
    if (state === 'verified') return ['amber', '! 임원에게 다시 올리기'];
    if (!saved && entry.exceedsLimit) return ['blue', '◷ 영업임원 결정 대기'];
    if (!saved) return ['gray', '팀 승인 대기'];
    return ['gray', saved.action];
  };
  const statusPill = entry => pill(...status(entry));
  const outsideDeposits = entry => entry.collectionEvidence.flatMap(evidence => evidence.deposits
    .filter(row => !evidence.registered.some(registered => registered.agencyId === row.agencyId) && evidence.registered.length)
    .map(row => ({ ...row, account: evidence.account, owners: evidence.registered.map(registered => registered.agencyId) })));
  const pastFor = entry => c.past.find(row => row.groupId === entry.group.groupId);
  return { name, title, record, revision, post, status, statusPill, outsideDeposits, pastFor };
}

function summaryCard(c, h, entry, { compact = false } = {}) {
  const links = entry.group.links;
  const reps = links.some(link => link.matchedFields.includes('representative_name'));
  const headline = entry.group.members.length > 1
    ? entry.group.members.length + '곳을 한 거래처로 보고 합산했어요'
    : '단독 거래처예요';
  const why = entry.group.members.length > 1
    ? (reps ? '대표자가 같고, ' : '') + [...new Set(links.flatMap(link => link.matchedFields))].filter(field => field !== 'representative_name')
      .map(field => fieldNames[field]).join('나 ') + (reps ? '도 겹칩니다.' : '가 겹칩니다.')
    : '연결된 거래처가 없어요.';
  const over = entry.totalKrw > LIMIT;
  return '<section class="card" aria-labelledby="sum"><h2 id="sum" style="font-size:18px">' + headline + '</h2>' +
    '<p class="muted" style="font-size:14px;margin:4px 0 16px">' + escape(why) + '</p>' +
    (compact ? '' : '<p class="muted" style="margin-bottom:6px">거래처별 ' + Number(entry.period.slice(5)) + '월 장려금' + src('raw') + '</p><div class="agencies">' + entry.rebateRows.map(row => '<div class="agency"><b>' + escape(h.name(row.agencyId)) +
      '</b><span class="muted">' + escape(row.agencyId) + '</span><strong>' + money(row.amountKrw) + '</strong></div>').join('') + '</div>' +
      (links.length ? '<div class="line" style="gap:18px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:#35455a"><span class="muted">같은 등록 정보' + src('raw') + '</span>' + links.map(link =>
        '<span>' + link.agencyIds.map(id => escape(h.name(id))).join(' – ') + ' ' + link.matchedFields.map(field =>
          '<span class="tag">' + fieldNames[field] + '</span>').join(' ') + '</span>').join('') + '</div>' : '')) +
    '<div style="margin-top:20px"><div class="line" style="justify-content:space-between;align-items:baseline"><span class="muted" style="font-size:14px">' +
    Number(entry.period.slice(5)) + '월 합계' + src('calc') + '</span><strong style="font-size:22px">' + money(entry.totalKrw) + '</strong></div>' + bar(entry.totalKrw, LIMIT) +
    '<p class="note">' + (over ? (entry.group.members.length > 1 && entry.rebateRows.every(row => row.amountKrw <= LIMIT)
      ? '각각은 한도 안이지만 합치면 넘어서 <strong>영업임원 승인</strong>이 필요해요.' : '한도를 넘어 <strong>영업임원 승인</strong>이 필요해요.')
      : '한도 안이라 <strong>영업지원팀이 승인</strong>해요.') + src('calc', '정책 적용') + '</p></div>' +
    (links.length ? '<details style="margin-top:12px"><summary>판단 근거 자세히</summary>' + table(['두 거래처', '같은 항목', '결과'],
      groupPairs(entry).map(([pair, matched, result]) => [pair, matched, result])) +
      '<p class="muted" style="margin-top:6px;font-size:12px">기준: 대표자·주소·정산계좌 중 2개 이상 같으면 연결 · 자료 위치 ' +
      entry.group.members.map(member => escape(member.source.file + ':' + member.source.row)).join(', ') + '</p></details>' : '') +
    '</section>';
}

function groupPairs(entry) {
  const members = entry.group.members.map(member => member.agencyId);
  const linked = new Map(entry.group.links.map(link => [link.agencyIds.join('|'), link]));
  const pairs = [];
  for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
    const link = linked.get(members[i] + '|' + members[j]) ?? linked.get(members[j] + '|' + members[i]);
    pairs.push([escape(members[i] + ' · ' + members[j]), link ? link.matchedFields.map(field => fieldNames[field]).join(', ') : '1개 이하',
      link ? '연결' : '다른 거래처를 거쳐 연결']);
  }
  return pairs;
}

function history(c, entry) {
  const labels = { send: '거래처 확인 요청', reply: '거래처 답변', resend: '보완 요청', verify: '답변 확인', resubmit: '임원에게 다시 올림',
    payment: '지급 시스템 반영', condition_check: '승인 조건 확인', document_received: '서류 접수', account_changed: '계좌 변경 적용',
    review_approve: '재검토 승인', review_reject: '재검토 거절', review_clarify: '재검토 추가 확인', dispute: '묶음 이의 제기',
    dispute_close: '이의 제기 처리', remind: '임원에게 다시 알림', ack: '확인할 점 확인', unack: '확인 취소', post_audit_done: '지난 지급 점검 결론',
    approve: '승인', reject: '거절', clarify: '추가 확인 요청', recovery_done: '회수 확인' };
  const record = c.saved.get(entry.group.groupId);
  const rows = [...c.eventsFor(entry.group.groupId), ...(record ? [record] : [])]
    .sort((a, b) => new Date(b.acted_at) - new Date(a.acted_at));
  return '<details class="card tight" id="history"><summary>처리 이력 ' + rows.length + '</summary>' +
    table(['업무일', '누가', '무엇을', '내용', '기록 시각'], rows.map(event => [escape(event.metadata?.occurredOn ?? '—'), escape(event.role),
      (event.action === 'approve' && event.conditions?.length ? '조건부 승인' : labels[event.action] ?? escape(event.action)),
      escape(event.reason).replace(/\n/g, '<br>') + (event.conditions?.length ? '<br><span class="muted">조건: ' +
        event.conditions.map(id => escape(conditionCatalog[id] ?? id)).join(', ') + '</span>' : '') +
        (event.metadata?.source ? ' <span class="muted">· ' + (event.metadata.source === 'scenario' ? '추가 시나리오 자료' : '가상 회신·직접 입력') + '</span>' : ''),
      '<span class="muted">' + time(event.acted_at) + '</span>']), { empty: '아직 기록이 없어요' }) + '</details>';
}

/* ---------- 영업지원팀 ---------- */

export function supportHome(c, h) {
  const teamPending = c.list.filter(entry => c.selectable(entry));
  const mine = c.list.filter(entry => ['draft', 'received', 'verified'].includes(c.stateFor(entry)));
  const docs = c.documents.filter(row => !row.applied);
  const moving = c.list.filter(entry => ['resubmitted', 'paymentPending'].includes(c.stateFor(entry)) ||
    (entry.exceedsLimit && !c.saved.has(entry.group.groupId) && !c.isAffected(entry)));
  const recovery = c.past.filter(row => row.conclusion === 'recovery' && !row.recoveryDone);
  const todo = [
    ...mine.map(entry => {
      const state = c.stateFor(entry);
      const due = c.eventsFor(entry.group.groupId).findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;
      return ['급함', c.link({ view: 'followup', group: entry.group.groupId }), h.title(entry) + ' · ' +
        { draft: '거래처 확인 요청 만들기', received: '거래처 답변 검토', verified: '임원에게 다시 올리기' }[state],
        state === 'received' ? '답변 ' + Object.keys(mergedAnswers(c.eventsFor(entry.group.groupId))).length + '곳 도착' : '임원이 거절했어요',
        due ? '기한 ' + due.slice(5) : ''];
    }),
    ...docs.map(row => ['확인', c.link({ view: 'documents', document: row.id }), h.name(row.agency_id) + ' · 서류 확인',
      row.confirmed ? '확인 저장됨 · 적용 대기' : '접수 ' + (row.received_at ? time(row.received_at) : ''), '']),
    ...c.list.filter(entry => c.stateFor(entry) === 'paymentReturned').map(entry => ['급함', c.link({ view: 'requests', group: entry.group.groupId }),
      h.title(entry) + ' · 지급 반려 계좌 재확인', '은행 회신(모의)에서 반려됐어요', '']),
    ...recovery.map(row => ['확인', c.link({ view: 'post-audit', audit: row.groupId }), h.name(row.groupId) + ' 외 · 회수 확인', '회계가 회수 검토로 결론 냈어요', '']),
    ...(teamPending.length ? [['일반', c.link({ view: 'requests' }), Number(c.period.slice(5)) + '월 팀 승인 ' + teamPending.length + '건 · 일괄 승인',
      '모두 한도 안 · ' + money(teamPending.reduce((sum, entry) => sum + entry.totalKrw, 0)), '']] : []),
  ];
  return '<div class="top"><div><p class="muted">' + escape(c.period) + ' 정산</p><h1>오늘 할 일 ' + todo.length + '</h1></div></div>' +
    '<div class="stats">' +
    '<a class="stat" href="' + c.link({ view: 'requests' }) + '"><span>팀 승인 대기</span><strong>' + teamPending.length + '건</strong><span>' +
      money(teamPending.reduce((sum, entry) => sum + entry.totalKrw, 0)) + '</span></a>' +
    '<a class="stat" href="' + c.link({ view: 'followup' }) + '"><span>거래처 확인 · 내 차례</span><strong>' + mine.length + '건</strong><span>' +
      (mine.length ? '답변 검토·요청 작성' : '할 일 없음') + '</span></a>' +
    '<a class="stat" href="' + c.link({ view: 'documents' }) + '"><span>서류 확인</span><strong>' + docs.length + '건</strong><span>' +
      (docs.length ? '거래처가 보낸 서류' : '새 서류 없음') + '</span></a>' +
    '<a class="stat" href="' + c.link({ view: 'requests', tab: 'others' }) + '"><span>임원·회계 진행 중</span><strong>' + moving.length + '건</strong><span>내 할 일 없음</span></a>' +
    '</div><section class="card" style="padding:0;overflow:hidden" aria-labelledby="todo"><div class="line" style="justify-content:space-between;padding:14px 20px">' +
    '<h2 id="todo">처리 순서</h2><span class="muted">급한 순</span></div>' +
    (todo.length ? todo.map(([tag, href, text, sub, due]) => '<a class="todo" href="' + href + '"><span class="tag">' + tag + '</span><span style="flex:1"><strong>' +
      escape(text) + '</strong><br><span class="muted">' + escape(sub) + '</span></span><span class="muted">' + escape(due) + '</span><span aria-hidden="true" class="muted">›</span></a>').join('')
      : '<p class="empty">오늘 할 일을 모두 마쳤어요</p>') + '</section>';
}

export function supportList(c, h) {
  const tab = ['mine', 'others', 'hold', 'done', 'all'].includes(c.query.get('tab')) ? c.query.get('tab') : 'mine';
  const q = (c.query.get('q') ?? '').trim();
  const match = entry => !q || entry.group.members.some(member => member.agencyId.includes(q) || h.name(member.agencyId).includes(q));
  const groups = {
    mine: entry => c.selectable(entry),
    others: entry => !c.selectable(entry) && !onHold(c.stateFor(entry)) && !['paymentPending', 'paymentReady', 'reconciled', 'paymentReturned', 'repayReady'].includes(c.stateFor(entry)) && !c.saved.has(entry.group.groupId) || c.stateFor(entry) === 'resubmitted',
    hold: entry => onHold(c.stateFor(entry)) || c.isAffected(entry),
    done: entry => ['paymentPending', 'paymentReady', 'reconciled', 'paymentReturned', 'repayReady'].includes(c.stateFor(entry)),
    all: () => true,
  };
  const counts = Object.fromEntries(Object.entries(groups).map(([key, test]) => [key, c.list.filter(test).length]));
  const rows = c.list.filter(groups[tab]).filter(match).sort((a, b) => Number(b.group.members.length > 1) - Number(a.group.members.length > 1));
  const selectable = rows.filter(entry => c.selectable(entry));
  const pending = c.past.filter(row => !row.conclusion);
  const tabLabels = { mine: '내 할 일', others: '임원 대기', hold: '보류·거래처 확인', done: '완료', all: '전체' };
  const listTable = table([...(c.open && selectable.length ? ['선택'] : []), '거래처', '장려금' + src('raw', '원본·합계'), '승인' + src('calc'), '상태'],
    rows.map(entry => [
      ...(c.open && selectable.length ? [c.selectable(entry) ? '<input type="checkbox" name="request" value="' + escape(entry.group.groupId) + '" checked aria-label="' + escape(h.title(entry)) + ' 선택">' : ''] : []),
      '<a href="' + c.link({ view: 'requests', group: entry.group.groupId }) + '"><strong>' + escape(h.title(entry)) + '</strong></a>' +
        (entry.group.members.length > 1 ? ' <span class="tag">관련자 ' + entry.group.members.length + '곳</span>' : '') +
        (h.pastFor(entry) ? ' <span class="tag" style="background:#fff1d6;color:#7a3f00">과거 초과</span>' : '') +
        '<br><span class="muted">' + entry.group.members.map(member => escape(member.agencyId)).join(' · ') + '</span>',
      money(entry.totalKrw), entry.approver === '영업임원' ? '영업임원' : '팀 승인', h.statusPill(entry),
    ]), { numeric: [c.open && selectable.length ? 2 : 1], empty: q ? '찾는 거래처가 없어요' : '이 목록은 비어 있어요' });
  return '<div class="top"><div><p class="muted">' + Number(c.period.slice(5)) + '월분' + (c.open ? '' : ' · 지급이 끝난 달이에요') + '</p><h1>승인 요청</h1></div></div>' +
    (pending.length ? '<div class="card tight warn line" style="justify-content:space-between;flex-wrap:wrap">' + icon('warn') +
      '<span style="flex:1">' + escape(h.name(pending[0].groupId)) + ' 외 ' + (pending[0].members.length - 1) + '곳의 1~' +
      Number(pending[0].months.at(-1).period.slice(5)) + '월 지급을 회계가 점검하고 있어요</span><a href="' + c.link({ view: 'post-audit', audit: pending[0].groupId }) + '">보기</a></div>' : '') +
    '<section class="card" style="display:flex;flex-direction:column;gap:12px"><div class="line" style="justify-content:space-between;flex-wrap:wrap">' +
    '<div class="tabs">' + Object.entries(tabLabels).map(([key, label]) => '<a class="btn tab" href="' + c.link({ view: 'requests', tab: key }) + '"' +
      (key === tab ? ' aria-current="page"' : '') + '>' + label + ' ' + counts[key] + '</a>').join('') + '</div>' +
    '<form method="get" class="line"><input type="hidden" name="period" value="' + escape(c.period) + '"><input type="hidden" name="view" value="requests"><input type="hidden" name="tab" value="' + tab + '">' +
    '<input type="search" name="q" value="' + escape(q) + '" placeholder="거래처 이름·ID" aria-label="거래처 검색" style="min-width:200px"></form></div>' +
    (c.open && selectable.length && c.role === '영업지원팀' ? h.post({ view: 'requests' },
      '<div class="line" style="justify-content:space-between;flex-wrap:wrap;padding:10px 12px;background:#f5f8fc;border-radius:10px">' +
      '<span><strong data-count>' + selectable.length + '건 선택</strong> · <span data-sum>' + money(selectable.reduce((sum, entry) => sum + entry.totalKrw, 0)) + '</span> · 모두 한도 안</span>' +
      '<button class="primary" name="action" value="bulk_approve">선택한 건 승인</button></div>' + listTable, ' data-bulk') : listTable) + '</section>';
}

export function supportDetail(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const state = c.stateFor(entry);
  const record = h.record(entry);
  const [tone, text] = h.status(entry);
  const events = c.eventsFor(id);
  const reject = c.decisionReason(entry);
  const deposits = h.outsideDeposits(entry);
  const past = h.pastFor(entry);
  const acked = key => events.filter(event => ['ack', 'unack'].includes(event.action) && event.metadata?.key === key).at(-1)?.action === 'ack';
  const dispute = events.filter(event => ['dispute', 'dispute_close'].includes(event.action)).at(-1);
  const role0 = c.role === '영업지원팀' && c.open;
  let next;
  if (!c.open) next = ['지급이 끝난 달이에요.', '보기만 할 수 있어요.', ''];
  else if (state === 'draft') next = ['거래처에 확인을 요청해야 해요.', reject ? '임원 의견: ' + reject : '', '<a class="btn primary" href="' + c.link({ view: 'followup', group: id }) + '">확인 요청 만들기</a>'];
  else if (state === 'waiting') next = ['거래처 답변을 기다리고 있어요.', '', '<a class="btn" href="' + c.link({ view: 'followup', group: id }) + '">요청 보기</a>'];
  else if (state === 'received') next = ['거래처 답변이 왔어요.', '', '<a class="btn primary" href="' + c.link({ view: 'followup', group: id }) + '">답변 검토</a>'];
  else if (state === 'verified') next = ['확인이 끝났어요. 임원에게 다시 올려 주세요.', '', '<a class="btn primary" href="' + c.link({ view: 'followup', group: id }) + '">다시 올리기</a>'];
  else if (state === 'paymentPending') next = ['회계가 지급을 준비하고 있어요.', (record.conditions ?? []).length ? '승인 조건 ' + record.conditions.length + '개 확인 중' : '', ''];
  else if (state === 'paymentReady') next = ['지급 시스템에 반영됐어요.', '은행 회신을 기다려요 (모의).', ''];
  else if (state === 'reconciled') next = ['지급과 대사가 끝났어요.', '더 할 일은 없어요.', ''];
  else if (state === 'repayReady') next = ['회계가 반려분을 다시 지급해요.', '', ''];
  else if (state === 'paymentReturned') {
    const returned = events.findLast(event => event.action === 'payment_returned');
    const rows = Object.entries(returned?.metadata?.results ?? {}).filter(([, row]) => row.result === 'rejected');
    next = ['은행이 일부 지급을 반려했어요. 받는 계좌를 다시 확인해 주세요.', rows.map(([agencyId, row]) => h.name(agencyId) + ' · ' + row.reason).join(', '),
      role0 ? h.post({ view: 'requests', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
        '<div class="line" style="flex-wrap:wrap"><input name="reason" maxlength="1000" required placeholder="확인 내용 · 예: 예금주 표기 정정 확인" aria-label="확인 내용" style="width:auto;flex:1 1 240px">' +
        '<button class="primary" name="action" value="payee_recheck">재확인 완료</button></div>') : ''];
  }
  else if (!record && entry.exceedsLimit || state === 'resubmitted') {
    const reminded = events.findLast(event => event.action === 'remind');
    next = ['영업임원이 결정할 차례예요.', reminded ? '다시 알림 ' + time(reminded.acted_at) : '',
      role0 ? h.post({ view: 'requests', group: id }, '<button name="action" value="remind">임원에게 다시 알리기</button>') : ''];
  } else if (!record) {
    next = ['영업지원팀이 승인하면 돼요.', '', role0 && c.selectable(entry) ? h.post({ view: 'requests', group: id },
      '<input type="hidden" name="request" value="' + escape(id) + '"><button class="primary" name="action" value="bulk_approve">승인</button>') : ''];
  } else next = ['처리가 끝났어요.', '', ''];
  const checks = [
    ...(deposits.length ? [['deposit', h.name(deposits[0].agencyId) + '가 다른 곳 계좌로 ' + deposits.length + '번 입금했어요',
      '<a href="#deposits">입금 보기</a>']] : []),
    ...(past ? [['past', '1~' + Number(past.months.at(-1).period.slice(5)) + '월에도 한도를 넘었는데 팀 승인으로 지급됐어요',
      '<a href="' + c.link({ view: 'post-audit', audit: past.groupId }) + '">지난 지급 점검</a>']] : []),
  ];
  const disputeKinds = { not_same: '같은 사람이 아니에요 (동명이인)', changed: '주소나 계좌가 이미 바뀌었어요', other: '기타' };
  return '<div><p class="crumb"><a href="' + c.link({ view: 'requests' }) + '">승인 요청</a> › ' + Number(c.period.slice(5)) + '월</p>' +
    '<div class="top" style="align-items:flex-end"><h1>' + escape(h.title(entry)) + '</h1>' + pill(tone, text) + '</div></div>' +
    (c.open ? '' : '<div class="card tight" style="background:#eef2f7">🔒 지급이 끝난 달이에요. 보기만 할 수 있어요.</div>') +
    '<section class="card focus" style="padding:16px 20px" id="current-task"><p class="muted" style="font-weight:600">다음 단계</p>' +
    '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><p><strong>' + escape(next[0]) + '</strong> <span class="muted">' + escape(next[1]) + '</span></p>' + next[2] + '</div></section>' +
    summaryCard(c, h, entry) +
    (role0 && entry.group.members.length > 1 ? '<section class="card tight">' + (dispute?.action === 'dispute'
      ? '<p>' + icon('wait') + ' 묶음 이의 제기 접수 · 관리자 검토 중 <span class="muted">' + time(dispute.acted_at) + '</span></p>'
      : (dispute ? '<p class="muted" style="margin-bottom:8px">지난 이의 제기: ' + (dispute.metadata?.result === 'fixed' ? '받아들여짐' : '묶음 유지') + ' · ' + escape(dispute.reason) + '</p>' : '') +
        '<details><summary>묶음이 잘못됐나요? 이의 제기</summary>' + h.post({ view: 'requests', group: id },
          '<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px"><select name="disputeKind" aria-label="이유">' +
          Object.entries(disputeKinds).map(([value, label]) => '<option value="' + value + '">' + label + '</option>').join('') + '</select>' +
          '<textarea name="reason" maxlength="1000" required placeholder="확인한 내용을 적어 주세요. 관리자가 검토하는 동안 이 요청은 그대로 진행돼요."></textarea>' +
          '<div><button class="primary" name="action" value="dispute">관리자에게 보내기</button></div></div>') + '</details>') + '</section>' : '') +
    (checks.length ? '<section class="card" style="padding-bottom:8px"><div class="line" style="justify-content:space-between"><h2>확인할 점</h2><span class="muted">' +
      checks.filter(([key]) => !acked(key)).length + '건 남음</span></div><div class="rows">' + checks.map(([key, label, more]) =>
        '<div class="row"><span class="line">' + (acked(key) ? icon('ok') : icon('warn')) + '<span' + (acked(key) ? ' style="color:#7b8798"' : '') + '>' + escape(label) +
        '</span>' + src(key === 'deposit' ? 'raw' : 'calc', key === 'deposit' ? '원본 입금' : '원본·계산') + '</span><span class="line">' + more + (role0 ? h.post({ view: 'requests', group: id }, '<input type="hidden" name="key" value="' + key +
          '"><button class="small" name="action" value="ack">' + (acked(key) ? '되돌리기' : '확인함') + '</button>') : '') + '</span></div>').join('') + '</div>' +
      (deposits.length ? '<details id="deposits" style="margin:6px 0 8px"><summary>입금 기록</summary>' + table(['입금', '거래처', '들어간 계좌', '그 계좌의 등록 거래처'],
        deposits.map(row => [escape(row.depositId) + '<br><span class="muted">' + escape(row.depositDate) + '</span>', escape(h.name(row.agencyId)), mask(row.account),
          row.owners.map(owner => escape(h.name(owner))).join(', ')])) +
        '<p class="muted" style="font-size:12px">입금 계좌가 다른 거래처 등록계좌와 같다는 사실만 보여요. 장려금을 받은 계좌라고 단정하지 않아요.</p></details>' : '') + '</section>' : '') +
    history(c, entry);
}

export function pastMonthDetail(c, h) {
  const entry = c.item;
  const paid = c.data.rebates.filter(row => entry.rebateRows.some(rebate => rebate.rebateId === row.rebate_id));
  const team = paid.every(row => row.approver === '영업지원팀');
  const nextOpen = c.periods.find(month => month > c.period && c.isOpenPeriod(month));
  return '<div class="card tight line" style="background:#eef2f7;justify-content:space-between;flex-wrap:wrap"><span>🔒 지급이 끝난 ' + Number(c.period.slice(5)) + '월이에요. 보기만 할 수 있어요.</span>' +
    (nextOpen ? '<a href="/?' + escape(new URLSearchParams({ period: nextOpen, view: 'requests' }).toString()) + '">' + Number(nextOpen.slice(5)) + '월로 가기</a>' : '') + '</div>' +
    '<div><p class="crumb">승인 요청 › ' + Number(c.period.slice(5)) + '월</p><div class="top" style="align-items:flex-end"><h1>' + escape(h.title(entry)) + '</h1>' +
    pill('gray', '✓ ' + ([...new Set(paid.map(row => row.payment_date))].join(', ') || '지급 기록 없음')) + '</div></div>' +
    '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h2>합계 ' + money(entry.totalKrw) + src('calc') + '</h2>' +
    (entry.exceedsLimit ? '<span style="color:#a12a2a;font-weight:700;font-size:14px">▲ 팀 승인 한도 초과</span>' : '') + '</div>' +
    (entry.exceedsLimit && team ? '<p class="note warn">' + icon('warn') + ' 임원 승인이 필요했지만 거래처별로 팀 승인되어 지급됐어요.</p>' : '') +
    '<details style="margin-top:12px"><summary>거래처별 지급 기록 · 원본</summary>' + table(['거래처', '장려금', '승인', '지급일', '자료 위치'], paid.map(row =>
      [escape(h.name(row.agency_id)), money(Number(row.rebate_amount_krw)), escape(row.approver), escape(row.payment_date), escape(row.source.file + ':' + row.source.row)]), { numeric: [1] }) + '</details></section>' +
    (entry.exceedsLimit && team && nextOpen ? '<section class="card line" style="justify-content:space-between;flex-wrap:wrap"><span>이 달을 포함한 사례를 회계가 점검해요</span>' +
      '<a class="btn" href="/?' + escape(new URLSearchParams({ period: nextOpen, view: 'post-audit', audit: entry.group.groupId }).toString()) + '">지난 지급 점검 보기</a></section>' : '');
}

export function followupList(c, h) {
  const cases = c.list.filter(entry => onHold(c.stateFor(entry)));
  const stage = { draft: '요청서 작성', waiting: '거래처 답변 대기', received: '답변 검토 · 내 차례', verified: '다시 올리기 대기' };
  const counts = Object.fromEntries(Object.keys(stage).map(key => [key, cases.filter(entry => c.stateFor(entry) === key).length]));
  return '<div><h1>거래처 확인</h1><p class="muted" style="font-size:14px;margin-top:4px">임원이 거절하거나 추가 확인을 요청하면 여기에 자동으로 생겨요</p></div>' +
    '<div class="stats">' + Object.entries(stage).map(([key, label]) => '<div class="stat"><span>' + label + '</span><strong>' + counts[key] + '</strong></div>').join('') + '</div>' +
    '<section class="card">' + table(['요청', '물어본 항목', '단계', 'AI 판정', '기한'], cases.map(entry => {
      const events = c.eventsFor(entry.group.groupId);
      const asked = requestItems(events, entry.group.groupId);
      const check = c.latestReplyCheck(entry)?.result;
      const due = events.findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;
      const count = verdict => check?.items.filter(row => row.verdict === verdict).length ?? 0;
      return ['<a href="' + c.link({ view: 'followup', group: entry.group.groupId }) + '"><strong>' + escape(h.title(entry)) + '</strong></a><br><span class="muted">' + money(entry.totalKrw) + '</span>',
        events.some(event => event.action === 'send') ? asked.map(row => escape(row.label)).join('<br>') : '<span class="muted">아직 없음</span>',
        escape(stage[c.stateFor(entry)]), check ? '충족 ' + count('met') + ' · 부분 ' + count('partial') + ' · 부족 ' + count('missing') : '—', due ? escape(due) : '—'];
    }), { empty: '진행 중인 거래처 확인이 없어요' }) + '</section>';
}

export function composeRequest(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const basis = c.itemBasis(entry);
  const proposal = c.calls.filter(call => call.kind === 'items' && call.group_id === id).at(-1);
  const proposed = proposal?.result?.items ?? [];
  const proposedIds = proposed.map(row => row.id);
  const reason = c.decisionReason(entry);
  const reps = [...new Set(entry.group.links.filter(link => link.matchedFields.includes('representative_name')).flatMap(link => link.agencyIds))];
  const who = itemId => itemId === 'sameRep' && reps.length ? reps.map(h.name).join('·') : entry.group.members.length + '곳 모두';
  const checked = itemId => proposal?.result ? proposedIds.includes(itemId) : ['sharedAccount', 'payee', 'sameRep'].includes(itemId);

  const items = Object.entries(c.activeItems).filter(([itemId]) => basis[itemId]).sort(([a], [b]) =>
    (proposedIds.includes(a) ? proposedIds.indexOf(a) : 9) - (proposedIds.includes(b) ? proposedIds.indexOf(b) : 9));
  return '<div><p class="crumb"><a href="' + c.link({ view: 'followup' }) + '">거래처 확인</a> › ' + escape(h.title(entry)) + '</p><h1>거래처에 확인 요청하기</h1></div>' +
    (reason ? '<section class="card tight warn"><p class="muted" style="font-weight:600">임원 의견</p><p style="font-size:14px">' + escape(reason) + '</p></section>' : '') +
    (c.open && !proposal ? h.post({ view: 'followup', group: id }, '<button name="action" value="ai_items">AI 항목 제안</button>', ' hidden data-ai data-auto data-target="#items"') : '') +
    h.post({ view: 'followup', group: id }, h.revision(entry) +
      '<section class="card" id="items" style="padding-bottom:12px"><div class="line" style="justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h2>물어볼 항목</h2>' +
      '<span class="muted" data-ai-status>' + (proposal?.result ? 'AI가 임원 의견을 보고 골랐어요 · 바꿔도 돼요' : proposal?.finished_at ? 'AI 제안 없이 기본 항목을 골라 두었어요'
        : proposal ? 'AI가 고르는 중이에요' : '기본 항목을 골라 두었어요') + '</span></div>' +
      items.map(([itemId, row]) => {
        const quote = proposed.find(entry => entry.id === itemId)?.quote;
        return '<label class="check"><input type="checkbox" name="item" value="' + escape(itemId) + '"' + (checked(itemId) ? ' checked' : '') + '><span style="flex:1"><strong style="font-weight:600">' +
          escape(row.label) + '</strong>' + (proposedIds.includes(itemId) ? ' <span class="tag ai">AI 제안</span>' : '') + '<br><span class="muted">' + escape(who(itemId)) + ' · ' +
          escape(formatHints[row.format] ?? '글로 답변') + (row.attachment ? ' · ' + escape(row.attachment) + ' 필수' : '') + '</span>' +
          '<details><summary>왜 이 항목인가요?</summary><p class="muted" style="margin-top:4px">' + escape(basis[itemId]) + (quote ? ' · 임원 의견 "' + escape(quote) + '"' : '') + '</p></details></span></label>';
      }).join('') +
      (proposal?.result?.newItem ? '<p class="muted" style="margin-top:8px">AI가 목록에 없는 항목도 제안했어요: "' + escape(proposal.result.newItem) + '" · 관리자가 승인하면 목록에 생겨요</p>' : '') +
      '<label class="field" style="margin-top:12px">+ 직접 추가할 항목 (선택) <input name="customItem" maxlength="60" placeholder="예: 공동 납품 계약 여부"></label></section>' +
      '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><label class="field" style="flex:0 1 220px">답변 기한 <input type="date" name="dueDate" value="' +
      addBusinessDays(c.businessDate, 5) + '" required></label><p class="muted" style="flex:1 1 240px">거래처마다 자기 항목만 보여요. 다른 거래처 금액이나 임원 의견은 보이지 않아요.</p></div>' +
      '<label class="field" style="margin-top:12px">함께 보낼 말 (선택) <textarea name="reason" maxlength="600" placeholder="예: 지급 전에 확인이 필요합니다."></textarea></label>' +
      '<div style="margin-top:12px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:flex-end;margin-top:12px"><button class="primary" name="action" value="send">요청 보내기</button></div></section>');
}

export function replyReview(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const events = c.eventsFor(id);
  const state = c.stateFor(entry);
  const items = requestItems(events, id);
  const merged = mergedAnswers(events);
  const check = state === 'received' ? c.latestReplyCheck(entry) : null;
  const result = check?.result;
  const due = events.findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;
  const recipients = [...new Set(items.flatMap(row => row.recipients))];
  const answered = recipients.filter(agencyId => merged[agencyId]).length;
  const tones = { met: ['#e6f4ea', '#1e6b34'], partial: ['#fff1d6', '#7a3f00'], missing: ['#fde8e8', '#a12a2a'], none: ['#eef2f7', '#526074'] };
  const verdictTone = { met: 'green', partial: 'amber', missing: 'red' };
  const resendPreview = result ? resendItems(items, merged, result.items) : [];
  const rows = items.map(row => {
    const verdict = result?.items.find(entry => entry.id === row.id);
    const marks = itemMarks(row, merged, verdict?.verdict);
    return '<div class="row" style="align-items:flex-start;flex-wrap:wrap"><div style="flex:1 1 260px"><strong style="font-weight:600">' + escape(row.label) + '</strong>' +
      '<details><summary>답변 보기</summary><div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">' + marks.map(mark => '<p style="font-size:14px"><strong>' +
        escape(h.name(mark.agency)) + '</strong>' + (mark.answer ? src('reply') : '') + ' · ' + (mark.answer ? [mark.answer.yesno, mark.answer.text, mark.answer.account && '계좌 ' + mask(mark.answer.account) +
          (mark.answer.holder ? ' · 예금주 ' + mark.answer.holder : ''), mark.answer.attachment && '첨부 ' + mark.answer.attachment].filter(Boolean).map(escape).join(' · ')
          : '<span class="muted">' + (merged[mark.agency] ? '이 항목은 답하지 않았어요' : '아직 답변 없음') + '</span>') + '</p>').join('') +
        (verdict?.quote ? '<p class="muted">AI 근거 "' + escape(verdict.quote) + '"</p>' : '') + '</div></details>' +
      (verdict?.note ? '<p class="muted">' + icon('warn') + ' ' + escape(verdict.note) + '</p>' : '') + '</div>' +
      '<span class="dots">' + marks.map(mark => '<span class="dot" title="' + escape(h.name(mark.agency)) + '" style="background:' + tones[mark.status][0] + ';color:' + tones[mark.status][1] + '">' +
        escape(mark.agency.slice(-3)) + '</span>').join('') + '</span>' +
      (verdict ? pill(verdictTone[verdict.verdict], escape(verdictLabels[verdict.verdict]) + ' <small style="font-weight:500">AI</small>') : '<span class="muted">' + (state === 'waiting' ? '답변 대기' : '—') + '</span>') + '</div>';
  }).join('');
  const actions = !c.open || c.role !== '영업지원팀' ? '' : state === 'received' ? h.post({ view: 'followup', group: id }, h.revision(entry) +
    '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h2>다음 단계</h2>' +
    (result ? '<span class="muted">AI 의견: <strong>' + (result.recommendation === 'verify' ? '확인 완료' : '보완 요청') + '</strong> · 결정은 담당자</span>' : '') + '</div>' +
    (resendPreview.length ? '<details style="margin-top:8px"><summary>보완 요청으로 보낼 내용 보기</summary><ul style="margin:6px 0 0;padding-left:18px;font-size:14px">' +
      resendPreview.map(row => '<li>' + escape(row.label) + ' → ' + row.recipients.map(h.name).map(escape).join(', ') + '</li>').join('') + '</ul></details>' : '') +
    '<label class="field" style="margin-top:12px">메모 (선택) <textarea name="reason" maxlength="1000" placeholder="보완 요청에 함께 보낼 말이나, 확인 완료 근거"></textarea></label>' +
    '<div style="margin-top:12px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
    '<div class="line" style="justify-content:flex-end;flex-wrap:wrap;margin-top:12px"><button name="action" value="resend"' + (result && !resendPreview.length ? ' disabled' : '') + '>보완 요청 보내기</button>' +
    '<input type="hidden" name="resubmit" value="1"><button class="' + (result?.recommendation === 'verify' ? 'primary' : '') + '" name="action" value="verify">확인 완료 · 임원에게 다시 올리기</button></div></section>')
    : state === 'verified' ? h.post({ view: 'followup', group: id }, h.revision(entry) + recordFields(c.period, c.previousMetadata(entry), c.businessDate) +
      '<section class="card line" style="justify-content:space-between;margin-top:12px"><span>확인이 끝났어요</span><button class="primary" name="action" value="resubmit">임원에게 다시 올리기</button></section>') : '';
  return '<div><p class="crumb"><a href="' + c.link({ view: 'followup' }) + '">거래처 확인</a> › ' + escape(h.title(entry)) + '</p>' +
    '<div class="top" style="align-items:flex-end"><h1>' + (state === 'waiting' ? '거래처 답변 대기' : '거래처 답변 검토') + '</h1><span class="muted">' +
    (due ? '기한 ' + escape(due) + ' · ' : '') + '답변 ' + answered + '/' + recipients.length + '곳</span></div></div>' +
    (state === 'received' && c.open && !check ? h.post({ view: 'followup', group: id }, '<button name="action" value="ai_reply">AI 판정</button>', ' hidden data-ai data-auto data-target="#review"') : '') + '<div id="review" style="display:flex;flex-direction:column;gap:16px">' +
    '<section class="card" id="verdicts" style="padding-bottom:8px"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><h2>확인 항목</h2><span class="muted" data-ai-status>' +
    (result ? 'AI 판정 · 근거 문장은 답변 원문과 대조했어요' : check?.finished_at ? 'AI 판정을 못 했어요 · 직접 확인해 주세요' : check ? 'AI가 판정하는 중이에요' : state === 'waiting' ? '' : 'AI 판정 준비 중') + '</span></div>' +
    '<div class="rows">' + rows + '</div><p class="muted" style="padding:8px 0;font-size:12px">칸: 거래처별 · 초록 답함 · 빨강 이 항목만 답 없음 · 회색 아직 답변 없음 · 오른쪽은 AI 판정</p></section>' + actions + '</div>' + history(c, entry);
}

/* ---------- 서류·정보 변경 ---------- */

export function documentList(c, h) {
  const tab = ['todo', 'done', 'all'].includes(c.query.get('tab')) ? c.query.get('tab') : 'todo';
  const rows = c.documents.filter(row => tab === 'all' || (tab === 'todo' ? !row.applied : row.applied)).slice().reverse();
  return '<div><h1>서류 확인</h1><p class="muted" style="font-size:14px;margin-top:4px">거래처가 보낸 서류 · AI가 값을 읽고, 담당자가 확인해요</p></div>' +
    '<div class="tabs">' + [['todo', '확인 필요', c.documents.filter(row => !row.applied).length], ['done', '적용 완료', c.documents.filter(row => row.applied).length],
      ['all', '전체', c.documents.length]].map(([key, label, count]) => '<a class="btn tab" href="' + c.link({ view: 'documents', tab: key }) + '"' +
      (key === tab ? ' aria-current="page"' : '') + '>' + label + ' ' + count + '</a>').join('') + '</div>' +
    '<section class="card">' + table(['접수', '거래처', 'AI가 읽은 값', '상태'], rows.map(row => {
      const extract = c.calls.filter(call => call.document_id === row.id && call.kind === 'extract').at(-1)?.result;
      const account = extract?.bank_account_no?.candidates?.[0]?.value;
      return ['<a href="' + c.link({ view: 'documents', document: row.id }) + '"><strong>접수 ' + escape(row.id) + '</strong></a><br><span class="muted">' +
        (row.received_at ? time(row.received_at) : '') + '</span>', escape(h.name(row.agency_id)),
        account ? '계좌 ' + mask(account) : '<span class="muted">' + (extract ? '읽은 값 없음' : '아직 안 읽음') + '</span>',
        row.applied ? pill('green', '✓ 적용') : row.confirmed ? pill('blue', '확인 저장') : pill('amber', '! 확인 필요')];
    }), { empty: '확인할 서류가 없어요' }) + '</section>';
}

export function documentDetail(c, h) {
  const doc = c.document;
  const extract = c.calls.filter(call => call.document_id === doc.id && call.kind === 'extract').at(-1);
  const registered = c.currentAgency(doc.agency_id);
  const canEdit = c.open && c.role === '영업지원팀' && !doc.applied;
  const post = extras => c.link({ view: 'documents', document: doc.id, ...extras });
  const cell = key => {
    const confirmed = doc.confirmed?.[key];
    const candidate = extract?.result?.[key]?.candidates?.[0]?.value;
    return confirmed ? confirmed.value ?? '' : candidate ?? '';
  };
  const decision = key => {
    const confirmed = doc.confirmed?.[key];
    if (confirmed) return confirmed.decision;
    const candidates = extract?.result?.[key]?.candidates ?? [];
    return candidates.length ? 'accept' : 'reject';
  };
  const changedAccount = cell('bank_account_no') && registered && cell('bank_account_no') !== registered.bank_account_no;
  return '<div><p class="crumb"><a href="' + c.link({ view: 'documents' }) + '">서류 확인</a> › ' + escape(h.name(doc.agency_id)) + ' · 접수 ' + escape(doc.id) + '</p>' +
    '<div class="top" style="align-items:flex-end"><h1>' + (changedAccount ? '계좌 변경 신청' : '거래처 서류') + '</h1>' +
    (doc.applied ? pill('green', '✓ 적용 완료') : doc.confirmed ? pill('blue', '확인 저장') : pill('amber', '! 확인 필요')) + '</div></div>' +
    (canEdit && !extract ? '<form method="post" action="' + post({}) + '" hidden data-ai data-auto data-target="#compare"><button name="action" value="document_extract">AI 읽기</button></form>' : '') +
    '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start"><section class="card" style="flex:1 1 280px;background:#fbfbfc;padding:16px" aria-label="서류 원문">' +
    '<p class="muted" style="margin-bottom:6px">거래처가 보낸 서류' + src('reply', doc.metadata?.source === 'scenario' ? '추가 시나리오' : '가상 회신') + '</p><pre class="doc">' + escape(doc.original) + '</pre><p class="muted" style="margin-top:8px;font-size:12px">' + metadataView(doc.metadata, escape) + '</p></section>' +
    '<form method="post" action="' + post({}) + '" class="card" id="compare" style="flex:1.3 1 340px"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><h2>등록 정보' + src('raw') + '와 비교</h2><span class="muted" data-ai-status>' +
    (extract?.result ? 'AI가 읽은 값 · 고쳐도 돼요' : extract?.finished_at ? 'AI가 못 읽었어요 · 직접 입력' : extract ? 'AI가 읽는 중' : '') + '</span></div><div class="rows">' +
    Object.entries(extractFields).map(([key, label]) => {
      const value = cell(key);
      const same = registered && value && value === registered[key];
      return '<div class="row" style="flex-wrap:wrap"><span style="flex:0 0 70px;font-weight:600">' + escape(label) + '</span><span class="muted" style="flex:1 1 120px">' +
        escape(key === 'bank_account_no' ? mask(registered?.[key]) : registered?.[key] ?? '') + '</span>' +
        '<input name="' + key + '" value="' + escape(value) + '" maxlength="200" aria-label="' + escape(label) + ' 서류 값" style="flex:1 1 180px"' + (canEdit ? '' : ' disabled') + '>' +
        '<input type="hidden" name="' + key + '_decision" value="' + (value ? (extract?.result?.[key]?.candidates?.some(candidate => candidate.value === value) ? 'accept' : 'edit') : 'reject') + '" data-decision="' + decision(key) + '">' +
        (value ? (same ? icon('ok') : '<span class="tag" style="background:#fff1d6;color:#7a3f00">변경</span>') : '<span class="muted">없음</span>') + '</div>';
    }).join('') + '</div>' +
    (changedAccount ? '<div class="note"><strong>적용하면</strong> · 진행 중인 달은 지금 판단을 유지하고, 다음 달부터 새 계좌로 판단해요.' +
      '<details style="margin-top:6px"><summary>왜 이번 달은 그대로인가요?</summary><p class="muted" style="margin-top:4px">확인 요청 중에 계좌만 바꿔 한도를 피하지 못하게 해요. 같은 계좌로 들어온 입금 기록이 있으면 임원 승인 경로를 유지하고, 임원이 다시 결정해요.</p></details></div>' : '') +
    (canEdit ? '<label class="field" style="margin-top:12px">확인 메모 <input name="reason" value="' + escape(doc.confirmed?.reason ?? '') + '" maxlength="1000" required placeholder="예: 대표자 서명 확인"></label>' +
      '<div style="margin-top:12px">' + recordFields(c.period, doc.metadata, c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:flex-end;flex-wrap:wrap;margin-top:12px"><button name="action" value="document_confirm">' + (doc.confirmed ? '다시 저장' : '확인 저장') + '</button>' +
      (doc.confirmed && changedAccount ? '<button class="primary" name="action" value="account_apply">변경 적용</button>' : '') +
      (doc.confirmed && !changedAccount ? '<button name="action" value="group_confirm">관련자 묶음 다시 확인</button>' : '') + '</div>' : '') +
    '</form></div>';
}

export function reviewList(c, h) {
  return '<div><h1>정보 변경</h1><p class="muted" style="font-size:14px;margin-top:4px">거래처 정보가 바뀌어 다시 판단해야 하는 요청</p></div>' +
    (c.reviews.length ? c.reviews.slice().reverse().map(review => {
      const scope = review.details.scope;
      const resolved = c.events.some(event => event.review_id === review.id && event.action === 'review_approve');
      const before = scope.before.map(row => row.members.map(h.name).join('·') + ' ' + money(row.amount) + ' (' + (row.approver === '영업임원' ? '임원' : '팀 승인') + ')').join(' / ');
      const after = scope.after.map(row => row.members.map(h.name).join('·') + ' ' + money(row.amount) + ' (' + (row.approver === '영업임원' ? '임원' : '팀 승인') + ')').join(' / ');
      const target = c.list.find(entry => entry.group.members.some(member => scope.agencies.includes(member.agencyId)));
      return '<section class="card" id="review-' + escape(review.id) + '"><div class="top"><div><h2>' + escape(h.name(review.agency_id)) + ' ' +
        (review.kind === 'change' ? '정산계좌 변경' : '관련자 묶음 확인') + '</h2><p class="muted">' + (review.kind === 'change' ? mask(review.details.beforeAccount) + ' → ' + mask(review.details.afterAccount) + ' · ' : '') +
        time(review.created_at) + ' 적용</p></div>' + (resolved ? pill('green', '✓ 재검토 승인') : pill('blue', '◷ 재검토 중')) + '</div>' +
        '<div class="agencies" style="margin-top:14px"><div class="agency"><p class="muted">이번 달</p><strong style="font-size:15px">' +
        (scope.retained.length ? '지금 묶음 그대로 · 임원 승인' : '새 정보로 다시 판단') + '</strong></div><div class="agency"><p class="muted">새 정보 기준</p><strong style="font-size:15px">' + escape(after) + '</strong></div></div>' +
        '<details style="margin-top:12px"><summary>자세히</summary><p class="muted" style="margin-top:6px">변경 전: ' + escape(before) + '</p>' +
        (scope.retained.length ? '<p class="muted">같은 계좌 입금 기록: ' + scope.retained.map(row => escape(row.agencyId + ' ' + (row.depositId ?? ''))).join(', ') + '</p>' : '') +
        '<p class="muted">올해 이미 지급된 관련 건 ' + scope.history.filter(row => row.paid).length + '건은 되돌리지 않고 지난 지급 점검에서 다뤄요.</p></details>' +
        (target ? '<div class="rows" style="margin-top:12px"><div class="row"><span class="line">' + (onHold(c.stateFor(target)) ? icon('wait') : icon('ok')) + '진행 중인 거래처 확인은 그대로 이어가요</span>' +
          '<a href="' + c.link({ view: 'followup', group: target.group.groupId }) + '">보기</a></div><div class="row"><span class="line">' + (resolved ? icon('ok') : icon('wait')) + '임원이 다시 결정해요</span><span class="muted">' +
          (resolved ? '완료' : '대기') + '</span></div><div class="row"><span class="line">' + (['paymentReady', 'reconciled'].includes(c.stateFor(target)) ? icon('ok') : icon('wait')) + '회계가 다시 확인해요</span>' +
          '<a href="' + c.link({ view: 'requests', group: target.group.groupId }) + '">요청 보기</a></div></div>' : '') + '</section>';
    }).join('') : '<section class="card"><p class="empty">다시 판단할 요청이 없어요</p></section>');
}

/* ---------- 영업임원 ---------- */

export function execList(c, h) {
  const all = c.query.get('all') === '1';
  const due = c.list.filter(entry => c.execDue(entry));
  const rows = all ? c.list.filter(entry => entry.exceedsLimit || c.isAffected(entry)) : due;
  return '<div><p class="muted">' + Number(c.period.slice(5)) + '월분</p><h1>' + (all ? '임원 승인 대상 전체' : '결정할 요청 ' + due.length) + '</h1></div>' +
    '<div class="tabs"><a class="btn tab" href="' + c.link({ view: 'requests' }) + '"' + (all ? '' : ' aria-current="page"') + '>결정할 요청 ' + due.length + '</a>' +
    '<a class="btn tab" href="' + c.link({ view: 'requests', all: '1' }) + '"' + (all ? ' aria-current="page"' : '') + '>전체</a></div>' +
    (rows.length ? rows.map(entry => {
      const check = c.latestReplyCheck(entry)?.result;
      const deposits = h.outsideDeposits(entry);
      const record = h.record(entry);
      const tags = [entry.group.members.length > 1 ? '관련자 ' + entry.group.members.length + '곳' : null, deposits.length ? '다른 계좌 입금 ' + deposits.length + '건' : null,
        h.pastFor(entry) ? '과거 한도 초과' : null, c.precheck.has(entry.group.groupId) ? '3개월 사전 확인 대상' : null, check ? '확인 ' + check.items.filter(row => row.verdict === 'met').length + '/' + check.items.length + ' 충족' : null].filter(Boolean);
      return '<a class="card" style="display:block;color:inherit" href="' + c.link({ view: 'requests', group: entry.group.groupId }) + '">' +
        '<div class="top"><div><h2>' + escape(h.title(entry)) + '</h2><p class="muted">' + entry.group.members.map(member => escape(h.name(member.agencyId))).join(' · ') + '</p></div>' + h.statusPill(entry) + '</div>' +
        '<div class="line" style="justify-content:space-between;align-items:baseline;margin-top:12px"><strong style="font-size:20px">' + money(entry.totalKrw) + '</strong>' +
        (entry.exceedsLimit ? '<span style="color:#a12a2a;font-weight:700;font-size:13px">▲ 한도 ' + manwon(entry.totalKrw - LIMIT) + ' 초과</span>' : '') + '</div>' +
        '<div class="line" style="gap:6px;flex-wrap:wrap;margin-top:10px">' + tags.map(tag => '<span class="tag">' + escape(tag) + '</span>').join('') + '</div>' +
        (record?.action && !all ? '' : '') + '</a>';
    }).join('') : '<section class="card"><p class="empty">' + (all ? '임원 승인 대상이 없어요' : '지금 결정할 요청이 없어요') + '</p></section>');
}

export function execDecision(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const events = c.eventsFor(id);
  const enabled = c.execDue(entry) && c.open;
  const basis = c.basisFor(entry);
  const call = c.conditionCall(entry);
  const suggested = call?.result?.conditions ?? [];
  const reject = c.decisionReason(entry);
  const merged = mergedAnswers(events);
  const asked = allRequestedItems(events, id);
  const check = c.latestReplyCheck(entry)?.result;
  const deposits = h.outsideDeposits(entry);
  const reviewsFor = c.reviews.filter(review => review.details.scope.agencies.some(agencyId => entry.group.members.some(member => member.agencyId === agencyId)));
  const changes = [
    ...(Object.keys(merged).length ? asked.map(row => {
      const verdict = check?.items.find(item => item.id === row.id)?.verdict;
      return [verdict === 'met' ? 'ok' : 'warn', escape(row.label) + (verdict ? ' · ' + verdictLabels[verdict] : ' · 답변 받음'), c.link({ view: 'requests', group: id }) + '#answers'];
    }) : []),
    ...reviewsFor.map(review => ['warn', escape(h.name(review.agency_id)) + (review.kind === 'change' ? '이 계좌를 바꿨어요' : ' 묶음 확인') +
      (review.details.scope.retained.length ? ' · 이번 달은 묶음 그대로' : ''), '']),
    ...(deposits.length ? [['warn', escape(h.name(deposits[0].agencyId)) + '가 다른 곳 계좌로 ' + deposits.length + '번 입금', '']] : []),
    ...(h.pastFor(entry) ? [['warn', '1~5월 한도 초과가 팀 승인으로 지급됨' + (c.pastConclusion(id) ? ' · 결론 ' + postAuditConclusions[c.pastConclusion(id)] : ''),
      c.link({ view: 'post-audit', audit: id })]] : []),
  ];
  return '<div><p class="crumb"><a href="' + c.link({ view: 'requests' }) + '">결정할 요청</a> › ' + Number(c.period.slice(5)) + '월</p>' +
    '<div class="top" style="align-items:flex-end"><h1>' + escape(h.title(entry)) + '</h1>' + h.statusPill(entry) + '</div></div>' +
    '<section class="card tight"><div class="line" style="justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h2>' +
    (entry.group.members.length > 1 ? entry.group.members.length + '곳 합계 ' : '합계 ') + money(entry.totalKrw) + src('calc') + '</h2>' +
    (entry.exceedsLimit ? '<span style="color:#a12a2a;font-weight:700;font-size:14px">▲ 팀 승인 한도 200만원 초과</span>' : '') + '</div>' +
    '<p class="muted" style="font-size:14px;margin-top:4px">' + (entry.group.members.length > 1 ? '대표자·주소·계좌가 겹쳐 합쳐서 봐요. ' : '') +
    '<a href="#basis">묶은 근거</a></p></section>' +
    (reject ? '<section class="card tight warn"><p class="muted" style="font-weight:600">지난 결정 의견</p><p style="font-size:14px">' + escape(reject) + '</p></section>' : '') +
    (changes.length ? '<section class="card" style="padding-bottom:8px" id="answers"><h2>' + (reject ? '지난 결정 이후 확인된 점' : '확인할 점') + '</h2><div class="rows">' +
      changes.map(([tone, text, href]) => '<div class="row"><span class="line">' + icon(tone) + '<span>' + text + '</span></span>' +
        (href ? '<a href="' + href + '">보기</a>' : '') + '</div>').join('') + '</div>' +
      (Object.keys(merged).length ? '<details style="margin:4px 0 10px"><summary>거래처 답변 원문' + src('reply') + '</summary>' + Object.entries(merged).map(([agencyId, answer]) =>
        '<p style="font-size:14px;margin-top:6px"><strong>' + escape(h.name(agencyId)) + '</strong> · ' + Object.entries(answer.items).map(([itemId, value]) =>
          escape(asked.find(row => row.id === itemId)?.label ?? '답변') + ': ' + [value.yesno, value.text, value.account && '계좌 ' + mask(value.account), value.holder && '예금주 ' + value.holder,
            value.attachment && '첨부 ' + value.attachment].filter(Boolean).map(escape).join(' · ')).join(' / ') + '</p>').join('') + '</details>' : '') + '</section>' : '') +
    (enabled ? (Object.keys(basis).length && !call ? h.post({ view: 'requests', group: id }, '<button name="action" value="ai_conditions">AI 조건 제안</button>', ' hidden data-ai data-auto data-target="#decision"') : '') +
      h.post({ view: 'requests', group: id }, h.revision(entry) + '<section class="card" id="decision" style="border-color:#c9dcf7"><h2 style="margin-bottom:12px">결정</h2>' +
        '<div class="seg" role="radiogroup" aria-label="결정">' + [['approve', '승인'], ['clarify', '추가 확인 요청'], ['reject', '거절']].map(([value, label], index) =>
          '<label><input type="radio" name="decision" value="' + value + '"' + (index ? '' : ' checked') + '><span>' + label + '</span></label>').join('') + '</div>' +
        (Object.keys(basis).length ? '<div data-when="approve" style="margin-top:16px"><p style="font-weight:600">지급 전에 회계가 확인할 조건 <span class="muted" style="font-weight:400" data-ai-status>' +
          (call?.result ? '· AI 제안, 고르지 않아도 돼요' : call?.finished_at ? '· AI 제안 없이 직접 골라 주세요' : '· AI가 고르는 중') + '</span></p>' +
          Object.entries(basis).map(([conditionId, why]) => '<label class="check"><input type="checkbox" name="condition" value="' + escape(conditionId) + '"' +
            (suggested.includes(conditionId) ? ' checked' : '') + '><span style="flex:1"><strong style="font-weight:600">' + escape(conditionCatalog[conditionId]) + '</strong>' +
            (suggested.includes(conditionId) ? ' <span class="tag ai">AI 제안</span>' : '') + '<details><summary>이유</summary><p class="muted" style="margin-top:4px">' + escape(why) + '</p></details></span></label>').join('') +
          '<p class="muted" style="margin-top:6px">고른 조건이 모두 확인되어야 지급돼요.</p></div>' : '') +
        '<label class="field" style="margin-top:14px">의견 <span class="muted" style="font-weight:400">추가 확인·거절이면 필수 · 영업지원팀에 전달돼요</span><textarea name="reason" maxlength="1000"></textarea></label>' +
        '<div class="line" style="margin-top:14px"><button class="primary" name="action" value="decide">결정 저장</button><span class="muted">승인하면 회계로 넘어가요</span></div></section>')
      : '<section class="card tight"><p class="muted">' + (c.saved.get(id) ? '이미 결정했어요 · 지금 상태: ' + h.status(entry)[1] : '지금은 결정할 차례가 아니에요 · ' + h.status(entry)[1]) + '</p></section>') +
    '<div id="basis">' + summaryCard(c, h, entry) + '</div>' + history(c, entry);
}

/* ---------- 회계 ---------- */

export function accountingList(c, h) {
  const tasks = c.list.filter(entry => c.saved.get(entry.group.groupId)?.created_at);
  const stateIs = (...states) => entry => states.includes(c.stateFor(entry));
  const conditions = entry => c.saved.get(entry.group.groupId).conditions ?? [];
  const conditionTasks = tasks.filter(entry => conditions(entry).length && c.stateFor(entry) === 'paymentPending');
  const team = tasks.filter(entry => !entry.exceedsLimit && !c.isAffected(entry) && !conditions(entry).length && c.stateFor(entry) === 'paymentPending');
  const other = tasks.filter(entry => !conditionTasks.includes(entry) && !team.includes(entry) && stateIs('paymentPending', 'repayReady')(entry));
  const batched = entry => c.eventsFor(entry.group.groupId).findLast(event => event.action === 'payment')?.metadata?.batch;
  const waiting = tasks.filter(stateIs('paymentReady'));
  const waitingBatch = waiting.filter(entry => batched(entry) && !entry.exceedsLimit);
  const waitingSingle = waiting.filter(entry => !waitingBatch.includes(entry));
  const returned = tasks.filter(stateIs('paymentReturned'));
  const done = tasks.filter(stateIs('reconciled'));
  const pending = c.past.filter(row => !row.conclusion);
  const target = entry => '<a href="' + c.link({ view: 'accounting', group: entry.group.groupId }) + '"><strong>' + escape(h.title(entry)) + '</strong></a><br><span class="muted">' + money(entry.totalKrw) + '</span>';
  return '<div><p class="muted">' + Number(c.period.slice(5)) + '월분</p><h1>지급 검토</h1></div>' +
    '<div class="stats"><div class="stat"><span>승인 조건 확인</span><strong>' + conditionTasks.length + '건</strong></div>' +
    '<div class="stat"><span>지급 반영 대기</span><strong>' + (team.length + other.length) + '건</strong><span>' + money([...team, ...other].reduce((sum, entry) => sum + entry.totalKrw, 0)) + '</span></div>' +
    '<div class="stat"><span>은행 회신 대기 · 반려</span><strong>' + waiting.length + ' · ' + returned.length + '건</strong><span>모의 회신</span></div>' +
    '<div class="stat"><span>대사 완료</span><strong>' + done.length + '건</strong></div>' +
    '<a class="stat" href="' + c.link({ view: 'post-audit' }) + '"><span>지난 지급 점검</span><strong>' + pending.length + '건</strong><span>' + (pending.length ? '결론 대기' : '모두 결론') + '</span></a></div>' +
    '<section class="card"><h2 style="margin-bottom:8px">내 할 일</h2>' + table(['작업', '대상', '진행'], [
      ...conditionTasks.map(entry => ['승인 조건 확인', target(entry), confirmedConditions(c.saved.get(entry.group.groupId), c.eventsFor(entry.group.groupId)).size + '/' + conditions(entry).length + ' 확인']),
      ...other.map(entry => [c.stateFor(entry) === 'repayReady' ? '반려분 재지급' : '지급 반영', target(entry), '반영 가능']),
      ...(team.length ? [['지급 반영 · 일괄', '팀 승인 ' + team.length + '건<br><span class="muted">' + money(team.reduce((sum, entry) => sum + entry.totalKrw, 0)) + '</span>',
        c.open ? h.post({ view: 'accounting' }, '<button class="primary small" name="action" value="batch_pay">지급 시스템에 반영</button>') + src('mock') : '']] : []),
      ...waitingSingle.map(entry => ['은행 회신 입력', target(entry), '회신 대기' + src('mock')]),
      ...(waitingBatch.length ? [['은행 회신 · 일괄', '배치 ' + escape(batched(waitingBatch[0])) + ' · ' + waitingBatch.length + '건',
        c.open ? h.post({ view: 'accounting' }, '<button class="small" name="action" value="batch_result_ok">전부 지급됨으로 반영</button>') + src('mock') +
          '<br><span class="muted" style="font-size:12px">반려가 있으면 해당 건을 열어 따로 입력</span>' : '']] : []),
    ], { empty: '지금 할 일이 없어요' }) + '</section>' +
    (returned.length ? '<section class="card tight">' + returned.map(entry => '<p>' + icon('no') + ' ' + escape(h.title(entry)) + ' · 지급 반려 · 영업지원팀 계좌 재확인 중</p>').join('') + '</section>' : '') +
    (done.length ? '<details class="card tight"><summary>대사 완료 ' + done.length + '건</summary>' + table(['대상', '합계', '배치'], done.map(entry => [escape(h.title(entry)), money(entry.totalKrw),
      escape(batched(entry) ?? '개별')]), { numeric: [1] }) + '</details>' : '');
}

export function accountingDetail(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const record = c.saved.get(id);
  const events = c.eventsFor(id);
  const state = c.stateFor(entry);
  const ids = record.conditions ?? [];
  const confirmed = confirmedConditions(record, events);
  const left = ids.filter(conditionId => !confirmed.has(conditionId));
  const paid = ['paymentReady', 'reconciled', 'paymentReturned'].includes(state);
  const canPay = c.open && ['paymentPending', 'repayReady'].includes(state);
  const payees = c.payees(entry);
  const mismatch = payees.filter(row => row.status === 'mismatch');
  const paidPayees = events.findLast(event => event.action === 'payment')?.metadata?.payees;
  const payeeTable = '<details' + (mismatch.length ? ' open' : '') + ' style="margin-top:10px"><summary>받는 계좌 ' + (mismatch.length ? '· ' + mismatch.length + '곳 확인 필요' : '· 모두 등록 정산계좌') + '</summary>' +
    table(['거래처', '지급할 계좌' + src('raw', '등록 정산계좌'), '거래처가 답한 계좌' + src('reply'), ''], (paidPayees ?? payees).map(row => [escape(h.name(row.agencyId)), mask(row.account),
      row.claimed ? mask(row.claimed) + (row.holder ? ' · ' + escape(row.holder) : '') : '<span class="muted">답변 없음</span>',
      row.status === 'mismatch' ? icon('warn') + ' 다름' : icon('ok')])) +
    '<p class="muted" style="font-size:12px">지급은 등록 정산계좌로만 해요. 입금·회수 계좌나 답변 계좌를 지급 계좌로 단정하지 않아요.</p></details>';
  const methods = ['원본 우편 수령', '방문 확인', '국세청 사업자 상태 조회', '은행 예금주 조회', '서류 사본 대조'];
  return '<div><p class="crumb"><a href="' + c.link({ view: 'accounting' }) + '">지급 검토</a> › ' + Number(c.period.slice(5)) + '월</p>' +
    '<div class="top" style="align-items:flex-end"><h1>' + escape(h.title(entry)) + ' · ' + money(entry.totalKrw) + '</h1>' +
    (state !== 'paymentPending' ? h.statusPill(entry) : left.length ? pill('amber', '! 조건 ' + (ids.length - left.length) + '/' + ids.length + ' · 지급 보류') : pill('blue', ids.length ? '조건 ' + ids.length + '/' + ids.length + ' · 지급 가능' : '지급 가능')) + '</div></div>' +
    (ids.length ? '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap;align-items:baseline"><h2>지급 전 확인할 조건</h2><span class="muted">' +
      escape(record.role) + '이 ' + time(record.acted_at) + ' 승인하며 붙임</span></div>' +
      '<div class="bar ok" style="height:6px;margin:12px 0 4px" aria-hidden="true"><i style="width:' + Math.round((ids.length - left.length) / ids.length * 100) + '%;background:#1e8e3e"></i></div><div class="rows">' +
      ids.map(conditionId => {
        const done = confirmed.get(conditionId);
        return '<div class="row" style="flex-direction:column;align-items:stretch"><span class="line">' + (done ? icon('ok') : icon('wait')) + '<span><strong style="font-weight:600">' + escape(conditionCatalog[conditionId] ?? conditionId) +
          '</strong><br><span class="muted">' + (done ? escape(done.metadata?.evidence?.reference ?? '') + ' · ' + escape(done.reason) + ' · ' + time(done.acted_at) + src('reply', '가상 확인') : '아직 확인 전이에요') + '</span></span></span>' +
          (!done && c.open && state === 'paymentPending' ? h.post({ view: 'accounting', group: id }, h.revision(entry) + '<input type="hidden" name="condition" value="' + escape(conditionId) + '">' +
            '<div class="line" style="flex-wrap:wrap;padding-left:30px;margin-top:8px"><select name="evidenceReference" aria-label="확인 방법" style="flex:1 1 170px;width:auto">' +
            methods.map(method => '<option>' + method + '</option>').join('') + '</select><input name="evidenceFinding" maxlength="1000" required placeholder="확인 결과 · 예: 원본과 사본 일치" aria-label="확인 결과" style="flex:2 1 220px;width:auto">' +
            '<button class="primary" name="action" value="condition_check">확인함</button></div><div style="padding-left:30px;margin-top:6px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>') : '') + '</div>';
      }).join('') + '</div></section>' : '') +
    '<section class="card line" style="justify-content:space-between;flex-wrap:wrap' + (!left.length && !paid ? ';border-color:#c9dcf7' : '') + '"><div><h2>지급 시스템 반영' + src('mock') + '</h2><p class="muted" style="font-size:14px">' +
    (paid ? escape(events.findLast(event => event.action === 'payment')?.metadata?.evidence?.reference ?? '') + ' · 지급 전에 계좌가 바뀌면 자동으로 보류돼요.'
      : left.length ? '조건을 모두 확인하면 반영할 수 있어요.' : mismatch.length ? '받을 계좌가 등록 정산계좌와 다른 거래처가 있어요. 정산계좌 변경을 먼저 확인해야 해요.' : '반영하면 지급 목록에 올라가요 (모의 처리).') + '</p>' + payeeTable + '</div>' +
    (canPay ? h.post({ view: 'accounting', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<button class="' + (left.length || mismatch.length ? '' : 'primary') + '" name="action" value="payment"' + (left.length || mismatch.length ? ' disabled' : '') + '>' + (state === 'repayReady' ? '반려분 다시 지급' : '지급 시스템에 반영') + '</button>') : '') + '</section>' +
    bankSection(c, h, entry, state, events) +
    (record.snapshot ? '<details class="card tight"><summary>승인 당시 기록 · 합계 ' + money(record.snapshot.totalKrw) + src('calc') + '</summary>' +
      table(['거래처', '장려금', '자료 위치'], record.snapshot.members.map(row => [escape(h.name(row.agencyId)), money(row.amountKrw), escape(row.source)]), { numeric: [1] }) +
      '<p class="muted" style="font-size:12px">' + escape(record.role) + ' 승인 시점에 저장한 묶음 구성과 합산액이에요. 나중에 등록 정보가 바뀌어도 이 기록은 그대로예요.</p></details>' : '') +
    history(c, entry);
}

function bankSection(c, h, entry, state, events) {
  const id = entry.group.groupId;
  const results = ['payment_ok', 'payment_returned'].map(action => events.filter(event => event.action === action)).flat()
    .sort((a, b) => new Date(a.acted_at) - new Date(b.acted_at));
  const log = results.length ? table(['회신', '거래처별 결과'], results.map(event => [escape(event.metadata?.occurredOn ?? time(event.acted_at)),
    Object.entries(event.metadata?.results ?? {}).map(([agencyId, row]) => escape(h.name(agencyId)) + ' ' + (row.result === 'success' ? icon('ok') + ' 지급' : icon('no') + ' 반려 · ' + escape(row.reason) +
      (row.note ? ' (' + escape(row.note) + ')' : ''))).join('<br>')])) : '';
  const recheck = events.findLast(event => event.action === 'payee_recheck');
  if (state === 'paymentReady' && c.open) {
    const repay = events.findLast(event => event.action === 'payment')?.metadata?.repay;
    const targets = entry.group.members.map(member => member.agencyId).filter(agencyId => !repay || repay.includes(agencyId));
    return h.post({ view: 'accounting', group: id }, h.revision(entry) + '<section class="card" style="border-color:#c9dcf7"><h2>은행 회신 입력' + src('mock') + '</h2>' +
      '<p class="muted" style="margin:4px 0 8px">실제 은행과 연결돼 있지 않아 회신을 직접 입력해요. 반려가 있으면 영업지원팀에 계좌 재확인 일이 생겨요.</p><div class="rows">' +
      entry.group.members.map(({ agencyId }) => targets.includes(agencyId)
        ? '<div class="row" style="flex-wrap:wrap"><strong style="flex:0 0 120px;font-weight:600">' + escape(h.name(agencyId)) + '</strong>' +
          '<select name="result_' + escape(agencyId) + '" aria-label="' + escape(h.name(agencyId)) + ' 결과" style="width:auto"><option value="success">지급됨</option><option value="rejected">반려</option></select>' +
          '<select name="why_' + escape(agencyId) + '" aria-label="반려 사유" style="width:auto"><option value="">반려 사유</option><option value="holder">예금주 불일치</option><option value="closed">계좌 해지·없음</option><option value="other">기타</option></select>' +
          '<input name="note_' + escape(agencyId) + '" maxlength="200" placeholder="메모 (선택)" aria-label="메모" style="flex:1 1 140px;width:auto"></div>'
        : '<input type="hidden" name="result_' + escape(agencyId) + '" value="success">').join('') + '</div>' +
      '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:flex-end;margin-top:10px"><button class="primary" name="action" value="payment_result">회신 반영</button></div>' + log + '</section>');
  }
  if (!results.length && !recheck) return '';
  return '<section class="card"><h2>은행 회신' + src('mock') + '</h2>' + log +
    (recheck ? '<p class="note">' + icon('ok') + ' 영업지원팀 재확인: ' + escape(recheck.reason) + '</p>' : '') +
    (state === 'paymentReturned' ? '<p class="note warn">' + icon('wait') + ' 영업지원팀이 받는 계좌를 다시 확인하고 있어요.</p>' : '') + '</section>';
}

/* ---------- 지난 지급 점검 ---------- */

export function postAudit(c, h) {
  if (!c.past.length) return '<div><h1>지난 지급 점검</h1></div><section class="card"><p class="empty">점검할 지난 지급이 없어요</p></section>';
  const selected = c.past.find(row => row.groupId === c.query.get('audit')) ?? (c.past.length === 1 ? c.past[0] : null);
  if (!selected) return '<div><h1>지난 지급 점검</h1></div><section class="card">' + table(['대상', '기간', '금액', '상태'], c.past.map(row => [
    '<a href="' + c.link({ view: 'post-audit', audit: row.groupId }) + '"><strong>' + escape(h.name(row.groupId)) + ' 외 ' + (row.members.length - 1) + '곳</strong></a>',
    row.months.map(month => Number(month.period.slice(5)) + '월').join('·'), money(row.totalKrw),
    row.conclusion ? pill(conclusionTone[row.conclusion], postAuditConclusions[row.conclusion]) : pill('amber', '! 결론 대기')]), { numeric: [2] }) + '</section>';
  const cause = postAuditCause(selected, c.data, selected.masterCheck);
  const canDecide = c.role === '회계' && c.open && !selected.conclusion;
  const first = Number(selected.months[0].period.slice(5));
  const last = Number(selected.months.at(-1).period.slice(5));
  return '<div><p class="crumb"><a href="' + c.link({ view: 'post-audit', audit: '' }) + '">지난 지급 점검</a></p><div class="top" style="align-items:flex-end"><h1>' +
    escape(h.name(selected.groupId)) + ' 외 ' + (selected.members.length - 1) + '곳 · ' + first + '~' + last + '월</h1>' +
    (selected.conclusion ? pill(conclusionTone[selected.conclusion], '✓ 결론: ' + postAuditConclusions[selected.conclusion]) : pill('amber', '! 결론 대기')) + '</div></div>' +
    '<section class="card"><h2 style="font-size:18px">임원 승인이 필요했는데 팀 승인으로 지급됐어요</h2>' +
    '<p class="muted" style="font-size:14px;margin-top:4px">' + selected.months.length + '개월 동안 ' + selected.rowCount + '건, ' + money(selected.totalKrw) + src('raw', '원본 지급') + src('calc', '묶음 계산') + ' · 이미 지급된 돈이라 되돌리지 않고 기록을 남겨요.</p>' +
    '<p class="note' + (cause.confirmed ? '' : ' warn') + '">' + (cause.confirmed ? icon('ok') : icon('warn')) + ' ' + escape(cause.text) +
      (cause.confirmed ? src('reply', '회계 확인') : src('est')) + ' <span class="muted">(' + (cause.confirmed ? '회계 확인: ' + escape(selected.masterCheckNote) : '현재 등록일·지급일로 계산한 추정') + ')</span></p>' +
    (!selected.masterCheck && canDecide ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
      '<details style="margin-top:10px" open><summary>승인 당시 등록 정보 확인 (결론 전 권장)</summary><div class="line" style="flex-wrap:wrap;margin-top:8px">' +
      '<select name="masterCheck" aria-label="확인 결과" style="flex:1 1 200px;width:auto">' + Object.entries(masterCheckResults).map(([value, label]) =>
        '<option value="' + value + '">' + label + '</option>').join('') + '</select>' +
      '<input name="reason" maxlength="1000" required placeholder="확인 근거 · 예: 2026-02 지급 품의서의 등록 정보" aria-label="확인 근거" style="flex:2 1 240px;width:auto">' +
      '<button class="small" name="action" value="audit_master_check">확인 저장</button></div></details>') : '') +
    '<details style="margin-top:12px"><summary>월별 지급 내역 · 원본</summary>' + table(['정산월', '묶음 합계', '지급일', '자료 위치'], selected.months.map(month => [
      escape(month.period), money(month.paidKrw), escape(month.paymentDates.join(', ')), month.sources.map(src => escape(src.file + ':' + src.row)).join('<br>')]), { numeric: [1] }) +
    '<p class="muted" style="font-size:12px">매달 영업지원팀 승인으로 지급</p></details></section>' +
    (selected.conclusion ? '<section class="card"><h2>결론</h2><p style="margin-top:6px">' + escape(postAuditConclusions[selected.conclusion]) + ' · <span class="muted">' + time(selected.doneAt) + '</span></p>' +
      '<p class="muted" style="margin-top:4px">' + escape(selected.opinion) + '</p>' +
      (selected.concludedUnverified ? '<p class="note warn">' + icon('warn') + ' 승인 당시 등록 정보를 확인하지 않은 상태에서 낸 결론이에요.</p>' : '') +
      (selected.conclusion === 'audit_report' ? '<p class="note">다음 승인 때 임원에게 "3개월 사전 확인" 조건이 제안돼요.</p>' : '') +
      (selected.conclusion === 'recovery' ? (selected.recoveryDone ? '<p class="note">' + icon('ok') + ' 영업지원팀 회수 확인: ' + escape(selected.recoveryDone.reason) + '</p>'
        : c.role === '영업지원팀' && c.open ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
          '<label class="field" style="margin-top:12px">회수 확인 내용 <textarea name="reason" maxlength="1000" required placeholder="거래처와 확인한 회수 방법·일정"></textarea></label>' +
          '<div style="margin-top:10px"><button class="primary" name="action" value="recovery_done">회수 확인 저장</button></div>') : '<p class="note">' + icon('wait') + ' 영업지원팀이 거래처와 회수를 확인하고 있어요.</p>') : '') + '</section>'
      : canDecide ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
        '<section class="card"><h2 style="margin-bottom:12px">결론</h2><div class="line" style="flex-wrap:wrap;align-items:stretch">' +
        [['closed', '종결', '이유가 확인돼 기록만 남겨요'], ['audit_report', '감사 보고', '감사 목록에 올리고, 다음 승인 때 임원에게 알려요'], ['recovery', '회수 검토', '영업지원팀에 회수 확인 일을 만들어요']]
          .map(([value, label, sub]) => '<label class="choice"><input type="radio" name="conclusion" value="' + value + '" required><span><strong>' + label + '</strong><br><span class="muted">' + sub + '</span></span></label>').join('') +
        '</div>' + (selected.masterCheck ? '' : '<p class="note warn">' + icon('warn') + ' 승인 당시 등록 정보가 아직 확인되지 않았어요. 지금 결론을 내면 "미확인 상태 결론"으로 기록돼요.</p>') +
        '<label class="field" style="margin-top:12px">검토 의견 <textarea name="reason" maxlength="1000" required></textarea></label>' +
        '<div style="margin-top:12px"><button class="primary" name="action" value="post_audit_done">결론 저장</button></div></section>')
        : '<section class="card tight"><p class="muted">' + icon('wait') + ' 회계가 결론을 내는 중이에요. 이 화면은 볼 수만 있어요.</p></section>');
}

/* ---------- 대리점 ---------- */

export function dealerHome(c, h) {
  const own = c.list.filter(entry => entry.group.members.some(member => member.agencyId === c.agency));
  const requests = own.filter(entry => c.recipientsFor(entry).includes(c.agency));
  const open = requests.filter(entry => ['waiting', 'received'].includes(c.stateFor(entry)));
  const info = c.currentAgency(c.agency);
  const rebates = c.data.rebates.filter(row => row.agency_id === c.agency).sort((a, b) => b.period_ym.localeCompare(a.period_ym)).slice(0, 4);
  return '<div><h1>안녕하세요, ' + escape(h.name(c.agency)) + '</h1></div>' +
    open.map(entry => {
      const events = c.eventsFor(entry.group.groupId);
      const asked = requestItems(events, entry.group.groupId).filter(row => row.recipients.includes(c.agency));
      const due = events.findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;
      const mine = mergedAnswers(events)[c.agency];
      const resend = events.findLast(event => ['send', 'resend'].includes(event.action))?.action === 'resend';
      return '<section class="card focus"><div class="top"><div><p class="muted">' + (due ? '답변 기한 ' + escape(due) : '답변 요청') + '</p><h2>' + Number(c.period.slice(5)) + '월 장려금 확인 요청 · 항목 ' + asked.length + '개</h2>' +
        '<p class="muted" style="margin-top:4px">' + (resend ? '보완이 필요한 항목이 있어요' : mine ? '답변을 보냈어요 · 기한 전까지 고칠 수 있어요' : 'Corevia 영업지원팀 · 지급 전에 확인이 필요합니다') + '</p></div>' +
        '<a class="btn primary" href="' + c.link({ view: 'agency-replies', group: entry.group.groupId }) + '">' + (mine && !resend ? '답변 고치기' : '답변하기') + '</a></div></section>';
    }).join('') +
    '<section class="card"><h2 style="margin-bottom:8px">장려금 내역' + src('raw') + '</h2>' + table(['정산월', '장려금', '상태'], rebates.map(row => {
      const entry = own.find(candidate => candidate.period === row.period_ym);
      const state = entry && row.period_ym === c.period ? c.stateFor(entry) : null;
      return [escape(row.period_ym), money(Number(row.rebate_amount_krw)), /^\d{4}-\d{2}-\d{2}$/.test(row.payment_date) ? '지급 ' + escape(row.payment_date.slice(5)) :
        state === 'reconciled' ? '지급 완료' : ['paymentReady', 'repayReady'].includes(state) ? '지급 예정' : state === 'paymentReturned' ? '지급 반려 · 계좌 확인 중' : ['waiting', 'received', 'draft', 'verified'].includes(state) ? '확인 중' : '검토 중'];
    }), { numeric: [1] }) + '</section>' +
    '<section class="card"><div class="top"><div><h2>등록 정보</h2><p class="muted" style="margin-top:4px">대표자 ' + escape(info?.representative_name) + ' · ' + escape(info?.address) + ' · 정산계좌 ' + mask(info?.bank_account_no) + '</p></div>' +
    '<a class="btn" href="' + c.link({ view: 'documents' }) + '">정보 변경 신청</a></div></section>' +
    '<p class="muted">이 화면에는 우리 거래처 정보만 보여요. 다른 거래처 금액이나 내부 검토 의견은 보이지 않아요.</p>';
}

export function dealerReply(c, h) {
  const entry = c.item;
  const id = entry.group.groupId;
  const events = c.eventsFor(id);
  const asked = requestItems(events, id).filter(row => row.recipients.includes(c.agency));
  const request = events.findLast(event => ['send', 'resend'].includes(event.action));
  const first = events.find(event => event.action === 'send');
  const mine = mergedAnswers(events)[c.agency];
  const previousItems = allRequestedItems(events, id).filter(row => row.recipients.includes(c.agency) && !asked.some(askedRow => askedRow.id === row.id));
  const editable = c.open && ['waiting', 'received'].includes(c.stateFor(entry));
  const value = (itemId, key) => escape(mine?.items[itemId]?.[key] ?? '');
  const info = c.currentAgency(c.agency);
  const field = row => {
    const base = '<div class="card" style="display:flex;flex-direction:column;gap:10px"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><h2>' + escape(row.label) + '</h2>' +
      (mine?.items[row.id] ? pill('blue', '보냄') : pill('amber', '답변 필요')) + '</div>';
    const attach = row.attachment ? '<label class="field">' + escape(row.attachment) + ' <span class="muted" style="font-weight:400">파일 이름이나 보관 위치</span><input name="att_' + escape(row.id) + '" value="' + value(row.id, 'attachment') +
      '" maxlength="300" placeholder="예: ' + escape(row.attachment.replace(/\s/g, '')) + '_' + escape(c.agency) + '.pdf"></label>' : '';
    if (row.format === 'account') return base + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px"><label class="field">받는 계좌<input name="acc_' + escape(row.id) +
      '" value="' + value(row.id, 'account') + '" maxlength="80" placeholder="은행 계좌번호"></label><label class="field">예금주<input name="holder_' + escape(row.id) + '" value="' + value(row.id, 'holder') +
      '" maxlength="60"></label></div><label class="field">설명 (선택)<textarea name="ans_' + escape(row.id) + '" maxlength="600">' + value(row.id, 'text') + '</textarea></label>' + attach +
      '<p class="muted">등록된 정산계좌(' + mask(info?.bank_account_no) + ')와 다른 계좌라면 <a href="' + c.link({ view: 'documents' }) + '">정산계좌 변경 신청</a>도 함께 해 주세요.</p></div>';
    if (row.format === 'yesno') return base + '<div class="seg" role="radiogroup" aria-label="' + escape(row.label) + '">' + ['예', '아니오'].map(option =>
      '<label><input type="radio" name="yn_' + escape(row.id) + '" value="' + option + '"' + (mine?.items[row.id]?.yesno === option ? ' checked' : '') + '><span>' + option + '</span></label>').join('') +
      '</div><label class="field">설명<textarea name="ans_' + escape(row.id) + '" maxlength="600">' + value(row.id, 'text') + '</textarea></label>' + attach + '</div>';
    return base + '<textarea name="ans_' + escape(row.id) + '" maxlength="600" aria-label="' + escape(row.label) + ' 답변">' + value(row.id, 'text') + '</textarea>' + attach + '</div>';
  };
  return '<div><p class="crumb"><a href="' + c.link({ view: 'agency-replies', group: '' }) + '">홈</a> › 확인 요청</p><h1>' + Number(c.period.slice(5)) + '월 장려금 확인 요청</h1>' +
    '<p class="muted" style="margin-top:4px">' + (first ? (first.metadata?.occurredOn ?? time(first.acted_at)) + ' 요청' : '') + (request?.action === 'resend' ? ' · ' + (request.metadata?.occurredOn ?? time(request.acted_at)) + ' 보완 요청' : '') +
    (request?.metadata?.dueDate ? ' · 기한 ' + escape(request.metadata.dueDate) : '') + '</p></div>' +
    (request?.action === 'resend' ? '<section class="card tight warn"><strong>보완이 필요한 항목 ' + asked.length + '개</strong><p class="muted" style="margin-top:4px">' +
      escape(request.reason.split('\n').filter(line => !/^D-\d+ · /.test(line) || line.startsWith(c.agency + ' · ')).map(line => line.replace(/^D-\d+ · /, '')).join(' ')) + '</p></section>' : '') +
    (previousItems.length ? '<section class="card tight"><div class="rows">' + previousItems.map(row => '<div class="row"><span class="line">' + icon('ok') + escape(row.label) +
      '</span><span class="muted">확인 완료</span></div>').join('') + '</div></section>' : '') +
    (editable ? h.post({ view: 'agency-replies', group: id }, asked.map(field).join('') + '<div style="display:none">' + recordFields(c.period, null, c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><span class="muted">준비된 항목만 먼저 보내도 돼요. 보내면 영업지원팀에 알림이 가고, 기한 전까지 고칠 수 있어요.</span>' +
      '<button class="primary" name="action" value="reply">' + (mine ? '답변 다시 보내기' : '답변 보내기') + '</button></div>')
      : '<section class="card"><p class="empty">지금은 답변할 수 없어요 · 영업지원팀이 확인 중이에요</p></section>');
}

export function dealerDocs(c, h) {
  const docs = c.documents.slice().reverse();
  const info = c.currentAgency(c.agency);
  const reviewOf = doc => c.reviews.find(review => review.document_id === doc.id);
  const kinds = { account: '정산계좌', address: '사업장 주소', representative: '대표자' };
  return '<div><h1>서류</h1><p class="muted" style="font-size:14px;margin-top:4px">확인 요청에서 받은 서류는 요청 화면의 항목에서 바로 적을 수 있어요</p></div>' +
    '<section class="card"><h2 style="margin-bottom:8px">보낸 서류</h2>' + table(['보낸 날', '내용', '처리 상태'], docs.map(doc => [doc.received_at ? time(doc.received_at) : '—',
      escape(doc.original.split('\n')[0].slice(0, 40)), reviewOf(doc) || doc.applied ? pill('green', '✓ 반영') : doc.confirmed ? pill('blue', '확인 완료') : pill('amber', '◷ 영업지원팀 확인 중')]), { empty: '보낸 서류가 없어요' }) + '</section>' +
    (c.open ? h.post({ view: 'documents' }, '<input type="hidden" name="agency" value="' + escape(c.agency) + '"><section class="card" style="display:flex;flex-direction:column;gap:12px"><h2>등록 정보 변경 신청</h2>' +
      '<p class="muted">영업지원팀 확인 뒤 반영돼요. 진행 중인 장려금 검토에 영향을 줄 수 있어요.</p>' +
      '<div class="seg" role="radiogroup" aria-label="바꿀 정보">' + Object.entries(kinds).map(([value, label], index) => '<label><input type="radio" name="kind" value="' + value + '"' + (index ? '' : ' checked') + '><span>' + label + '</span></label>').join('') + '</div>' +
      '<p class="muted">지금 등록: 대표자 ' + escape(info?.representative_name) + ' · ' + escape(info?.address) + ' · 정산계좌 ' + mask(info?.bank_account_no) + '</p>' +
      '<label class="field">바꿀 내용<input name="newValue" maxlength="200" required placeholder="예: 국민 412-27-556311"></label>' +
      '<label class="field">변경 사유<input name="why" maxlength="300" required placeholder="예: 장려금 계좌를 거래처별로 분리"></label>' +
      '<label class="field">첨부한 서류 <span class="muted" style="font-weight:400">파일 이름이나 보관 위치 · 대표자 서명 필요</span><input name="attachment" maxlength="200" placeholder="예: 계좌변경신청서.pdf"></label>' +
      '<details><summary>또는 서류 내용을 그대로 붙여넣기</summary><textarea name="text" maxlength="6000" style="margin-top:8px"></textarea></details>' +
      '<div style="display:none">' + recordFields(c.period, null, c.businessDate) + '</div><div><button class="primary" name="action" value="document_add">변경 신청</button></div></section>') : '');
}

/* ---------- 관리자 ---------- */

export function aiLog(c, h) {
  const purposes = { items: '확인 항목 제안', reply_check: '답변 판정', extract: '서류 읽기', conditions: '승인 조건 제안', draft: '요청서 초안' };
  const legacy = { summary: '근거 요약 (이전 기능)' };
  const filter = Object.hasOwn(purposes, c.query.get('kind')) ? c.query.get('kind') : '';
  const calls = c.calls.filter(call => !filter || call.kind === filter).slice().reverse();
  const outcome = call => {
    if (!call.finished_at) return ['wait', '결정 전'];
    if (!call.result) return ['no', '실패 · 사람이 직접'];
    const events = c.events.filter(event => event.group_id === call.group_id);
    if (call.kind === 'items') {
      const sent = events.find(event => event.action === 'send' && event.metadata?.ai?.callId === String(call.id));
      return sent ? (sent.metadata.ai.agreed ? ['ok', '그대로 보냄'] : ['warn', '바꿔서 보냄']) : ['wait', '결정 전'];
    }
    if (call.kind === 'reply_check') {
      const decided = events.find(event => ['resend', 'verify'].includes(event.action) && event.metadata?.ai?.callId === String(call.id));
      return decided ? (decided.metadata.ai.agreed ? ['ok', '따름'] : ['warn', '다르게 결정']) : ['wait', '결정 전'];
    }
    if (call.kind === 'conditions') {
      const record = c.saved.get(call.group_id);
      if (!record || record.action !== 'approve') return ['wait', '결정 전'];
      const chosen = record.conditions ?? [];
      const same = chosen.length === call.result.conditions.length && chosen.every(id => call.result.conditions.includes(id));
      return same ? ['ok', '그대로 선택'] : ['warn', call.result.conditions.length + '개 중 ' + chosen.filter(id => call.result.conditions.includes(id)).length + '개 선택'];
    }
    if (call.kind === 'extract') {
      const doc = c.allDocuments.find(row => row.id === call.document_id);
      if (!doc?.confirmed) return ['wait', '결정 전'];
      const changed = Object.keys(extractFields).filter(key => doc.confirmed[key]?.decision === 'edit').length;
      return changed ? ['warn', changed + '개 값 고침'] : ['ok', '수락'];
    }
    return ['wait', '이전 기능 기록'];
  };
  const summary = call => {
    const r = call.result;
    if (!r) return '<span class="muted">' + escape(call.raw?.error ?? (call.finished_at ? '응답 없음' : '처리 중')) + '</span>';
    if (call.kind === 'items') return r.items.map(row => escape(c.catalogLabel(row.id))).join(', ') + (r.newItem ? ' · 새 항목 "' + escape(r.newItem) + '"' : '');
    if (call.kind === 'reply_check') return ['met', 'partial', 'missing'].map(verdict => verdictLabels[verdict] + ' ' + r.items.filter(row => row.verdict === verdict).length).join(' · ');
    if (call.kind === 'conditions') return r.conditions.map(id => escape(conditionCatalog[id] ?? id)).join(', ');
    if (call.kind === 'extract') return Object.entries(extractFields).map(([key, label]) => r[key]?.candidates?.[0] ? label + ' ' + escape(key === 'bank_account_no' ? '••' + r[key].candidates[0].value.slice(-4) : r[key].candidates[0].value) : null).filter(Boolean).join(' · ');
    return '완료';
  };
  const counts = calls.filter(call => purposes[call.kind]).reduce((acc, call) => { const [tone] = outcome(call); acc[tone] = (acc[tone] ?? 0) + 1; return acc; }, {});
  return '<div><h1>AI 사용 기록</h1><p class="muted" style="font-size:14px;margin-top:4px">AI 결과와 사람 결정이 다른 건을 먼저 확인하세요</p></div>' +
    '<div class="stats"><div class="stat"><span>호출</span><strong>' + calls.length + '</strong></div><div class="stat"><span>사람이 따름</span><strong>' + (counts.ok ?? 0) + '</strong></div>' +
    '<div class="stat"><span>사람이 바꿈</span><strong>' + (counts.warn ?? 0) + '</strong></div><div class="stat"><span>실패</span><strong>' + (counts.no ?? 0) + '</strong></div></div>' +
    '<div class="tabs"><a class="btn tab" href="' + c.link({ view: 'ai-log', kind: '' }) + '"' + (filter ? '' : ' aria-current="page"') + '>전체</a>' +
    Object.entries(purposes).map(([key, label]) => '<a class="btn tab" href="' + c.link({ view: 'ai-log', kind: key }) + '"' + (filter === key ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</div>' +
    '<section class="card">' + table(['시각', '용도', '대상', 'AI 결과', '사람 결정'], calls.map(call => {
      const [tone, text] = outcome(call);
      const target = call.group_id ? escape(h.name(call.group_id)) + (c.list.find(entry => entry.group.groupId === call.group_id)?.group.members.length > 1 ? ' 외' : '') : '서류 ' + escape(call.document_id);
      return [time(call.created_at) + '<br><span class="muted">' + escape(call.period) + '</span>', escape(purposes[call.kind] ?? legacy[call.kind] ?? call.kind), target,
        summary(call) + '<details><summary>보낸 내용·응답 원문</summary><pre class="doc" style="font-size:12px">' + escape(JSON.stringify({ request: call.request, response: call.raw }, null, 2)).slice(0, 6000) + '</pre></details>',
        '<span class="line">' + icon(tone) + escape(text) + '</span>'];
    }), { empty: 'AI 호출 기록이 없어요' }) + '<p class="muted" style="margin-top:8px">AI 결과는 코드가 허용 목록·원문 인용으로 다시 검사한 뒤에만 화면에 써요.</p></section>';
}

export function catalogAdmin(c, h) {
  const items = Object.entries(c.catalog.items);
  const conditions = Object.entries(c.catalog.conditions);
  const usage = id => c.allEvents.filter(event => event.action === 'send' && event.metadata?.items?.some(row => row.id === id)).length;
  const toggle = (id, status) => h.post({ view: 'catalog' }, '<input type="hidden" name="id" value="' + escape(id) + '"><input type="hidden" name="status" value="' +
    (status === 'active' ? 'disabled' : 'active') + '"><button class="small" name="action" value="catalog_status">' +
    (status === 'active' ? '사용 중지' : status === 'proposed' ? '승인' : '다시 사용') + '</button>');
  const statusPill = status => status === 'active' ? pill('green', '사용') : status === 'proposed' ? pill('blue', 'AI 제안 · 검토 대기') : pill('gray', '중지');
  const disputes = [...new Set(c.allEvents.filter(event => event.action === 'dispute').map(event => event.group_id + '|' + event.period))].map(key => {
    const [groupId, period] = key.split('|');
    const trail = c.allEvents.filter(event => event.group_id === groupId && event.period === period && ['dispute', 'dispute_close'].includes(event.action));
    return { groupId, period, last: trail.at(-1), opened: trail.findLast(event => event.action === 'dispute') };
  });
  const kinds = { not_same: '같은 사람이 아님', changed: '정보가 이미 바뀜', other: '기타' };
  return '<div><h1>항목·조건 목록</h1><p class="muted" style="font-size:14px;margin-top:4px">AI는 이 목록에서 먼저 고르고, 맞는 게 없으면 새 항목을 제안해요. 확정은 사람이 해요.</p></div>' +
    '<section class="card"><h2 style="margin-bottom:8px">확인 항목</h2>' + table(['항목', '답변 형식', '필수 첨부', '보낸 횟수', '상태', ''], items.map(([id, row]) => [
      escape(row.label), escape(formatHints[row.format] ?? '글로 답변'), escape(row.attachment || '—'), String(usage(id)), statusPill(row.status), toggle(id, row.status)])) +
    h.post({ view: 'catalog' }, '<input type="hidden" name="kind" value="item"><div class="line" style="flex-wrap:wrap;margin-top:12px"><input name="label" maxlength="60" required placeholder="새 항목 이름" aria-label="새 항목 이름" style="flex:2 1 200px;width:auto">' +
      '<select name="format" aria-label="답변 형식" style="flex:1 1 120px;width:auto"><option value="text">글로 답변</option><option value="account">계좌·예금주</option><option value="yesno">예/아니오</option></select>' +
      '<input name="attachment" maxlength="40" placeholder="필수 첨부 (선택)" aria-label="필수 첨부" style="flex:1 1 140px;width:auto"><button name="action" value="catalog_add">항목 추가</button></div>') + '</section>' +
    '<section class="card"><h2 style="margin-bottom:8px">승인 조건</h2>' + table(['조건', '상태', ''], conditions.map(([id, row]) => [escape(row.label), statusPill(row.status), toggle(id, row.status)])) +
    '<p class="muted" style="margin-top:6px">조건은 묶음 근거에 맞는 것만 임원에게 보여요. 고친 내용은 다음 요청부터 적용되고, 이미 보낸 요청은 바뀌지 않아요.</p></section>' +
    '<section class="card" id="disputes"><h2 style="margin-bottom:8px">묶음 이의 제기</h2>' + (disputes.length ? disputes.map(row => '<div class="row" style="flex-wrap:wrap;align-items:flex-start"><div style="flex:1 1 280px"><strong>' +
      escape(h.name(row.groupId)) + ' 묶음 · ' + escape(row.period) + '</strong><br><span class="muted">' + escape(kinds[row.opened.metadata?.kind] ?? '') + ' · ' + escape(row.opened.reason) + ' · ' + time(row.opened.acted_at) + '</span>' +
      (row.last.action === 'dispute_close' ? '<br><span class="muted">처리: ' + (row.last.metadata?.result === 'fixed' ? '받아들임' : '묶음 유지') + ' · ' + escape(row.last.reason) + '</span>' : '') + '</div>' +
      (row.last.action === 'dispute' ? '<form method="post" action="/?' + escape(new URLSearchParams({ period: row.period, view: 'catalog' }).toString()) + '" class="line" style="flex-wrap:wrap;flex:1 1 320px"><input type="hidden" name="disputeGroup" value="' + escape(row.groupId) + '">' +
        '<select name="result" aria-label="처리 결과" style="width:auto"><option value="kept">묶음 유지</option><option value="fixed">받아들임 · 원본 수정 요청</option></select><input name="reason" maxlength="1000" required placeholder="검토 내용" aria-label="검토 내용" style="flex:1 1 160px;width:auto">' +
        '<button class="small" name="action" value="dispute_close">처리</button></form>' : pill('gray', '처리 완료')) + '</div>').join('')
      : '<p class="empty">이의 제기가 없어요</p>') + '<p class="muted" style="margin-top:6px">묶음 판정 규칙(대표자·주소·계좌 중 2개 일치)은 원본 자료로 계산해요. 받아들여도 원본은 바꾸지 않고, 원본 수정 요청으로 남겨요.</p></section>' +
    '<section class="card" id="reset"><h2>시연 초기화</h2><p class="muted" style="margin-top:4px">이 정산월(' + escape(c.period) + ')의 앱 기록(결정·요청·답변·서류·AI 기록)을 모두 지워요. 원본 CSV와 항목 목록은 그대로예요. 되돌릴 수 없어요.</p>' +
    (c.open ? h.post({ view: 'catalog' }, '<div class="line" style="flex-wrap:wrap;margin-top:10px"><input name="confirm" required pattern="' + escape(c.period) + ' 초기화" placeholder="' + escape(c.period) + ' 초기화 라고 입력" aria-label="확인 문구" style="flex:1 1 220px;width:auto">' +
      '<button class="danger" name="action" value="reset">초기화</button></div>') : '<p class="muted">지급이 끝난 달은 초기화할 기록이 없어요.</p>') + '</section>';
}
