// 역할별 화면(S01~S20). workflow.mjs가 만든 업무 상태(c)를 받아 HTML 조각을 돌려준다.
import { conditionCatalog, confirmedConditions, masterCheckResults, postAuditCause, postAuditConclusions, verdictLabels } from './controls.mjs';
import { addBusinessDays, allRequestedItems, banks, itemMarks, mergedAnswers, requestItems, resendItems, sameAccount } from './requests.mjs';
import { fields as extractFields } from './condition.mjs';
import { bar, escape, icon, manwon, mask, money, pill, recordFields, src, table, time, today } from './ui.mjs';
import { metadataView } from './audit.mjs';

const LIMIT = 2_000_000;
const fieldNames = { representative_name: '대표자', address: '주소', bank_account_no: '계좌' };
const onHold = state => ['draft', 'waiting', 'received', 'verified'].includes(state);
const formatHints = { text: '글로 답변', account: '은행, 계좌번호, 예금주', yesno: '예/아니오' };
const conclusionTone = { closed: 'gray', audit_report: 'amber', recovery: 'red' };

export function helpers(c) {
  const name = id => c.agencyNames.get(id) ?? id;
  const title = entry => name(entry.group.members[0].agencyId);
  const record = entry => c.saved.get(entry.group.groupId);
  const revision = entry => '<input type="hidden" name="revision" value="' + escape(c.eventsFor(entry.group.groupId).at(-1)?.id ?? '0') + '">';
  const post = (extras, body, attrs = '') => '<form method="post" action="' + c.link(extras) + '"' + attrs + '>' + body + '</form>';
  const status = entry => {
    if (!c.open) return ['gray', '지급 완료'];
    const state = c.stateFor(entry);
    const saved = record(entry);
    const held = c.isAffected(entry);
    if (held && state === 'resubmitted') return ['blue', '임원 재결정 대기'];
    if (held) return ['amber', '정보 변경 재검토'];
    if (state === 'reconciled') return ['green', '지급 완료'];
    if (state === 'paymentReady') return ['blue', '은행 회신 대기'];
    if (state === 'paymentReturned') return ['red', '지급 반려'];
    if (state === 'repayReady') return ['blue', '재지급 대기'];
    if (state === 'paymentPending') {
      const left = (saved.conditions ?? []).filter(id => !confirmedConditions(saved, c.eventsFor(entry.group.groupId)).has(id)).length;
      return left ? ['blue', '회계 조건 확인'] : ['blue', '지급 대기'];
    }
    if (state === 'resubmitted') return ['blue', '다시 올라옴'];
    if (state === 'draft') return ['red', '임원 거절'];
    if (state === 'waiting') return ['amber', '답변 대기'];
    if (state === 'received') return ['amber', '답변 도착'];
    if (state === 'verified') return ['amber', '다시 올리기'];
    const team = c.teamState?.(entry);
    if (team?.action === 'team_hold') return ['amber', '보류'];
    if (team?.action === 'team_reject') return ['red', '반려'];
    if (!saved && entry.exceedsLimit) return ['blue', '영업임원 결정 대기'];
    if (!saved) return ['gray', '팀 승인 대기'];
    return ['gray', saved.action];
  };
  const statusPill = entry => pill(...status(entry));
  const outsideDeposits = entry => entry.collectionEvidence.flatMap(evidence => evidence.deposits
    .filter(row => !evidence.registered.some(registered => registered.agencyId === row.agencyId) && evidence.registered.length)
    .map(row => ({ ...row, account: evidence.account, owners: evidence.registered.map(registered => registered.agencyId) })));
  const pastFor = entry => c.past.find(row => row.groupId === entry.group.groupId);
  // AI 다시 제안: 숨은 폼을 두고, 카드 머리의 버튼이 form 속성으로 그 폼을 제출한다.
  const regen = (extras, action, target, label = '다시 제안') => ({
    form: post(extras, '<button name="action" value="' + action + '">AI</button>', ' id="regen-' + action + '" hidden data-ai data-target="' + target + '"'),
    button: c.open ? '<button type="submit" class="link" form="regen-' + action + '" name="action" value="' + action + '">' + label + '</button>' : '',
  });
  return { name, title, record, revision, post, status, statusPill, outsideDeposits, pastFor, regen };
}

function summaryCard(c, h, entry, { compact = false } = {}) {
  const over = entry.totalKrw > LIMIT;
  const month = Number(entry.period.slice(5)) + '월';
  const head = '<section class="card"><div class="kv" style="font-size:15px">' +
    (entry.group.members.length > 1 ? '<span>묶인 거래처</span><span>' + entry.group.members.map(member => escape(h.name(member.agencyId))).join(', ') + '</span>' : '') +
    '<span>' + month + ' 합계 ' + src('calc', '원본 계산') + '</span><strong style="font-size:22px">' + money(entry.totalKrw) + '</strong>' +
    '<span>팀 승인 한도</span><span>' + money(LIMIT) + (over ? ' <strong style="color:#a12a2a;margin-left:6px">' + manwon(entry.totalKrw - LIMIT) + ' 초과</strong>' : '') + '</span>' +
    '<span>승인권자</span><strong' + (over ? ' style="color:#a12a2a"' : '') + '>' + (over ? '영업임원' : '영업지원팀') + '</strong></div></section>';
  if (compact || entry.group.members.length < 2) return head;
  return head + '<section class="card"><div class="hd"><h2>왜 한 거래처로 보나요</h2><span class="r">대표자, 주소, 정산계좌 중 2개 이상 같으면 묶음</span></div>' +
    groupPairs(entry, h).map(([pair, matched, linked]) => '<div class="row"><span' + (linked ? '' : ' class="muted"') + '>' + pair + '</span><span' + (linked ? '' : ' class="muted"') + '>' + matched + '</span></div>').join('') +
    '<div class="agencies" style="margin-top:12px">' + entry.rebateRows.map(row => '<div class="agency" title="원본 ' + escape(row.source.file + ' ' + row.source.row + '행') + '"><span class="muted">' + escape(h.name(row.agencyId)) +
      '</span><strong>' + money(row.amountKrw) + '</strong></div>').join('') + '</div></section>';
}

function groupPairs(entry, h) {
  const members = entry.group.members.map(member => member.agencyId);
  const linked = new Map(entry.group.links.map(link => [link.agencyIds.join('|'), link]));
  const names = id => escape(h.name(id));
  const pairs = [];
  for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
    const link = linked.get(members[i] + '|' + members[j]) ?? linked.get(members[j] + '|' + members[i]);
    const via = link ? null : members.find(other => other !== members[i] && other !== members[j] &&
      [[members[i], other], [members[j], other]].every(([a, b]) => linked.has(a + '|' + b) || linked.has(b + '|' + a)));
    pairs.push([names(members[i]) + ' ↔ ' + names(members[j]),
      link ? link.matchedFields.map(field => fieldNames[field]).join(', ') + ' 같음' : (via ? names(via) + '을 거쳐 연결' : '다른 거래처를 거쳐 연결'), Boolean(link)]);
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
        (event.metadata?.source ? ' <span class="muted">(' + (event.metadata.source === 'scenario' ? '추가 시나리오 자료' : '가상 회신, 직접 입력') + ')</span>' : ''),
      '<span class="muted">' + time(event.acted_at) + '</span>']), { empty: '아직 기록이 없어요' }) + '</details>';
}

/* ---------- 영업지원팀 ---------- */

// 목록 한 줄: 왼쪽 이름(과 보조 한 줄), 오른쪽 상태·금액·날짜
function lrow(href, title, sub, right) {
  return '<a class="lrow" href="' + href + '"><span class="l"><strong style="font-weight:600">' + escape(title) + '</strong>' + (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="r">' + right + '</span></a>';
}
// 남은 날: 업무일 기준. 하루 남으면 빨강, 지나면 "기한 지남"
function dday(due, today) {
  if (!due) return '';
  const days = Math.round((new Date(due + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  if (days < 0) return '<span class="dd hot">기한 지남</span>';
  return '<span class="dd' + (days <= 1 ? ' hot' : days <= 3 ? ' warn' : '') + '">' + (days === 0 ? '오늘 마감' : 'D-' + days) + '</span>';
}
const listCard = (rows, empty) => '<section class="card" style="padding-top:6px;padding-bottom:6px">' + (rows.length ? rows.join('') : '<p class="empty">' + empty + '</p>') + '</section>';
const dueOf = (c, entry) => c.eventsFor(entry.group.groupId).findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;



export function supportList(c, h) {
  const tabs = ['mine', 'flag', 'exec', 'hold', 'rejected', 'done', 'all'];
  const tab = tabs.includes(c.query.get('tab')) ? c.query.get('tab') : 'mine';
  const q = (c.query.get('q') ?? '').trim();
  const match = entry => !q || entry.group.members.some(member => member.agencyId.includes(q) || h.name(member.agencyId).includes(q));
  const paidStates = ['paymentPending', 'paymentReady', 'reconciled', 'paymentReturned', 'repayReady'];
  const anomalies = c.open ? c.anomalies() : [];
  const flagged = entry => anomalies.find(fact => entry.group.members.some(member => member.agencyId === fact.id));
  const team = entry => c.teamState(entry)?.action;
  const groups = {
    mine: entry => c.selectable(entry),
    flag: entry => c.selectable(entry) && flagged(entry),
    exec: entry => (entry.exceedsLimit || c.precheck.has(entry.group.groupId)) && !paidStates.includes(c.stateFor(entry)),
    hold: entry => team(entry) === 'team_hold' || onHold(c.stateFor(entry)) || c.isAffected(entry),
    rejected: entry => team(entry) === 'team_reject',
    done: entry => paidStates.includes(c.stateFor(entry)) || !c.open,
    all: () => true,
  };
  const labels = { mine: '팀 승인', flag: '확인 권장', exec: '임원 승인', hold: '보류', rejected: '반려', done: c.open ? '완료' : '지급 완료', all: '전체' };
  const visibleTabs = c.open ? tabs : ['done', 'all'];
  const current = visibleTabs.includes(tab) ? tab : visibleTabs[0];
  const counts = Object.fromEntries(visibleTabs.map(key => [key, c.list.filter(groups[key]).length]));
  const rows = c.list.filter(groups[current]).filter(match);
  const call = c.anomalyCall();
  const note = agencyId => call?.result?.points.find(point => point.facts[0] === agencyId)?.text;
  const canAct = c.open && c.role === '영업지원팀' && ['mine', 'flag'].includes(current) && rows.some(entry => c.selectable(entry));
  const row = entry => {
    const flag = flagged(entry);
    const checkbox = canAct ? (c.selectable(entry) ? '<input type="checkbox" name="request" value="' + escape(entry.group.groupId) + '" data-amount="' + entry.totalKrw + '"' + (flag ? '' : ' checked') +
      ' aria-label="' + escape(h.title(entry)) + ' 선택" style="width:18px;height:18px">' : '<span></span>') : '';
    return '<div class="lrow" style="display:grid;grid-template-columns:' + (canAct ? '28px ' : '') + '1fr auto;gap:12px">' + checkbox +
      '<span class="l"><a href="' + c.link({ view: 'requests', group: entry.group.groupId }) + '"><strong style="font-weight:600;color:#182638">' + escape(h.title(entry)) + '</strong></a>' +
      (flag ? '<small style="color:#59438c"><span class="ai-b">AI</span>' + escape(note(flag.id) ?? flag.text.replace(h.name(flag.id) + ' ', '')) + '</small>' : '') + '</span>' +
      '<span class="r"><span class="amt">' + money(entry.totalKrw) + '</span>' + (flag && c.selectable(entry) ? pill('amber', '확인 권장') : h.statusPill(entry)) + '</span></div>';
  };
  const list = '<section class="card" id="anomaly" style="padding-top:6px;padding-bottom:6px">' + (rows.length ? rows.map(row).join('') : '<p class="empty">' + (q ? '찾는 거래처가 없어요' : '이 목록은 비어 있어요') + '</p>') + '</section>';
  const periodSelect = '<form method="get"><input type="hidden" name="view" value="requests"><select name="period" aria-label="정산월" onchange="this.form.submit()" style="width:auto;padding:8px 12px">' +
    c.periods.map(value => '<option value="' + value + '"' + (value === c.period ? ' selected' : '') + '>' + value + (value === c.periods[0] ? ' 진행 중' : ' 지급 완료') + '</option>').join('') + '</select></form>';
  const aiCard = c.open && counts.flag ? '<section class="ai-card"><div class="hd" style="margin-bottom:4px"><h2 style="font-size:14px"><span class="ai-b">AI</span>확인 권장 ' + anomalies.length + '건</h2>' +
    '<span class="r"><a class="link" href="' + c.link({ view: 'requests', tab: 'flag' }) + '">보기</a></span></div><p style="font-size:14px">장려금률이 그 거래처 평소보다 1.2%p 이상 높은 건이에요. 승인 전에 한 번 보세요.</p></section>' : '';
  const auto = c.open && anomalies.length && !call && c.role === '영업지원팀' ? h.post({ view: 'requests', group: '' }, '<button name="action" value="ai_anomaly">AI</button>', ' hidden data-ai data-auto data-target="#anomaly"') : '';
  const actionBar = canAct ? '<div class="line" style="justify-content:space-between;flex-wrap:wrap;padding:12px 14px;border-radius:10px;background:#f5f8fc">' +
    '<span><strong data-count></strong> <span class="muted" data-sum style="margin-left:8px"></span></span>' +
    '<span class="line" style="flex-wrap:wrap"><input name="reason" maxlength="300" placeholder="보류, 반려 사유" aria-label="보류, 반려 사유" style="width:200px">' +
    '<button name="action" value="bulk_hold">보류</button><button class="danger" name="action" value="bulk_reject">반려</button><button class="primary" name="action" value="bulk_approve">승인</button></span></div>' +
    '<div hidden>' + recordFields(c.period, null, c.businessDate) + '</div>' : '';
  return auto + '<div class="top" style="align-items:center"><h1>승인 요청</h1>' + periodSelect + '</div>' +
    '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><div class="tabs">' + visibleTabs.map(key => '<a class="btn tab" href="' + c.link({ view: 'requests', tab: key }) + '"' +
      (key === current ? ' aria-current="page"' : '') + '>' + labels[key] + ' ' + counts[key] + '</a>').join('') + '</div>' +
    '<form method="get" class="line"><input type="hidden" name="period" value="' + escape(c.period) + '"><input type="hidden" name="view" value="requests"><input type="hidden" name="tab" value="' + current + '">' +
    '<input type="search" name="q" value="' + escape(q) + '" placeholder="거래처 검색" aria-label="거래처 검색" style="min-width:180px"></form></div>' +
    aiCard + (canAct ? h.post({ view: 'requests', group: '' }, list + actionBar, ' data-bulk style="display:flex;flex-direction:column;gap:12px"') : list);
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
  const team = c.teamState(entry);
  if (!c.open) next = ['지급이 끝난 달이에요.', '보기만 할 수 있어요.', ''];
  else if (team?.action === 'team_hold') next = ['보류한 건이에요.', '사유: ' + team.reason, role0 ? h.post({ view: 'requests', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
    '<button name="action" value="team_release">보류 풀기</button>') : ''];
  else if (team?.action === 'team_reject') next = ['이번 달 지급에서 반려했어요.', '사유: ' + team.reason, ''];
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
    next = ['은행이 일부 지급을 반려했어요. 받는 계좌를 다시 확인해 주세요.', rows.map(([agencyId, row]) => h.name(agencyId) + ' ' + row.reason).join(', '),
      role0 ? h.post({ view: 'requests', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
        '<div class="line" style="flex-wrap:wrap"><input name="reason" maxlength="1000" required placeholder="확인 내용 (예: 예금주 표기 정정 확인)" aria-label="확인 내용" style="width:auto;flex:1 1 240px">' +
        '<button class="primary" name="action" value="payee_recheck">재확인 완료</button></div>') : ''];
  }
  else if (!record && entry.exceedsLimit || state === 'resubmitted') {
    const reminded = events.findLast(event => event.action === 'remind');
    next = ['영업임원이 결정할 차례예요.', reminded ? '다시 알림 ' + time(reminded.acted_at) : '',
      role0 ? h.post({ view: 'requests', group: id }, '<button name="action" value="remind">임원에게 다시 알리기</button>') : ''];
  } else if (!record) {
    next = ['영업지원팀이 승인하면 돼요.', '', role0 && c.selectable(entry) ? h.post({ view: 'requests', group: id },
      '<input type="hidden" name="request" value="' + escape(id) + '"><span class="line" style="flex-wrap:wrap"><input name="reason" maxlength="300" placeholder="보류, 반려 사유" aria-label="보류, 반려 사유" style="width:200px">' +
      '<button name="action" value="bulk_hold">보류</button><button class="danger" name="action" value="bulk_reject">반려</button><button class="primary" name="action" value="bulk_approve">승인</button></span>') : ''];
  } else next = ['처리가 끝났어요.', '', ''];
  const checks = [
    ...(deposits.length ? [['deposit', h.name(deposits[0].agencyId) + '가 다른 곳 계좌로 ' + deposits.length + '번 입금했어요',
      '<a href="#deposits" class="link" data-expand="deposits">입금 내역</a>']] : []),
    ...(past ? [['past', '1~' + Number(past.months.at(-1).period.slice(5)) + '월에도 한도를 넘었는데 팀 승인으로 지급됐어요',
      '<a class="link" href="' + c.link({ view: 'post-audit', audit: past.groupId }) + '">지난 지급 점검</a>']] : []),
  ];
  const disputeKinds = { not_same: '같은 사람이 아니에요 (동명이인)', changed: '주소나 계좌가 이미 바뀌었어요', other: '기타' };
  return '<div><p class="crumb"><a href="' + c.link({ view: 'requests' }) + '">승인 요청</a> › ' + Number(c.period.slice(5)) + '월</p>' +
    '<div class="top" style="align-items:center"><h1>' + escape(h.title(entry)) + '</h1>' + pill(tone, text) + '</div></div>' +
    (c.open ? '' : '<div class="card tight" style="background:#eef2f7">🔒 지급이 끝난 달이에요. 보기만 할 수 있어요.</div>') +
    (c.open ? '<section class="card focus" style="padding:16px 20px" id="current-task">' +
    '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><div><strong>' + escape(next[0]) + '</strong>' + (next[1] ? '<p class="muted" style="margin-top:2px">' + escape(next[1]) + '</p>' : '') + '</div>' + next[2] + '</div></section>' : '') +
    summaryCard(c, h, entry) +
    (role0 && entry.group.members.length > 1 ? '<section class="card tight">' + (dispute?.action === 'dispute'
      ? '<div class="row" style="border:0;padding:0"><span>' + icon('wait') + ' 묶음 이의 제기를 관리자가 검토 중이에요</span><span class="muted">' + escape(dispute.metadata?.occurredOn ?? time(dispute.acted_at)) + '</span></div>'
      : (dispute ? '<p class="muted" style="margin-bottom:8px">지난 이의 제기: ' + (dispute.metadata?.result === 'fixed' ? '받아들여짐' : '묶음 유지') + ', ' + escape(dispute.reason) + '</p>' : '') +
        '<details><summary>묶음이 잘못됐나요? 이의 제기</summary>' + h.post({ view: 'requests', group: id },
          '<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px"><select name="disputeKind" aria-label="이유">' +
          Object.entries(disputeKinds).map(([value, label]) => '<option value="' + value + '">' + label + '</option>').join('') + '</select>' +
          '<textarea name="reason" maxlength="1000" required placeholder="확인한 내용을 적어 주세요. 관리자가 검토하는 동안 이 요청은 그대로 진행돼요."></textarea>' +
          '<div><button class="primary" name="action" value="dispute">관리자에게 보내기</button></div></div>') + '</details>') + '</section>' : '') +
    (checks.length ? '<section class="card" style="padding-bottom:8px"><div class="hd"><h2>확인할 점</h2><span class="r">' +
      checks.filter(([key]) => !acked(key)).length + '건 남음</span></div><div class="rows">' + checks.map(([key, label, more]) =>
        '<div class="row"><span class="line">' + (acked(key) ? icon('ok') : icon('warn')) + '<span' + (acked(key) ? ' style="color:#7b8798"' : '') + '>' + escape(label) +
        '</span></span><span class="line" style="gap:14px">' + more + (role0 ? h.post({ view: 'requests', group: id }, '<input type="hidden" name="key" value="' + key +
          '"><button class="small" name="action" value="ack">' + (acked(key) ? '되돌리기' : '확인함') + '</button>') : '') + '</span></div>').join('') + '</div>' +
      (deposits.length ? '<details id="deposits" style="margin:6px 0 8px"><summary>입금 내역</summary>' + table(['입금', '거래처', '들어간 계좌', '그 계좌의 등록 거래처'],
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
  const dates = [...new Set(paid.map(row => row.payment_date))].join(', ');
  return '<div><p class="crumb"><a href="' + c.link({ view: 'requests' }) + '">승인 요청</a> › ' + escape(c.period) + '</p><div class="top" style="align-items:center"><h1>' + escape(h.title(entry)) + '</h1>' +
    pill('green', '지급 완료') + '</div></div>' +
    '<section class="card"><div class="kv" style="font-size:15px"><span>' + Number(c.period.slice(5)) + '월 합계</span><strong style="font-size:22px">' + money(entry.totalKrw) + '</strong>' +
    '<span>팀 승인 한도</span><span>' + money(LIMIT) + '</span><span>지급일</span><span>' + escape(dates || '기록 없음') + '</span></div></section>' +
    (entry.group.members.length > 1 ? '<section class="card"><div class="hd"><h2>묶인 거래처</h2></div><div class="agencies">' + paid.map(row =>
      '<div class="agency" title="원본 ' + escape(row.source.file + ' ' + row.source.row + '행') + '"><span class="muted">' + escape(h.name(row.agency_id)) + '</span><strong>' + money(Number(row.rebate_amount_krw)) + '</strong></div>').join('') + '</div></section>' : '') +
    (entry.exceedsLimit && team ? '<section class="card line" style="justify-content:space-between;flex-wrap:wrap;background:#fff7e6;border-color:#f3dfb2"><span>임원 승인 대상이었지만 거래처별 팀 승인으로 지급됐어요</span>' +
      (nextOpen ? '<a class="link" href="/?' + escape(new URLSearchParams({ period: nextOpen, view: 'post-audit', audit: entry.group.groupId }).toString()) + '">지난 지급 점검</a>' : '') + '</section>' : '');
}

export function followupList(c, h) {
  const tab = c.query.get('tab') === 'done' ? 'done' : 'open';
  const open = c.list.filter(entry => onHold(c.stateFor(entry)));
  const done = c.list.filter(entry => !onHold(c.stateFor(entry)) && c.eventsFor(entry.group.groupId).some(event => event.action === 'send'));
  const stage = { draft: ['red', '요청 작성'], waiting: ['amber', '답변 대기'], received: ['blue', '답변 검토'], verified: ['amber', '다시 올리기'] };
  const rows = (tab === 'open' ? open : done).map(entry => lrow(c.link({ view: tab === 'open' ? 'followup' : 'requests', group: entry.group.groupId }), h.title(entry), '',
    (tab === 'open' ? pill(...stage[c.stateFor(entry)]) + dday(dueOf(c, entry), c.businessDate) : h.statusPill(entry))));
  return '<div><h1>거래처 확인</h1></div>' +
    '<div class="tabs"><a class="btn tab" href="' + c.link({ view: 'followup', tab: 'open' }) + '"' + (tab === 'open' ? ' aria-current="page"' : '') + '>진행 중 ' + open.length + '</a>' +
    '<a class="btn tab" href="' + c.link({ view: 'followup', tab: 'done' }) + '"' + (tab === 'done' ? ' aria-current="page"' : '') + '>완료 ' + done.length + '</a></div>' +
    listCard(rows, tab === 'open' ? '진행 중인 거래처 확인이 없어요. 임원이 거절하거나 추가 확인을 요청하면 여기에 생겨요.' : '완료한 거래처 확인이 없어요');
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
  const who = itemId => (itemId === 'sameRep' && reps.length ? reps : entry.group.members.map(member => member.agencyId)).map(agencyId => h.name(agencyId)).join(', ');
  const regen = h.regen({ view: 'followup', group: id }, 'ai_items', '#items');
  const checked = itemId => proposal?.result ? proposedIds.includes(itemId) : ['sharedAccount', 'payee', 'sameRep'].includes(itemId);

  const items = Object.entries(c.activeItems).filter(([itemId]) => basis[itemId]).sort(([a], [b]) =>
    (proposedIds.includes(a) ? proposedIds.indexOf(a) : 9) - (proposedIds.includes(b) ? proposedIds.indexOf(b) : 9));
  return '<div><p class="crumb"><a href="' + c.link({ view: 'followup' }) + '">거래처 확인</a> › ' + escape(h.title(entry)) + '</p><h1>확인 요청 작성</h1></div>' +
    (reason ? '<section class="card"><div class="hd"><h2>임원 의견</h2><span class="r">' + escape(c.decisionDate(entry)) + '</span></div><p style="font-size:14px">' + escape(reason) + '</p></section>' : '') +
    (c.open && !proposal ? h.post({ view: 'followup', group: id }, '<button name="action" value="ai_items">AI 항목 제안</button>', ' hidden data-ai data-auto data-target="#items"') : '') +
    (c.open && proposal?.finished_at ? regen.form : '') +
    h.post({ view: 'followup', group: id }, h.revision(entry) +
      '<section class="card" id="items" style="padding-bottom:12px"><div class="hd"><h2>물어볼 항목</h2>' +
      '<span class="r"><span data-ai-status>' + (proposal?.result ? 'AI 제안, 바꿔도 돼요' : proposal?.finished_at ? 'AI 제안을 못 받아 기본 항목을 골라 두었어요'
        : proposal ? 'AI가 고르는 중이에요' : '기본 항목을 골라 두었어요') + '</span>' + (proposal?.finished_at ? regen.button : '') + '</span></div>' +
      items.map(([itemId, row]) => {
        const quote = proposed.find(entry => entry.id === itemId)?.quote;
        return '<label class="check"><input type="checkbox" name="item" value="' + escape(itemId) + '"' + (checked(itemId) ? ' checked' : '') + '><span style="flex:1"><strong style="font-weight:600">' +
          escape(row.label) + '</strong>' + (proposedIds.includes(itemId) ? ' <span class="ai-b" style="margin-left:6px">AI</span>' : '') +
          '<span class="kv" style="grid-template-columns:80px 1fr;margin-top:6px;font-size:13px"><span>받을 곳</span><span style="text-align:left">' + escape(who(itemId)) + '</span>' +
          '<span>답변 방식</span><span style="text-align:left">' + escape(formatHints[row.format] ?? '글로 답변') + (row.attachment ? ', ' + escape(row.attachment) + ' 첨부' : '') + '</span></span>' +
          '<span class="muted" style="display:block;margin-top:4px">' + escape(basis[itemId]) + '</span></span></label>';
      }).join('') +
      (proposal?.result?.newItem ? '<p class="ai-note"><span class="ai-b">AI</span>목록에 없는 항목도 제안했어요: ' + escape(proposal.result.newItem) + '. 관리자가 승인하면 목록에 생겨요.</p>' : '') +
      '<label class="field" style="margin-top:12px">+ 직접 추가할 항목 (선택) <input name="customItem" maxlength="60" placeholder="예: 공동 납품 계약 여부"></label></section>' +
      '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><label class="field" style="flex:0 1 220px">답변 기한 <input type="date" name="dueDate" value="' +
      addBusinessDays(c.businessDate, 5) + '" required></label><p class="muted" style="flex:1 1 240px">거래처마다 자기 항목만 보여요. 다른 거래처 금액이나 임원 의견은 보이지 않아요.</p></div>' +
      '<label class="field" style="margin-top:12px">함께 보낼 말 (선택) <textarea name="reason" maxlength="600" placeholder="예: 지급 전에 확인이 필요합니다."></textarea></label>' +
      '<div style="margin-top:12px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:flex-end;margin-top:12px"><button class="primary" name="action" value="send">' + escape(entry.group.members.map(member => h.name(member.agencyId)).join(', ')) + '에 요청 보내기</button></div></section>');
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
  const tones = { met: ['#e6f4ea', '#1e6b34'], partial: ['#fff1d6', '#7a3f00'], missing: ['#fde8e8', '#a12a2a'], none: ['#eef2f7', '#526074'] };
  const verdictTone = { met: 'green', partial: 'amber', missing: 'red' };
  const resendPreview = result ? resendItems(items, merged, result.items) : [];
  const editing = c.open && c.role === '영업지원팀' && state === 'received';
  const regen = h.regen({ view: 'followup', group: id }, 'ai_reply', '#review', '다시 판정');
  const rows = items.map(row => {
    const verdict = result?.items.find(entry => entry.id === row.id);
    const marks = itemMarks(row, merged, verdict?.verdict);
    const preset = resendPreview.find(entry => entry.id === row.id)?.recipients ?? [];
    const answerLine = mark => !mark.answer ? '<span class="muted">' + (merged[mark.agency] ? '이 항목은 답하지 않았어요' : '아직 답변 없음') + '</span>'
      : [mark.answer.yesno, mark.answer.text, mark.answer.account && '계좌 ' + mask(mark.answer.account) + (mark.answer.holder ? ', 예금주 ' + escape(mark.answer.holder) : ''),
        mark.answer.attachment && '첨부 ' + escape(mark.answer.attachment)].filter(Boolean).map(value => value.startsWith('계좌 ') ? value : escape(value)).join(', ');
    return '<div class="item-block"><div class="row" style="border:0;padding:0;align-items:center;flex-wrap:wrap"><strong style="font-weight:600">' + escape(row.label) + '</strong>' +
      '<span class="line" style="gap:6px;flex-wrap:wrap">' + marks.map(mark => '<span class="dot" title="' + escape(h.name(mark.agency)) + '" style="background:' + tones[mark.status][0] + ';color:' + tones[mark.status][1] +
        ';width:auto;padding:0 8px;border-radius:6px">' + escape(h.name(mark.agency)) + '</span>').join('') +
      (verdict ? pill(verdictTone[verdict.verdict], escape(verdictLabels[verdict.verdict])) : '') + '</span></div>' +
      (verdict?.note && verdict.verdict !== 'met' ? '<p class="ai-note"><span class="ai-b">AI</span>' + escape(verdict.note.replace(/D-\d{3}/g, agencyId => h.name(agencyId))) + '</p>' : '') +
      '<details style="margin-top:6px"><summary>답변 펼치기</summary><div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;font-size:14px">' +
        marks.map(mark => '<p><strong>' + escape(h.name(mark.agency)) + '</strong> ' + answerLine(mark) + '</p>').join('') + '</div></details>' +
      (editing ? '<div class="line" style="gap:14px;margin-top:8px;flex-wrap:wrap"><span class="muted">보완 요청 대상</span>' + row.recipients.map(agencyId =>
        '<label class="line" style="gap:6px;font-size:13px"><input type="checkbox" form="resend-form" name="target" value="' + escape(row.id + ':' + agencyId) + '"' +
        (preset.includes(agencyId) ? ' checked' : '') + '>' + escape(h.name(agencyId)) + '</label>').join('') + '</div>' : '') + '</div>';
  }).join('');
  const targets = entry.group.members.map(member => member.agencyId).filter(agencyId => resendPreview.some(row => row.recipients.includes(agencyId)));
  const actions = !editing ? (c.open && c.role === '영업지원팀' && state === 'verified' ? h.post({ view: 'followup', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<section class="card line" style="justify-content:space-between">확인이 끝났어요<button class="primary" name="action" value="resubmit">임원에게 다시 올리기</button></section>') : '')
    : h.post({ view: 'followup', group: id }, h.revision(entry) + '<input type="hidden" name="picked" value="1">' +
      '<section class="card"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><span>' + (targets.length ? '보완 요청 <strong>' + targets.map(h.name).map(escape).join(', ') + '</strong>' +
        '<br><span class="muted">' + resendPreview.map(row => escape(row.label)).join(', ') + '</span>' : '모든 항목이 충족됐어요') + '</span>' +
      '<span class="line" style="flex-wrap:wrap"><button name="action" value="verify">임원에게 올리기</button><input type="hidden" name="resubmit" value="1">' +
      '<button class="primary" name="action" value="resend">보완 요청 보내기</button></span></div>' +
      '<details style="margin-top:10px"><summary>메모와 업무일</summary><label class="field" style="margin-top:8px">메모 (선택)<textarea name="reason" maxlength="1000" placeholder="보완 요청에 함께 보낼 말이나, 확인 완료 근거"></textarea></label>' +
      '<div style="margin-top:8px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div></details></section>', ' id="resend-form"');
  const aiState = result ? '<span class="ai-b">AI</span>판정 ' + escape(check.created_at ? c.businessDate : '') : check?.finished_at ? 'AI 판정을 못 했어요. 직접 확인해 주세요' : check ? 'AI가 판정하는 중이에요' : state === 'waiting' ? '' : 'AI 판정 준비 중';
  return '<div><p class="crumb"><a href="' + c.link({ view: 'followup' }) + '">거래처 확인</a> › ' + escape(h.title(entry)) + '</p>' +
    '<div class="top" style="align-items:center"><h1>' + (state === 'waiting' ? '답변 대기' : '답변 검토') + '</h1><span class="muted">' + (due ? '기한 ' + escape(due) : '') + '</span></div></div>' +
    (state === 'received' && c.open && !check ? h.post({ view: 'followup', group: id }, '<button name="action" value="ai_reply">AI 판정</button>', ' hidden data-ai data-auto data-target="#review"') : '') +
    (editing && check?.finished_at ? regen.form : '') +
    '<div id="review" style="display:flex;flex-direction:column;gap:16px">' +
    '<section class="card" id="verdicts"><div class="hd"><h2>확인 항목 ' + src('reply', '가상 회신') + '</h2><span class="r"><span data-ai-status>' + aiState + '</span>' + (editing && check?.finished_at ? regen.button : '') + '</span></div>' +
    '<div class="rows">' + rows + '</div></section>' + actions + '</div>' + history(c, entry);
}

/* ---------- 서류·정보 변경 ---------- */

export function documentList(c, h) {
  const tab = ['todo', 'done', 'all'].includes(c.query.get('tab')) ? c.query.get('tab') : 'todo';
  const rows = c.documents.filter(row => tab === 'all' || (tab === 'todo' ? !row.applied : row.applied)).slice().reverse();
  const kind = row => /변경 신청/.test(row.original.split('\n')[0]) ? '등록 정보 변경 신청서' : row.original.split('\n')[0].slice(0, 30);
  return '<div><h1>서류 확인</h1></div>' +
    '<div class="tabs">' + [['todo', '확인 필요', c.documents.filter(row => !row.applied).length], ['done', '완료', c.documents.filter(row => row.applied).length],
      ['all', '전체', c.documents.length]].map(([key, label, count]) => '<a class="btn tab" href="' + c.link({ view: 'documents', tab: key }) + '"' +
      (key === tab ? ' aria-current="page"' : '') + '>' + label + ' ' + count + '</a>').join('') + '</div>' +
    listCard(rows.map(row => lrow(c.link({ view: 'documents', document: row.id }), kind(row), escape(h.name(row.agency_id)),
      (row.applied ? pill('green', '적용') : row.confirmed ? pill('blue', '확인 저장') : pill('amber', '확인 필요')) + escape(row.metadata?.occurredOn ?? (row.received_at ? time(row.received_at) : '')))), '확인할 서류가 없어요');
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
  const kindName = /변경 신청서 \(([^)]+)\)/.exec(doc.original.split('\n')[0])?.[1];
  const kind = kindName ? kindName + ' 변경 신청서' : /변경 신청/.test(doc.original.split('\n')[0]) ? '등록 정보 변경 신청서' : '거래처 서류';
  const regen = h.regen({ view: 'documents', document: doc.id }, 'document_extract', '#compare', '다시 읽기');
  const aiStatus = extract?.result ? '<span class="ai-b">AI</span>읽은 값, 고쳐도 돼요' : extract?.finished_at ? 'AI가 못 읽었어요. 직접 입력해 주세요' : extract ? 'AI가 읽는 중이에요' : '';
  const affected = c.list.find(entry => entry.group.members.some(member => member.agencyId === doc.agency_id));
  return '<div><p class="crumb"><a href="' + c.link({ view: 'documents' }) + '">서류 확인</a> › ' + escape(h.name(doc.agency_id)) + '</p>' +
    '<div class="top" style="align-items:center"><h1>' + kind + '</h1>' +
    (doc.applied ? pill('green', '적용 완료') : doc.confirmed ? pill('blue', '확인 저장') : pill('amber', '확인 필요')) + '</div></div>' +
    (canEdit && !extract ? '<form method="post" action="' + post({}) + '" hidden data-ai data-auto data-target="#compare"><button name="action" value="document_extract">AI 읽기</button></form>' : '') +
    (canEdit && extract?.finished_at ? regen.form : '') +
    '<form method="post" action="' + post({}) + '" id="compare" style="display:flex;flex-direction:column;gap:16px">' +
    '<section class="card"><div class="hd"><h2>등록 정보와 비교 ' + src('reply', '가상 서류') + '</h2><span class="r"><span data-ai-status>' + aiStatus + '</span>' + (canEdit && extract?.finished_at ? regen.button : '') +
      '<a class="link" href="#original" data-expand="original">원본 보기</a></span></div>' +
    '<div id="original" hidden style="margin-bottom:12px"><pre class="doc">' + escape(doc.original) + '</pre><p class="muted" style="margin-top:6px;font-size:12px">' + metadataView(doc.metadata, escape) + '</p></div>' +
    '<div class="row" style="border:0;padding:0 0 6px;color:#526074;font-size:13px"><span style="flex:0 0 80px"></span><span style="flex:1 1 140px">등록</span><span style="flex:1 1 180px">서류</span><span style="flex:0 0 52px"></span></div><div class="rows">' +
    Object.entries(extractFields).map(([key, label]) => {
      const value = cell(key);
      const same = registered && value && value === registered[key];
      return '<div class="row" style="flex-wrap:wrap"><span style="flex:0 0 80px">' + escape(label) + '</span><span class="muted" style="flex:1 1 140px">' +
        escape(key === 'bank_account_no' ? mask(registered?.[key]) : registered?.[key] ?? '') + '</span>' +
        '<input name="' + key + '" value="' + escape(value) + '" maxlength="200" aria-label="' + escape(label) + ' 서류 값" style="flex:1 1 180px;width:auto"' + (canEdit ? '' : ' disabled') + '>' +
        '<input type="hidden" name="' + key + '_decision" value="' + (value ? (extract?.result?.[key]?.candidates?.some(candidate => candidate.value === value) ? 'accept' : 'edit') : 'reject') + '" data-decision="' + decision(key) + '">' +
        '<span style="flex:0 0 52px;text-align:right">' + (value ? (same ? icon('ok') : pill('red', '변경')) : '<span class="muted">없음</span>') + '</span></div>';
    }).join('') + '</div></section>' +
    (changedAccount ? '<section class="card"><div class="hd"><h2>적용하면</h2></div><p>' +
      (affected ? escape(Number(c.period.slice(5)) + '월은 ' + affected.group.members.map(member => h.name(member.agencyId)).join(', ') + '을 그대로 묶어 판단해요. 다음 달부터 새 계좌로 다시 판단해요.') : '다음 달부터 새 계좌로 판단해요.') + '</p>' +
      '<p class="muted" style="margin-top:6px">진행 중인 달에 계좌만 바꿔 한도를 피하지 못하게 하려는 규칙이에요.</p></section>' : '') +
    (canEdit ? '<section class="card"><label class="field">확인 메모 <input name="reason" value="' + escape(doc.confirmed?.reason ?? '') + '" maxlength="1000" required placeholder="예: 대표자 서명 확인"></label>' +
      '<details style="margin-top:10px"><summary>업무일</summary><div style="margin-top:8px">' + recordFields(c.period, doc.metadata, c.businessDate) + '</div></details>' +
      '<div class="line" style="justify-content:flex-end;flex-wrap:wrap;margin-top:12px"><button name="action" value="document_confirm">' + (doc.confirmed ? '다시 저장' : '확인 저장') + '</button>' +
      (doc.confirmed && changedAccount ? '<button class="primary" name="action" value="account_apply">변경 적용</button>' : '') +
      (doc.confirmed && !changedAccount ? '<button name="action" value="group_confirm">관련자 묶음 다시 확인</button>' : '') + '</div></section>' : '') +
    '</form>';
}

export function reviewList(c, h) {
  const approver = row => row.approver === '영업임원' ? '임원 승인' : '팀 승인';
  const describe = rows => rows.map(row => row.members.map(h.name).join(', ') + ' ' + money(row.amount) + ' (' + approver(row) + ')').join(' / ');
  return '<div><h1>정보 변경</h1></div>' +
    (c.reviews.length ? c.reviews.slice().reverse().map(review => {
      const scope = review.details.scope;
      const resolved = c.events.some(event => event.review_id === review.id && event.action === 'review_approve');
      const target = c.list.find(entry => entry.group.members.some(member => scope.agencies.includes(member.agencyId)));
      const [statusColor, statusText] = target ? h.status(target) : ['blue', '재검토 중'];
      const step = (done, text, link) => '<div class="row"><span class="line">' + (done ? icon('ok') : icon('wait')) + '<span>' + text + '</span></span>' + (link ?? '<span class="muted">' + (done ? '완료' : '대기') + '</span>') + '</div>';
      return '<section class="card" id="review-' + escape(review.id) + '"><div class="top" style="align-items:center"><h2>' + escape(h.name(review.agency_id)) + ' ' +
        (review.kind === 'change' ? '정산계좌 변경' : '관련자 묶음 확인') + '</h2>' + pill(statusColor, statusText) + '</div>' +
        '<div class="kv" style="margin-top:12px">' +
        (review.kind === 'change' ? '<span>변경</span><span>' + mask(review.details.beforeAccount) + ' → ' + mask(review.details.afterAccount) + '</span>' : '') +
        '<span>적용 정산월</span><span>' + escape(review.period) + '</span>' +
        '<span>이번 달</span><span>' + (scope.retained.length ? '묶음 그대로, ' + escape(approver(scope.before[0] ?? {})) : '새 정보로 다시 판단') + '</span>' +
        '<span>새 정보로 계산하면</span><span>' + escape(describe(scope.after)) + '</span></div>' +
        (scope.retained.length ? '<p class="muted" style="margin-top:8px">같은 계좌 입금 기록이 있어 이번 달은 묶음을 유지해요. 이미 지급된 관련 건 ' + scope.history.filter(row => row.paid).length + '건은 지난 지급 점검에서 다뤄요.</p>' : '') +
        (target ? '<div class="hd" style="margin-top:16px"><h2 style="font-size:15px">이어서 할 일</h2></div><div class="rows">' +
          step(!onHold(c.stateFor(target)), '거래처 확인은 그대로 진행', '<a class="link" href="' + c.link({ view: 'followup', group: target.group.groupId }) + '">거래처 확인</a>') +
          step(resolved, '영업임원 다시 결정') +
          step(['paymentReady', 'reconciled'].includes(c.stateFor(target)), '회계 조건 다시 확인', '<a class="link" href="' + c.link({ view: 'requests', group: target.group.groupId }) + '">요청 보기</a>') + '</div>' : '') + '</section>';
    }).join('') : '<section class="card"><p class="empty">다시 판단할 요청이 없어요</p></section>');
}

/* ---------- 영업임원 ---------- */

export function execList(c, h) {
  const tab = ['due', 'done', 'all'].includes(c.query.get('tab')) ? c.query.get('tab') : c.query.get('all') === '1' ? 'all' : (c.open ? 'due' : 'all');
  const scope = c.list.filter(entry => entry.exceedsLimit || c.isAffected(entry) || c.precheck.has(entry.group.groupId));
  const due = c.list.filter(entry => c.execDue(entry));
  const done = scope.filter(entry => !c.execDue(entry) && c.saved.has(entry.group.groupId));
  const rows = { due, done, all: scope }[tab];
  const tabs = [...(c.open ? [['due', '결정할 요청', due.length]] : []), ['done', '결정 완료', done.length], ['all', '전체', scope.length]];
  return '<div class="top" style="align-items:center"><h1>' + (c.open ? '결정할 요청' : '임원 승인 기록') + '</h1><span class="muted">' + escape(c.period) + '</span></div>' +
    '<div class="tabs">' + tabs.map(([key, label, count]) => '<a class="btn tab" href="' + c.link({ view: 'requests', tab: key }) + '"' + (key === tab ? ' aria-current="page"' : '') + '>' + label + ' ' + count + '</a>').join('') + '</div>' +
    listCard(rows.map(entry => lrow(c.link({ view: 'requests', group: entry.group.groupId }), h.title(entry), '',
      h.statusPill(entry) + '<span class="amt">' + money(entry.totalKrw) + '</span>')), tab === 'due' ? '지금 결정할 요청이 없어요' : '기록이 없어요');
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
  const answersFor = itemId => Object.entries(merged).filter(([, answer]) => answer.items[itemId]).map(([agencyId, answer]) => {
    const value = answer.items[itemId];
    return '<p><strong>' + escape(h.name(agencyId)) + '</strong> ' + [value.yesno, value.text, value.account && '계좌 ' + mask(value.account), value.holder && '예금주 ' + escape(value.holder),
      value.attachment && '첨부 ' + escape(value.attachment)].filter(Boolean).map(text => text.startsWith('계좌 ') || text.startsWith('예금주 ') ? text : escape(text)).join(', ') + '</p>';
  }).join('');
  const changes = [
    ...(Object.keys(merged).length ? asked.map(row => {
      const verdict = check?.items.find(item => item.id === row.id)?.verdict;
      return [verdict && verdict !== 'met' ? 'warn' : 'ok', escape(row.label) + (verdict && verdict !== 'met' ? ' <span class="muted">' + verdictLabels[verdict] + '</span>' : ''), 'ans-' + row.id, answersFor(row.id) || '<p class="muted">답변 없음</p>'];
    }) : []),
    ...reviewsFor.map(review => ['warn', escape(h.name(review.agency_id)) + (review.kind === 'change' ? ' 정산계좌 변경' : ' 묶음 확인') +
      (review.details.scope.retained.length ? ' <span class="muted">이번 달은 묶음 그대로</span>' : ''), '', '']),
    ...(deposits.length ? [['warn', escape(h.name(deposits[0].agencyId)) + '가 다른 거래처 계좌로 ' + deposits.length + '번 입금', 'dep',
      deposits.map(row => '<p>' + escape(row.depositDate) + ' ' + escape(h.name(row.agencyId)) + ' → ' + mask(row.account) + ' <span class="muted">(' + row.owners.map(owner => escape(h.name(owner))).join(', ') + ' 등록 계좌)</span></p>').join('')]] : []),
    ...(h.pastFor(entry) ? [['warn', '1~5월 한도 초과분이 팀 승인으로 지급됨' + (c.pastConclusion(id) ? ' <span class="muted">결론 ' + postAuditConclusions[c.pastConclusion(id)] + '</span>' : ''),
      'link:' + c.link({ view: 'post-audit', audit: id }), '']] : []),
  ];
  const record = c.saved.get(id);
  const regen = h.regen({ view: 'requests', group: id }, 'ai_conditions', '#decision');
  const decided = c.decisionDate(entry);
  const pairs = entry.group.members.length > 1 ? '<details class="card tight" id="basis"><summary>묶은 근거</summary><div class="rows" style="margin-top:6px">' +
    groupPairs(entry, h).map(([pair, matched, linked]) => '<div class="row"><span' + (linked ? '' : ' class="muted"') + '>' + pair + '</span><span' + (linked ? '' : ' class="muted"') + '>' + matched + '</span></div>').join('') +
    '</div><div class="agencies" style="margin-top:10px">' + entry.rebateRows.map(row => '<div class="agency"><span class="muted">' + escape(h.name(row.agencyId)) + '</span><strong>' + money(row.amountKrw) + '</strong></div>').join('') + '</div></details>' : '';
  return '<div><p class="crumb"><a href="' + c.link({ view: 'requests' }) + '">결정할 요청</a> › ' + escape(c.period) + '</p>' +
    '<div class="top" style="align-items:center"><h1>' + escape(h.title(entry)) + '</h1>' + h.statusPill(entry) + '</div></div>' +
    summaryCard(c, h, entry, { compact: true }) +
    execSummary(c, h, entry) +
    (reject ? '<section class="card"><div class="hd"><h2>지난 결정 의견</h2><span class="r">' + escape(decided) + '</span></div><p style="font-size:14px">' + escape(reject) + '</p></section>' : '') +
    (changes.length ? '<section class="card" style="padding-bottom:8px" id="answers"><div class="hd"><h2>' + (reject ? '지난 결정 이후' : '확인할 점') + '</h2></div><div class="rows">' +
      changes.map(([tone, text, key, detail]) => '<div class="row" style="flex-wrap:wrap"><span class="line">' + icon(tone) + '<span>' + text + '</span></span>' +
        (key.startsWith('link:') ? '<a class="link" href="' + key.slice(5) + '">지난 지급 점검</a>' : key ? '<a class="link" href="#' + key + '" data-expand="' + key + '">펼치기</a>' : '') +
        (key && !key.startsWith('link:') ? '<div id="' + key + '" hidden style="flex-basis:100%;padding:8px 0 0 30px;font-size:14px;display:flex;flex-direction:column;gap:4px">' + detail + '</div>' : '') + '</div>').join('') + '</div></section>' : '') +
    (enabled ? (Object.keys(basis).length && !call ? h.post({ view: 'requests', group: id }, '<button name="action" value="ai_conditions">AI 조건 제안</button>', ' hidden data-ai data-auto data-target="#decision"') : '') +
      (call?.finished_at ? regen.form : '') +
      h.post({ view: 'requests', group: id }, h.revision(entry) + '<section class="card" id="decision" style="border-color:#c9dcf7"><div class="hd"><h2>결정</h2>' +
        '<span class="r"><span data-ai-status>' + (call?.result ? 'AI 제안 조건은 바꿔도 돼요' : call?.finished_at ? 'AI 제안을 못 받았어요. 직접 골라 주세요' : Object.keys(basis).length ? 'AI가 조건을 고르는 중이에요' : '') + '</span>' +
        (call?.finished_at ? regen.button : '') + '</span></div>' +
        '<div class="seg wide-seg" role="radiogroup" aria-label="결정">' + [['approve', '승인'], ['clarify', '추가 확인'], ['reject', '거절']].map(([value, label], index) =>
          '<label><input type="radio" name="decision" value="' + value + '"' + (index ? '' : ' checked') + '><span>' + label + '</span></label>').join('') + '</div>' +
        (Object.keys(basis).length ? '<div data-when="approve" style="margin-top:8px">' +
          Object.entries(basis).map(([conditionId, why]) => '<label class="check" title="' + escape(why) + '"><input type="checkbox" name="condition" value="' + escape(conditionId) + '"' +
            (suggested.includes(conditionId) ? ' checked' : '') + '><span style="flex:1">' + escape(conditionCatalog[conditionId]) + '</span>' +
            (suggested.includes(conditionId) ? '<span class="ai-b">AI</span>' : '') + '</label>').join('') + '</div>' : '') +
        '<textarea name="reason" maxlength="1000" placeholder="의견 (추가 확인, 거절이면 필수)" aria-label="의견" style="margin-top:12px"></textarea>' +
        '<div class="line" style="justify-content:flex-end;margin-top:12px"><button class="primary" name="action" value="decide">결정 저장</button></div></section>')
      : '<section class="card tight"><p class="muted">' + (record ? '이미 결정했어요. 지금 상태: ' + h.status(entry)[1] : '지금은 결정할 차례가 아니에요. 지금 상태: ' + h.status(entry)[1]) + '</p></section>') +
    pairs + history(c, entry);
}

function execSummary(c, h, entry) {
  const id = entry.group.groupId;
  const call = c.summaryCall(entry);
  const facts = c.summaryFacts(entry);
  const regen = h.regen({ view: 'requests', group: id }, 'ai_summary', '#ai-summary', '다시 요약');
  const auto = c.open && !call ? h.post({ view: 'requests', group: id }, '<button name="action" value="ai_summary">AI 요약</button>', ' hidden data-ai data-auto data-target="#ai-summary"') : '';
  const body = call?.result ? '<ol style="margin:0;padding-left:18px;font-size:14px;line-height:1.8">' + call.result.points.map(point => '<li>' + escape(point.text.replace(/D-\d{3}/g, agencyId => h.name(agencyId))) + '</li>').join('') + '</ol>'
    : '<p class="muted" data-ai-status>' + (call?.finished_at ? 'AI 요약을 만들지 못했어요. 아래 근거를 직접 봐 주세요.' : 'AI가 요약하는 중이에요') + '</p>';
  return auto + (call?.finished_at ? regen.form : '') + '<section class="ai-card" id="ai-summary"><div class="hd" style="margin-bottom:8px"><h2 style="font-size:14px"><span class="ai-b">AI</span>검토 요약</h2>' +
    '<span class="r">' + (call?.finished_at ? regen.button : '') + '</span></div>' + body +
    '<details style="margin-top:8px"><summary>근거 보기</summary><ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#35455a">' +
    facts.map(fact => '<li>' + escape(fact.text) + '</li>').join('') + '</ul></details></section>';
}

/* ---------- 회계 ---------- */

export function accountingList(c, h) {
  const tasks = c.list.filter(entry => c.saved.get(entry.group.groupId)?.created_at);
  const conditions = entry => c.saved.get(entry.group.groupId).conditions ?? [];
  const state = entry => c.stateFor(entry);
  const team = tasks.filter(entry => !entry.exceedsLimit && !c.isAffected(entry) && !conditions(entry).length && state(entry) === 'paymentPending');
  const own = tasks.filter(entry => !team.includes(entry) && ['paymentPending', 'repayReady', 'paymentReady', 'paymentReturned'].includes(state(entry)));
  const batched = entry => c.eventsFor(entry.group.groupId).findLast(event => event.action === 'payment')?.metadata?.batch;
  const waitingBatch = own.filter(entry => state(entry) === 'paymentReady' && batched(entry) && !entry.exceedsLimit);
  const single = own.filter(entry => !waitingBatch.includes(entry));
  const done = tasks.filter(entry => state(entry) === 'reconciled' || !c.open);
  const tab = c.query.get('tab') === 'done' || !c.open ? 'done' : 'todo';
  const label = entry => ({ paymentPending: conditions(entry).length ? ['amber', '조건 확인'] : ['blue', '반영 대기'], repayReady: ['blue', '재지급'], paymentReady: ['blue', '은행 회신 대기'], paymentReturned: ['red', '지급 반려'] }[state(entry)] ?? ['gray', '처리 중']);
  const sum = rows => money(rows.reduce((total, entry) => total + entry.totalKrw, 0));
  const todo = [
    ...single.map(entry => lrow(c.link({ view: 'accounting', group: entry.group.groupId }), h.title(entry), '', pill(...label(entry)) + '<span class="amt">' + money(entry.totalKrw) + '</span>')),
    ...(team.length ? ['<div class="lrow"><span class="l"><strong style="font-weight:600">' + Number(c.period.slice(5)) + '월 팀 승인 ' + team.length + '건</strong></span><span class="r">' + pill('gray', '반영 대기') + '<span class="amt">' + sum(team) + '</span>' +
      (c.open ? h.post({ view: 'accounting' }, '<div hidden>' + recordFields(c.period, null, c.businessDate) + '</div><button class="primary small" name="action" value="batch_pay">지급 시스템에 반영</button>') : '') + '</span></div>'] : []),
    ...(waitingBatch.length ? ['<div class="lrow"><span class="l"><strong style="font-weight:600">지급 배치 ' + escape(batched(waitingBatch[0])) + '</strong><small>' + waitingBatch.length + '건, 반려가 있으면 해당 건을 열어 따로 입력</small></span><span class="r">' + pill('blue', '은행 회신 대기') +
      (c.open ? h.post({ view: 'accounting' }, '<div hidden>' + recordFields(c.period, null, c.businessDate) + '</div><button class="small" name="action" value="batch_result_ok">전부 지급됨</button>') : '') + '</span></div>'] : []),
  ];
  return '<div class="top" style="align-items:center"><h1>지급 검토</h1><span class="muted">' + escape(c.period) + '</span></div>' +
    '<div class="tabs">' + (c.open ? '<a class="btn tab" href="' + c.link({ view: 'accounting', tab: 'todo' }) + '"' + (tab === 'todo' ? ' aria-current="page"' : '') + '>할 일 ' + (single.length + (team.length ? 1 : 0) + (waitingBatch.length ? 1 : 0)) + '</a>' : '') +
    '<a class="btn tab" href="' + c.link({ view: 'accounting', tab: 'done' }) + '"' + (tab === 'done' ? ' aria-current="page"' : '') + '>지급 완료 ' + (c.open ? done.length : c.list.length) + '</a></div>' +
    (tab === 'todo' ? listCard(todo, '지금 할 일이 없어요')
      : c.open ? listCard(done.map(entry => lrow(c.link({ view: 'accounting', group: entry.group.groupId }), h.title(entry), '', escape(batched(entry) ?? '') + '<span class="amt">' + money(entry.totalKrw) + '</span>')), '지급을 마친 건이 없어요')
      : listCard(c.list.map(entry => lrow(c.link({ view: 'requests', group: entry.group.groupId }), h.title(entry), '', pill('gray', '지급 완료') + '<span class="amt">' + money(entry.totalKrw) + '</span>')), '이 달 지급 기록이 없어요'));
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
  const statusCell = row => row.status === 'mismatch' ? pill('red', '다름') : row.status === 'resolved' ? pill('gray', '등록 계좌로 지급') : icon('ok');
  const payeeTable = '<div class="hd"><h2>받는 계좌</h2><span class="r">등록 정산계좌로만 지급</span></div>' +
    table(['거래처', '등록 정산계좌', '거래처 답변', ''], (paidPayees ?? payees).map(row => [escape(h.name(row.agencyId)), mask(row.account),
      row.claimed ? (row.status === 'mismatch' ? '<span style="color:#a12a2a">' + mask(row.claimed) + '</span>' : mask(row.claimed)) : '<span class="muted">답변 없음</span>',
      statusCell(row) + (row.decision?.action === 'payee_change_request' ? '<br><span class="muted">변경 요청 ' + escape(row.decision.on ?? '') + '</span>' : '')])) +
    (canPay && !paidPayees ? mismatch.map(row => '<div class="choice-box">' +
      '<p><strong>' + escape(h.name(row.agencyId)) + '</strong> 계좌가 달라요' + (row.decision?.action === 'payee_change_request' ? ' <span class="muted">변경 요청을 보냈어요. 거래처가 변경 신청을 하면 서류 확인에서 적용돼요.</span>' : '') + '</p>' +
      h.post({ view: 'accounting', group: id }, h.revision(entry) + '<input type="hidden" name="agencyId" value="' + escape(row.agencyId) + '"><div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
        '<div class="line" style="flex-wrap:wrap;margin-top:8px"><input name="reason" maxlength="300" placeholder="등록 계좌로 지급하는 이유" aria-label="등록 계좌로 지급하는 이유" style="flex:1 1 220px;width:auto">' +
        '<button name="action" value="payee_resolve">등록 계좌로 지급</button>' +
        (row.decision?.action === 'payee_change_request' ? '' : '<button class="primary" name="action" value="payee_change_request" formnovalidate>변경 요청 보내기</button>') + '</div>') + '</div>').join('') : '');
  const methods = ['원본 우편 수령', '방문 확인', '국세청 사업자 상태 조회', '은행 예금주 조회', '서류 사본 대조'];
  const decidedOn = record.snapshot?.occurredOn ?? '';
  const statusPill = state !== 'paymentPending' ? h.statusPill(entry) : left.length || mismatch.length ? pill('amber', '지급 보류') : pill('blue', '지급 가능');
  const conditionRow = conditionId => {
    const done = confirmed.get(conditionId);
    const formId = 'check-' + conditionId;
    const editable = !done && c.open && state === 'paymentPending';
    return '<div class="row" style="flex-wrap:wrap"><span class="line">' + (done ? icon('ok') : icon('wait')) + '<span>' + escape(conditionCatalog[conditionId] ?? conditionId) +
      (done ? '<br><span class="muted">' + escape(done.metadata?.evidence?.reference ?? '') + ', ' + escape(done.reason) + '</span>' : '') + '</span></span>' +
      (done ? '<span class="muted">' + escape(done.metadata?.occurredOn ?? time(done.acted_at)) + '</span>'
        : editable ? '<button type="button" class="small" data-expand="' + formId + '">확인 입력</button>' : '<span class="muted">확인 전</span>') +
      (editable ? '<div id="' + formId + '" hidden style="flex-basis:100%;padding:8px 0 0 30px">' + h.post({ view: 'accounting', group: id }, h.revision(entry) +
        '<input type="hidden" name="condition" value="' + escape(conditionId) + '"><div class="line" style="flex-wrap:wrap"><select name="evidenceReference" aria-label="확인 방법" style="flex:1 1 170px;width:auto">' +
        methods.map(method => '<option>' + method + '</option>').join('') + '</select><input name="evidenceFinding" maxlength="1000" required placeholder="확인 결과 (예: 원본과 사본 일치)" aria-label="확인 결과" style="flex:2 1 220px;width:auto">' +
        '<button class="primary" name="action" value="condition_check">확인함</button></div><div style="margin-top:6px">' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>') + '</div>' : '') + '</div>';
  };
  const blocked = left.length || mismatch.length;
  return '<div><p class="crumb"><a href="' + c.link({ view: 'accounting' }) + '">지급 검토</a> › ' + escape(c.period) + '</p>' +
    '<div class="top" style="align-items:center"><h1>' + escape(h.title(entry)) + '</h1>' + statusPill + '</div></div>' +
    '<section class="card"><div class="kv" style="font-size:15px">' + (entry.group.members.length > 1 ? '<span>묶인 거래처</span><span>' + entry.group.members.map(member => escape(h.name(member.agencyId))).join(', ') + '</span>' : '') +
    '<span>' + Number(c.period.slice(5)) + '월 합계</span><strong style="font-size:22px">' + money(entry.totalKrw) + '</strong>' +
    '<span>승인</span><span>' + escape(record.role) + (decidedOn ? ' ' + escape(decidedOn) : '') + '</span></div></section>' +
    (ids.length ? '<section class="card" style="padding-bottom:8px"><div class="hd"><h2>승인 조건</h2><span class="r">' + (ids.length - left.length) + ' / ' + ids.length + ' 확인</span></div>' +
      '<div class="rows">' + ids.map(conditionRow).join('') + '</div></section>' : '') +
    '<section class="card">' + payeeTable + '</section>' +
    '<section class="card line" style="justify-content:space-between;flex-wrap:wrap' + (!blocked && !paid ? ';border-color:#c9dcf7' : '') + '"><div><h2>지급 반영</h2><p class="muted" style="font-size:14px;margin-top:2px">' +
    (paid ? escape(events.findLast(event => event.action === 'payment')?.metadata?.evidence?.reference ?? '') + '. 지급 전에 계좌가 바뀌면 자동으로 보류돼요.'
      : left.length ? '남은 조건: ' + left.map(conditionId => escape(conditionCatalog[conditionId] ?? conditionId)).join(', ') : mismatch.length ? '받는 계좌를 먼저 정해 주세요.' : '반영하면 지급 목록에 올라가요 (모의).') + '</p></div>' +
    (canPay ? h.post({ view: 'accounting', group: id }, h.revision(entry) + '<div hidden>' + recordFields(c.period, c.previousMetadata(entry), c.businessDate) + '</div>' +
      '<button class="' + (blocked ? '' : 'primary') + '" name="action" value="payment"' + (blocked ? ' disabled' : '') + '>' + (state === 'repayReady' ? '반려분 다시 지급' : '지급 시스템에 반영') + '</button>') : '') + '</section>' +
    bankSection(c, h, entry, state, events) +
    (record.snapshot ? '<details class="card tight"><summary>승인 당시 기록</summary>' +
      table(['거래처', '장려금'], record.snapshot.members.map(row => ['<span title="원본 ' + escape(row.source) + '">' + escape(h.name(row.agencyId)) + '</span>', money(row.amountKrw)]), { numeric: [1] }) +
      '<p class="muted" style="font-size:12px">' + escape(record.role) + ' 승인 시점에 저장한 묶음 구성과 합산액이에요. 나중에 등록 정보가 바뀌어도 이 기록은 그대로예요.</p></details>' : '') +
    history(c, entry);
}

function bankSection(c, h, entry, state, events) {
  const id = entry.group.groupId;
  const results = ['payment_ok', 'payment_returned'].map(action => events.filter(event => event.action === action)).flat()
    .sort((a, b) => new Date(a.acted_at) - new Date(b.acted_at));
  const repayFor = event => events.filter(row => row.action === 'payment' && Number(row.id) < Number(event.id)).at(-1)?.metadata?.repay;
  const log = results.length ? table(['회신', '거래처별 결과'], results.map(event => [escape(event.metadata?.occurredOn ?? time(event.acted_at)) +
    (repayFor(event) ? '<br><span class="muted">재지급</span>' : ''),
    Object.entries(event.metadata?.results ?? {}).filter(([agencyId]) => !repayFor(event) || repayFor(event).includes(agencyId)).map(([agencyId, row]) => escape(h.name(agencyId)) + ' ' + (row.result === 'success' ? icon('ok') + ' 지급' : icon('no') + ' 반려, ' + escape(row.reason) +
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
          '<select name="why_' + escape(agencyId) + '" aria-label="반려 사유" style="width:auto"><option value="">반려 사유</option><option value="holder">예금주 불일치</option><option value="closed">계좌 해지 또는 없음</option><option value="other">기타</option></select>' +
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
    '<a href="' + c.link({ view: 'post-audit', audit: row.groupId }) + '"><strong>' + escape(h.name(row.groupId)) + '</strong></a>',
    Number(row.months[0].period.slice(5)) + '~' + Number(row.months.at(-1).period.slice(5)) + '월', money(row.totalKrw),
    row.conclusion ? pill(conclusionTone[row.conclusion], postAuditConclusions[row.conclusion]) : pill('amber', '결론 대기')]), { numeric: [2] }) + '</section>';
  const cause = postAuditCause(selected, c.data, selected.masterCheck);
  const canDecide = c.role === '회계' && c.open && !selected.conclusion;
  const first = Number(selected.months[0].period.slice(5));
  const last = Number(selected.months.at(-1).period.slice(5));
  const names = selected.members.map(id => escape(h.name(id))).join(', ');
  return '<div><p class="crumb"><a href="' + c.link({ view: 'post-audit', audit: '' }) + '">지난 지급 점검</a></p><div class="top" style="align-items:center"><h1>' +
    escape(h.name(selected.groupId)) + ', ' + first + '~' + last + '월 지급</h1>' +
    (selected.conclusion ? pill(conclusionTone[selected.conclusion], postAuditConclusions[selected.conclusion]) : pill('amber', '결론 대기')) + '</div></div>' +
    '<section class="card"><p style="font-size:16px;font-weight:600">임원 승인 대상이 팀 승인으로 지급됐어요</p>' +
    '<p class="muted" style="font-size:14px;margin-top:4px">' + selected.rowCount + '건, ' + money(selected.totalKrw) + '. 이미 지급된 돈이라 기록과 후속 조치만 정해요.</p>' +
    '<div class="kv" style="margin-top:12px"><span>묶인 거래처</span><span>' + names + '</span></div></section>' +
    '<section class="card"><div class="hd"><h2>월별 지급 ' + src('raw', '원본') + '</h2><span class="r">매달 영업지원팀 승인</span></div>' +
    table(['정산월', '합계', '지급일'], selected.months.map(month => ['<span title="원본 ' + escape(month.sources.map(src => src.file + ' ' + src.row + '행').join(', ')) + '">' + escape(month.period) + '</span>',
      money(month.paidKrw), escape(month.paymentDates.join(', '))]), { numeric: [1] }) + '</section>' +
    '<section class="card"><div class="hd"><h2>승인 당시 등록 정보</h2><span class="r">' + escape(selected.masterCheckOn ?? '') + '</span></div>' +
    (selected.masterCheck ? '<div class="kv"><span>확인 결과</span><strong>' + escape(masterCheckResults[selected.masterCheck]) + '</strong><span>근거</span><span>' + escape(selected.masterCheckNote) + '</span></div>'
      : '<p class="muted">아직 확인하지 않았어요. 원본에는 마스터 변경 시점이 없어 당시 기록(품의서 등)으로 확인해야 해요.</p>') +
    '<p class="note' + (cause.confirmed ? '' : ' warn') + '">' + (cause.confirmed ? '' : '추정: ') + escape(cause.text) + '</p>' +
    (!selected.masterCheck && canDecide ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
      '<div class="seg wide-seg" role="radiogroup" aria-label="확인 결과" style="margin-top:12px">' + Object.entries(masterCheckResults).map(([value, label], index) =>
        '<label><input type="radio" name="masterCheck" value="' + value + '"' + (index === 2 ? ' checked' : '') + '><span>' + label + '</span></label>').join('') + '</div>' +
      '<div class="line" style="flex-wrap:wrap;margin-top:8px"><input name="reason" maxlength="1000" required placeholder="확인 근거 (예: 2026-02 지급 품의서의 등록 정보)" aria-label="확인 근거" style="flex:1 1 260px;width:auto">' +
      '<button class="small" name="action" value="audit_master_check">확인 저장</button></div><div hidden>' + recordFields(c.period, null, c.businessDate) + '</div>') : '') + '</section>' +
    (selected.conclusion ? '<section class="card"><div class="hd"><h2>결론</h2><span class="r">' + escape(selected.doneOn || time(selected.doneAt)) + '</span></div><p><strong>' + escape(postAuditConclusions[selected.conclusion]) + '</strong></p>' +
      '<p class="muted" style="margin-top:4px">' + escape(selected.opinion) + '</p>' +
      (selected.concludedUnverified ? '<p class="note warn">' + icon('warn') + ' 승인 당시 등록 정보를 확인하지 않은 상태에서 낸 결론이에요.</p>' : '') +
      (selected.conclusion === 'audit_report' ? '<p class="note">다음 승인 때 임원에게 "3개월 사전 확인" 조건이 제안돼요.</p>' : '') +
      (selected.conclusion === 'recovery' ? (selected.recoveryDone ? '<p class="note">' + icon('ok') + ' 영업지원팀 회수 확인: ' + escape(selected.recoveryDone.reason) + '</p>'
        : c.role === '영업지원팀' && c.open ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
          '<label class="field" style="margin-top:12px">회수 확인 내용 <textarea name="reason" maxlength="1000" required placeholder="거래처와 확인한 회수 방법과 일정"></textarea></label>' +
          '<div style="margin-top:10px"><button class="primary" name="action" value="recovery_done">회수 확인 저장</button></div>') : '<p class="note">' + icon('wait') + ' 영업지원팀이 거래처와 회수를 확인하고 있어요.</p>') : '') + '</section>'
      : canDecide ? h.post({ view: 'post-audit', audit: selected.groupId }, '<input type="hidden" name="auditGroup" value="' + escape(selected.groupId) + '">' +
        '<section class="card"><div class="hd"><h2>결론</h2></div><div class="line" style="flex-wrap:wrap;align-items:stretch">' +
        [['closed', '종결', '이유가 확인돼 기록만 남겨요'], ['audit_report', '감사 보고', '감사 목록에 올리고, 다음 승인 때 임원에게 알려요'], ['recovery', '회수 검토', '영업지원팀에 회수 확인 일을 만들어요']]
          .map(([value, label, sub]) => '<label class="choice"><input type="radio" name="conclusion" value="' + value + '" required><span><strong>' + label + '</strong><br><span class="muted">' + sub + '</span></span></label>').join('') +
        '</div>' + (selected.masterCheck ? '' : '<p class="note warn">승인 당시 등록 정보를 아직 확인하지 않았어요. 지금 결론을 내면 "미확인 상태 결론"으로 기록돼요.</p>') +
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
  return '<div><h1>' + escape(h.name(c.agency)) + '</h1></div>' +
    open.map(entry => {
      const events = c.eventsFor(entry.group.groupId);
      const asked = requestItems(events, entry.group.groupId).filter(row => row.recipients.includes(c.agency));
      const due = events.findLast(event => ['send', 'resend'].includes(event.action))?.metadata?.dueDate;
      const mine = mergedAnswers(events)[c.agency];
      const resend = events.findLast(event => ['send', 'resend'].includes(event.action))?.action === 'resend';
      return '<section class="card" style="border-color:#c9dcf7"><div class="line" style="justify-content:space-between;flex-wrap:wrap"><span><strong>' + Number(c.period.slice(5)) + '월 장려금 확인 요청</strong>' +
        '<br><span class="muted">' + (resend ? '보완할 질문 ' + asked.length + '개' : mine ? '답변을 보냈어요. 기한 전까지 고칠 수 있어요' : '답변할 질문 ' + asked.length + '개') + '</span></span>' +
        '<span class="line" style="gap:12px">' + dday(due, c.businessDate) + '<a class="btn primary" href="' + c.link({ view: 'agency-replies', group: entry.group.groupId }) + '">' + (mine && !resend ? '답변 고치기' : '답변하기') + '</a></span></div></section>';
    }).join('') +
    '<section class="card"><div class="hd"><h2>장려금 내역</h2></div>' + table(['정산월', '장려금', '상태'], rebates.map(row => {
      const entry = own.find(candidate => candidate.period === row.period_ym);
      const state = entry && row.period_ym === c.period ? c.stateFor(entry) : null;
      return [escape(row.period_ym), money(Number(row.rebate_amount_krw)), /^\d{4}-\d{2}-\d{2}$/.test(row.payment_date) ? '<span class="muted">지급 ' + escape(row.payment_date.slice(5)) + '</span>' :
        state === 'reconciled' ? '지급 완료' : ['paymentReady', 'repayReady'].includes(state) ? pill('blue', '지급 예정') : state === 'paymentReturned' ? pill('red', '지급 반려') : pill('amber', '확인 중')];
    }), { numeric: [1] }) + '</section>' +
    '<section class="card"><div class="hd"><h2>등록 정보</h2><span class="r"><a class="link" href="' + c.link({ view: 'documents' }) + '">변경 신청</a></span></div>' +
    '<div class="kv"><span>대표자</span><span>' + escape(info?.representative_name) + '</span><span>주소</span><span>' + escape(info?.address) + '</span><span>정산계좌</span><span>' + mask(info?.bank_account_no) + '</span></div></section>';
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
    const attach = row.attachment ? '<label class="field">' + escape(row.attachment) + ' <span class="muted" style="font-weight:400">파일 이름</span><input name="att_' + escape(row.id) + '" value="' + value(row.id, 'attachment') +
      '" maxlength="300" placeholder="예: ' + escape(row.attachment.replace(/\s/g, '')) + '_' + escape(c.agency) + '.pdf"></label>' : '';
    if (row.format === 'account') {
      const saved = mine?.items[row.id]?.account ?? '';
      const savedBank = banks.find(bank => saved.startsWith(bank + ' ')) ?? '';
      const savedNumber = savedBank ? saved.slice(savedBank.length + 1) : saved;
      const same = saved && sameAccount(saved, info?.bank_account_no);
      return base + '<div style="display:grid;grid-template-columns:minmax(140px,180px) 1fr 1fr;gap:10px">' +
        '<label class="field">은행<select name="bank_' + escape(row.id) + '" required><option value="">선택</option>' +
        banks.map(bank => '<option' + (bank === savedBank ? ' selected' : '') + '>' + bank + '</option>').join('') + '</select></label>' +
        '<label class="field">계좌번호<input name="acc_' + escape(row.id) + '" value="' + escape(savedNumber) + '" inputmode="numeric" pattern="[0-9-]{10,20}" maxlength="20" placeholder="숫자와 하이픈만" required></label>' +
        '<label class="field">예금주<input name="holder_' + escape(row.id) + '" value="' + value(row.id, 'holder') + '" maxlength="60" required></label></div>' +
        (saved ? '<p class="muted">' + (same ? icon('ok') + ' 등록 정산계좌와 같아요' : icon('warn') + ' 등록 정산계좌(' + mask(info?.bank_account_no) + ')와 달라요. <a href="' + c.link({ view: 'documents' }) + '">정산계좌 변경 신청</a>을 함께 해 주세요.') + '</p>'
          : '<p class="muted">등록 정산계좌 ' + mask(info?.bank_account_no) + '</p>') +
        '<label class="field">설명 (선택)<textarea name="ans_' + escape(row.id) + '" maxlength="600">' + value(row.id, 'text') + '</textarea></label>' + attach + '</div>';
    }
    if (row.format === 'yesno') return base + '<div class="seg wide-seg" style="max-width:260px" role="radiogroup" aria-label="' + escape(row.label) + '">' + ['예', '아니오'].map(option =>
      '<label><input type="radio" name="yn_' + escape(row.id) + '" value="' + option + '"' + (mine?.items[row.id]?.yesno === option ? ' checked' : '') + '><span>' + option + '</span></label>').join('') +
      '</div><label class="field">설명<textarea name="ans_' + escape(row.id) + '" maxlength="600">' + value(row.id, 'text') + '</textarea></label>' + attach + '</div>';
    return base + '<textarea name="ans_' + escape(row.id) + '" maxlength="600" aria-label="' + escape(row.label) + ' 답변">' + value(row.id, 'text') + '</textarea>' + attach + '</div>';
  };
  return '<div><p class="crumb"><a href="' + c.link({ view: 'agency-replies', group: '' }) + '">홈</a> › 확인 요청</p>' +
    '<div class="top" style="align-items:center"><h1>' + Number(c.period.slice(5)) + '월 장려금 확인 요청</h1><span class="muted">' + (request?.metadata?.dueDate ? '기한 ' + escape(request.metadata.dueDate) : '') + '</span></div></div>' +
    (request?.action === 'resend' ? '<section class="card tight warn"><strong>보완이 필요해요: ' + asked.map(row => escape(row.label)).join(', ') + '</strong><p class="muted" style="margin-top:4px">' +
      escape(request.reason.split('\n').filter(line => !/^D-\d+(: | · )/.test(line) || line.startsWith(c.agency + ': ') || line.startsWith(c.agency + ' · ')).map(line => line.replace(/^D-\d+(: | · )/, '')).join(' ')) + '</p></section>' : '') +
    (previousItems.length ? '<section class="card tight"><div class="rows">' + previousItems.map(row => '<div class="row"><span class="line">' + icon('ok') + escape(row.label) +
      '</span><span class="muted">확인 완료</span></div>').join('') + '</div></section>' : '') +
    (editable ? h.post({ view: 'agency-replies', group: id }, asked.map(field).join('') + '<div style="display:none">' + recordFields(c.period, null, c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><span class="muted">준비된 질문만 먼저 보내도 돼요. 기한 전까지 고칠 수 있어요.</span>' +
      '<button class="primary" name="action" value="reply">' + (mine ? '답변 다시 보내기' : '답변 보내기') + '</button></div>')
      : '<section class="card"><p class="empty">영업지원팀이 확인 중이라 지금은 답변할 수 없어요</p></section>');
}

export function dealerDocs(c, h) {
  const docs = c.documents.slice().reverse();
  const info = c.currentAgency(c.agency);
  const reviewOf = doc => c.reviews.find(review => review.document_id === doc.id);
  const kinds = { account: '정산계좌', address: '사업장 주소', representative: '대표자' };
  const docStatus = doc => reviewOf(doc) || doc.applied ? pill('green', '반영') : doc.confirmed ? pill('blue', '확인 완료') : pill('gray', '확인 중');
  const attached = c.list.flatMap(entry => {
    const events = c.eventsFor(entry.group.groupId);
    const mine = mergedAnswers(events)[c.agency];
    if (!mine) return [];
    const items = allRequestedItems(events, entry.group.groupId);
    return Object.entries(mine.items).filter(([, answer]) => answer.attachment).map(([itemId, answer]) =>
      [answer.attachment, Number(entry.period.slice(5)) + '월 확인 요청: ' + (items.find(row => row.id === itemId)?.label ?? itemId), mine.on ?? '']);
  });
  const kind = doc => /변경 신청서 \(([^)]+)\)/.exec(doc.original.split('\n')[0])?.[1];
  const rows = [
    ...docs.map(doc => '<div class="lrow"><span class="l"><strong style="font-weight:600">' + escape(kind(doc) ? kind(doc) + ' 변경 신청' : doc.original.split('\n')[0].slice(0, 40)) + '</strong>' +
      '<small>등록 정보 변경 신청</small></span><span class="r">' + docStatus(doc) + escape(doc.metadata?.occurredOn ?? (doc.received_at ? time(doc.received_at) : '')) + '</span></div>'),
    ...attached.map(([file, label, on]) => '<div class="lrow"><span class="l"><strong style="font-weight:600">' + escape(file) + '</strong><small>' + escape(label) + '</small></span><span class="r">' + escape(on) + '</span></div>'),
  ];
  return '<div><h1>서류</h1></div>' +
    '<section class="card" style="padding-bottom:6px"><div class="hd"><h2>제출 내역</h2></div>' + (rows.length ? rows.join('') : '<p class="empty">보낸 서류가 없어요</p>') + '</section>' +
    (c.open ? h.post({ view: 'documents' }, '<input type="hidden" name="agency" value="' + escape(c.agency) + '"><section class="card" style="display:flex;flex-direction:column;gap:12px">' +
      '<div class="hd" style="margin:0"><h2>등록 정보 변경 신청</h2></div>' +
      '<div class="seg wide-seg" role="radiogroup" aria-label="바꿀 정보" style="max-width:460px">' + Object.entries(kinds).map(([value, label], index) =>
        '<label><input type="radio" name="kind" value="' + value + '"' + (index ? '' : ' checked') + ' data-kind><span>' + label + '</span></label>').join('') + '</div>' +
      '<div data-when-kind="account" style="display:grid;grid-template-columns:minmax(140px,180px) 1fr 1fr;gap:10px">' +
        '<label class="field">은행<select name="bank_new"><option value="">선택</option>' + banks.map(bank => '<option>' + bank + '</option>').join('') + '</select></label>' +
        '<label class="field">계좌번호<input name="acc_new" inputmode="numeric" pattern="[0-9-]{10,20}" maxlength="20" placeholder="숫자와 하이픈만"></label>' +
        '<label class="field">예금주<input name="holder_new" maxlength="60"></label></div>' +
      '<label class="field" data-when-kind="other" hidden>바꿀 내용<input name="newValue" maxlength="200"></label>' +
      '<p class="muted">지금 등록: 정산계좌 ' + mask(info?.bank_account_no) + ', 대표자 ' + escape(info?.representative_name) + ', 주소 ' + escape(info?.address) + '</p>' +
      '<label class="field">변경 사유<input name="why" maxlength="300" required placeholder="예: 장려금 계좌를 거래처별로 분리"></label>' +
      '<label class="field">첨부한 서류 <span class="muted" style="font-weight:400">파일 이름, 대표자 서명이나 직인 필요</span><input name="attachment" maxlength="200" placeholder="예: 계좌변경신청서.pdf"></label>' +
      '<div style="display:none">' + recordFields(c.period, null, c.businessDate) + '</div>' +
      '<div class="line" style="justify-content:space-between;flex-wrap:wrap"><span class="muted">영업지원팀 확인 뒤 반영돼요. 진행 중인 장려금 검토에 영향을 줄 수 있어요.</span><button class="primary" name="action" value="document_add">변경 신청</button></div></section>') : '');
}

/* ---------- 관리자 ---------- */

export function aiError(message = '') {
  if (/timeout|abort/i.test(message)) return 'AI 응답이 늦어 멈췄어요';
  if (/503|unavailable|overloaded/i.test(message)) return 'AI 서버가 잠시 바빴어요';
  if (/429/.test(message)) return 'AI 사용량 한도에 걸렸어요';
  if (/key|401|403|permission/i.test(message)) return 'AI 연결 설정을 확인해야 해요';
  return 'AI 답을 검증하지 못했어요';
}

export function aiLog(c, h) {
  const purposes = { items: '확인 항목 제안', reply_check: '답변 판정', extract: '서류 읽기', conditions: '승인 조건 제안', review_summary: '임원 검토 요약', anomaly_note: '확인 권장 설명', draft: '요청서 초안' };
  const legacy = { summary: '근거 요약 (이전 기능)' };
  const filter = Object.hasOwn(purposes, c.query.get('kind')) ? c.query.get('kind') : '';
  const calls = c.calls.filter(call => !filter || call.kind === filter).slice().reverse();
  const outcome = call => {
    if (call.archived_at) return ['wait', '초기화 전 기록'];
    if (!call.finished_at) return ['wait', '결정 전'];
    if (!call.result) return ['no', '실패, 사람이 직접'];
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
    if (['review_summary', 'anomaly_note'].includes(call.kind)) return ['ok', '참고 표시'];
    return ['wait', '이전 기능 기록'];
  };
  const summary = call => {
    const r = call.result;
    if (!r) return '<span class="muted">' + escape(call.raw?.error ? aiError(call.raw.error) : (call.finished_at ? '응답 없음' : '처리 중')) + '</span>';
    if (call.kind === 'items') return r.items.map(row => escape(c.catalogLabel(row.id))).join(', ') + (r.newItem ? ', 새 항목 "' + escape(r.newItem) + '"' : '');
    if (call.kind === 'reply_check') return ['met', 'partial', 'missing'].map(verdict => verdictLabels[verdict] + ' ' + r.items.filter(row => row.verdict === verdict).length).join(', ');
    if (call.kind === 'conditions') return r.conditions.map(id => escape(conditionCatalog[id] ?? id)).join(', ');
    if (r.points) return r.points.map(point => escape(point.text)).join('<br>');
    if (call.kind === 'extract') return Object.entries(extractFields).map(([key, label]) => r[key]?.candidates?.[0] ? label + ' ' + escape(key === 'bank_account_no' ? '••' + r[key].candidates[0].value.slice(-4) : r[key].candidates[0].value) : null).filter(Boolean).join(', ');
    return '완료';
  };
  const tab = ['changed', 'failed'].includes(c.query.get('tab')) ? c.query.get('tab') : 'all';
  const tones = { all: () => true, changed: call => outcome(call)[0] === 'warn', failed: call => outcome(call)[0] === 'no' };
  const shown = calls.filter(tones[tab]);
  const toneOf = { ok: ['green', ''], warn: ['amber', ''], no: ['red', ''], wait: ['gray', ''] };
  const row = call => {
    const [tone, text] = outcome(call);
    const target = call.group_id ? h.name(call.group_id) : call.kind === 'anomaly_note' ? Number(call.period.slice(5)) + '월 팀 승인' : call.document_id ? '서류 ' + call.document_id : '서류 (초기화 전)';
    return '<div class="lrow" style="flex-wrap:wrap"><span class="l"><strong style="font-weight:600">' + escape(purposes[call.kind] ?? legacy[call.kind] ?? call.kind) + '</strong><small>' + escape(target) + '</small></span>' +
      '<span class="r">' + pill(toneOf[tone][0], text) + '<span>' + escape(call.period) + '</span><span>' + time(call.created_at) + '</span><a class="link" href="#call-' + call.id + '" data-expand="call-' + call.id + '">펼치기</a></span>' +
      '<div id="call-' + call.id + '" hidden style="flex-basis:100%;padding-top:8px;font-size:14px"><p>' + summary(call) + (call.raw?.attempts ? ' <span class="muted">(자동 재시도 1회)</span>' : '') + '</p>' +
      '<details style="margin-top:6px"><summary>보낸 내용과 응답 원문</summary><pre class="doc" style="font-size:12px">' + escape(JSON.stringify({ request: call.request, raw: call.raw }, null, 2)) + '</pre></details></div></div>';
  };
  return '<div class="top" style="align-items:center"><h1>AI 사용 기록</h1><span class="muted">전체 기간</span></div>' +
    '<div class="tabs">' + [['all', '전체'], ['changed', '사람이 바꿈'], ['failed', '실패']].map(([key, label]) => '<a class="btn tab" href="' + c.link({ view: 'ai-log', tab: key }) + '"' +
      (key === tab ? ' aria-current="page"' : '') + '>' + label + ' ' + calls.filter(tones[key]).length + '</a>').join('') + '</div>' +
    '<section class="card" style="padding-top:6px;padding-bottom:6px">' + (shown.length ? shown.map(row).join('') : '<p class="empty">AI 호출 기록이 없어요</p>') + '</section>' +
    '<p class="muted">AI 결과는 코드가 허용 목록, 원문 인용, 계산된 사실과 다시 맞춰 본 뒤에만 화면에 써요. 보낸 내용의 계좌번호는 가려서 보여요.</p>';
}

export function catalogAdmin(c, h) {
  const items = Object.entries(c.catalog.items);
  const conditions = Object.entries(c.catalog.conditions);
  const usage = id => c.allEvents.filter(event => event.action === 'send' && event.metadata?.items?.some(row => row.id === id)).length;
  const toggle = (id, status) => h.post({ view: 'catalog' }, '<input type="hidden" name="id" value="' + escape(id) + '"><input type="hidden" name="status" value="' +
    (status === 'active' ? 'disabled' : 'active') + '"><button class="small" name="action" value="catalog_status">' +
    (status === 'active' ? '사용 중지' : status === 'proposed' ? '승인' : '다시 사용') + '</button>');
  const statusPill = status => status === 'active' ? pill('green', '사용') : status === 'proposed' ? pill('amber', 'AI 제안 검토') : pill('gray', '중지');
  const tab = ['conditions', 'disputes', 'reset'].includes(c.query.get('tab')) ? c.query.get('tab') : 'items';
  const disputes = [...new Set(c.allEvents.filter(event => event.action === 'dispute').map(event => event.group_id + '|' + event.period))].map(key => {
    const [groupId, period] = key.split('|');
    const trail = c.allEvents.filter(event => event.group_id === groupId && event.period === period && ['dispute', 'dispute_close'].includes(event.action));
    return { groupId, period, last: trail.at(-1), opened: trail.findLast(event => event.action === 'dispute') };
  });
  const kinds = { not_same: '같은 사람이 아님', changed: '정보가 이미 바뀜', other: '기타' };
  const lineRow = (label, sub, right) => '<div class="lrow"><span class="l"><strong style="font-weight:600">' + label + '</strong>' + (sub ? '<small>' + sub + '</small>' : '') + '</span><span class="r">' + right + '</span></div>';
  const openDisputes = disputes.filter(row => row.last.action === 'dispute').length;
  const tabs = [['items', '확인 항목', items.length], ['conditions', '승인 조건', conditions.length], ['disputes', '묶음 이의 제기', openDisputes], ['reset', '시연 초기화', null]];
  const body = {
    items: () => '<section class="card" style="padding-top:6px">' + items.map(([id, row]) => lineRow(escape(row.label),
        escape(formatHints[row.format] ?? '글로 답변') + (row.attachment ? ', ' + escape(row.attachment) + ' 첨부' : '') + ', 보낸 횟수 ' + usage(id), statusPill(row.status) + toggle(id, row.status))).join('') +
      h.post({ view: 'catalog' }, '<input type="hidden" name="kind" value="item"><div class="line" style="flex-wrap:wrap;margin-top:12px"><input name="label" maxlength="60" required placeholder="새 항목 이름" aria-label="새 항목 이름" style="flex:2 1 200px;width:auto">' +
        '<select name="format" aria-label="답변 형식" style="flex:1 1 120px;width:auto"><option value="text">글로 답변</option><option value="account">은행, 계좌번호, 예금주</option><option value="yesno">예/아니오</option></select>' +
        '<input name="attachment" maxlength="40" placeholder="필수 첨부 (선택)" aria-label="필수 첨부" style="flex:1 1 140px;width:auto"><button name="action" value="catalog_add">항목 추가</button></div>') + '</section>' +
      '<p class="muted">AI는 이 목록에서 먼저 고르고, 없으면 새 항목을 제안해요. 확정은 담당자가 해요. 고친 내용은 다음 요청부터 적용돼요.</p>',
    conditions: () => '<section class="card" style="padding-top:6px">' + conditions.map(([id, row]) => lineRow(escape(row.label), '', statusPill(row.status) + toggle(id, row.status))).join('') + '</section>' +
      '<p class="muted">조건은 묶음 근거에 맞는 것만 임원에게 보여요.</p>',
    disputes: () => '<section class="card" id="disputes" style="padding-top:6px">' + (disputes.length ? disputes.map(row => '<div class="lrow" style="flex-wrap:wrap;align-items:flex-start"><span class="l"><strong style="font-weight:600">' +
      escape(h.name(row.groupId)) + ' 묶음</strong><small>' + escape(row.period) + ', ' + escape(kinds[row.opened.metadata?.kind] ?? '') + ', ' + escape(row.opened.reason) + '</small>' +
      (row.last.action === 'dispute_close' ? '<small>처리: ' + (row.last.metadata?.result === 'fixed' ? '받아들임' : '묶음 유지') + ', ' + escape(row.last.reason) + '</small>' : '') + '</span>' +
      (row.last.action === 'dispute' ? '<form method="post" action="/?' + escape(new URLSearchParams({ period: row.period, view: 'catalog', tab: 'disputes' }).toString()) + '" class="line" style="flex-wrap:wrap;flex:1 1 320px"><input type="hidden" name="disputeGroup" value="' + escape(row.groupId) + '">' +
        '<select name="result" aria-label="처리 결과" style="width:auto"><option value="kept">묶음 유지</option><option value="fixed">받아들임, 원본 수정 요청</option></select><input name="reason" maxlength="1000" required placeholder="검토 의견" aria-label="검토 의견" style="flex:1 1 160px;width:auto">' +
        '<button class="small" name="action" value="dispute_close">처리</button></form>' : '<span class="r">' + pill('gray', '처리 완료') + '</span>') + '</div>').join('')
      : '<p class="empty">이의 제기가 없어요</p>') + '</section><p class="muted">묶음 판정 규칙(대표자, 주소, 계좌 중 2개 일치)은 원본 자료로 계산해요. 받아들여도 원본은 바꾸지 않아요.</p>',
    reset: () => '<section class="card" id="reset"><div class="hd"><h2>시연 초기화</h2><span class="r">' + escape(c.period) + '</span></div><p class="muted">이 정산월의 결정, 요청, 답변, 서류를 지워요. 원본 CSV, 항목 목록, AI 사용 기록은 그대로 남아요.</p>' +
      (c.open ? h.post({ view: 'catalog', tab: 'reset' }, '<div class="line" style="flex-wrap:wrap;margin-top:10px"><input name="confirm" required pattern="' + escape(c.period) + ' 초기화" placeholder="' + escape(c.period) + ' 초기화 라고 입력" aria-label="확인 문구" style="flex:1 1 220px;width:auto">' +
        '<button class="danger" name="action" value="reset">초기화</button></div>') : '<p class="muted">지급이 끝난 달은 초기화할 기록이 없어요.</p>') + '</section>',
  };
  return '<div><h1>확인 항목 목록</h1></div>' +
    '<div class="tabs">' + tabs.map(([key, label, count]) => '<a class="btn tab" href="' + c.link({ view: 'catalog', tab: key }) + '"' + (key === tab ? ' aria-current="page"' : '') + '>' + label + (count === null ? '' : ' ' + count) + '</a>').join('') + '</div>' +
    body[tab]();
}
