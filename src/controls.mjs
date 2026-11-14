// 프로젝트가 정한 통제 규칙: 과거 권한 초과 지급, 소명 답변 확인 항목, 승인 조건 목록.
// 원본 규칙(관련자 판정·합산·한도)은 w07.mjs가 계산하고, 여기서는 그 결과를 업무 판단에 연결한다.

const paidDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');

export function pastExceedances(result, data, period) {
  const rebates = new Map(data.rebates.map(row => [row.rebate_id, row]));
  const groups = new Map();
  for (const request of result.requests) {
    if (request.period >= period || request.period.slice(0, 4) !== period.slice(0, 4) || !request.exceedsLimit) continue;
    const rows = request.rebateRows.map(row => ({ ...row, record: rebates.get(row.rebateId) }))
      .filter(row => paidDate(row.record?.payment_date));
    if (!rows.length || !rows.every(row => row.record.approver === '영업지원팀')) continue;
    const id = request.group.groupId;
    if (!groups.has(id)) {
      groups.set(id, { groupId: id, members: request.group.members.map(member => member.agencyId),
        months: [], rowCount: 0, totalKrw: 0 });
    }
    const group = groups.get(id);
    const paidKrw = rows.reduce((total, row) => total + row.amountKrw, 0);
    group.months.push({ period: request.period, paidKrw, rows: rows.length,
      paymentDates: [...new Set(rows.map(row => row.record.payment_date))].sort(),
      sources: rows.map(row => row.source) });
    group.rowCount += rows.length;
    group.totalKrw += paidKrw;
  }
  return [...groups.values()].map(group => ({ ...group,
    months: group.months.sort((left, right) => left.period.localeCompare(right.period)) }));
}

// 확인 항목 목록 기본값. 관리자가 DB(w07_catalog)에서 추가·중지할 수 있다.
export const itemCatalog = {
  sharedAccount: { label: '공동 입금계좌를 함께 쓴 이유', format: 'text', attachment: '' },
  payee: { label: '장려금 받을 계좌와 예금주', format: 'account', attachment: '통장 사본' },
  sameRep: { label: '대표자가 같은 사람인지', format: 'yesno', attachment: '사업자등록증' },
  sameAddress: { label: '사업장 주소가 같은 이유', format: 'text', attachment: '' },
  relation: { label: '거래처 간 지분·운영 관계', format: 'text', attachment: '' },
};
export const formatLabels = { text: '서술', account: '계좌 입력', yesno: '예/아니오 + 설명' };
// 이전 버전과 호환: 고정 3개 기준(테스트·기존 기록 표시용)
export const replyCriteria = [
  { id: 'history', label: '공동 입금계좌·등록정보 공유 경위' },
  { id: 'payee', label: '거래처별 지급 수취계좌·예금주 명의' },
  { id: 'evidence', label: '요청한 증빙 제출 또는 제출 위치' },
];
export const verdictLabels = { met: '충족', partial: '부분', unclear: '부분', missing: '부족' };
export const recommendationLabels = { verify: '확인 완료', resend: '보완 요청' };

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function sharedEvidence(item) {
  return item.collectionEvidence.filter(entry => new Set(entry.deposits.map(row => row.agencyId)).size > 1);
}

export function itemBasis(item, catalog = itemCatalog) {
  const matched = new Set(item.group.links.flatMap(link => link.matchedFields));
  const pairs = field => item.group.links.filter(link => link.matchedFields.includes(field))
    .map(link => link.agencyIds.join('·')).join(', ');
  const shared = sharedEvidence(item);
  const outside = shared.flatMap(entry => entry.deposits.filter(row =>
    !entry.registered.some(registered => registered.agencyId === row.agencyId)));
  const basis = {};
  const add = (id, text) => { if (catalog[id] && catalog[id].status !== 'disabled') basis[id] = text; };
  if (shared.length) add('sharedAccount', '같은 입금계좌(•••• ' + shared[0].account.slice(-4) + ') 사용' +
    (outside.length ? ' · ' + outside.map(row => row.depositId).join('·') : ''));
  if (shared.length || matched.has('bank_account_no')) add('payee', shared.length ? '공동 입금계좌 정황' : '정산계좌 일치 ' + pairs('bank_account_no'));
  if (matched.has('representative_name')) add('sameRep', '대표자 이름 일치 ' + pairs('representative_name'));
  if (matched.has('address')) add('sameAddress', '주소 일치 ' + pairs('address'));
  if (item.group.members.length > 1) add('relation', '관련자 ' + item.group.members.length + '곳 묶음');
  for (const [id, entry] of Object.entries(catalog)) {
    if (entry.custom && entry.status === 'active') basis[id] = '관리자 추가 항목';
  }
  return basis;
}

export function validateItemProposal(raw, allowed, reason) {
  const entries = Array.isArray(raw?.items) ? raw.items : [];
  const ids = entries.map(entry => entry?.id);
  if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length || !ids.every(id => allowed.includes(id))) {
    throw new Error('허용된 확인 항목 목록에서 1~4개를 골라야 합니다.');
  }
  const text = normalize(reason);
  const items = entries.map(entry => {
    const quote = normalize(entry.quote);
    return { id: entry.id, quote: quote && text.includes(quote) ? quote : null };
  });
  const newItem = normalize(raw?.newItem).slice(0, 60);
  return { items, newItem: newItem || null };
}

export function validateReplyCheck(raw, reply, items = replyCriteria) {
  if (!Array.isArray(raw?.items)) throw new Error('판정 형식이 올바르지 않습니다.');
  const text = normalize(reply);
  const checked = items.map(criterion => {
    const found = raw.items.filter(entry => entry?.id === criterion.id);
    if (found.length !== 1 || !Object.hasOwn(verdictLabels, found[0].verdict)) {
      throw new Error('확인 항목마다 판정이 하나씩 필요합니다.');
    }
    const verdict = found[0].verdict === 'unclear' ? 'partial' : found[0].verdict;
    const quote = normalize(found[0].quote);
    const grounded = quote.length > 0 && text.includes(quote);
    const note = normalize(found[0].note).slice(0, 120);
    if (verdict === 'met' && !grounded) {
      return { id: criterion.id, label: criterion.label, verdict: 'partial', quote: null, note: '인용 문장을 답변에서 찾을 수 없어 부분으로 표시' };
    }
    return { id: criterion.id, label: criterion.label, verdict, quote: grounded ? quote : null,
      note: note || (quote && !grounded ? '인용 문장을 답변에서 찾을 수 없음' : '') };
  });
  const recommendation = checked.every(item => item.verdict === 'met') ? 'verify' : 'resend';
  return { items: checked, recommendation, draft: recommendation === 'resend' ? resendDraft(checked) : '' };
}

export function resendDraft(items) {
  return '보내 주신 답변에서 다음 항목이 확인되지 않았습니다.\n' +
    items.filter(item => item.verdict !== 'met')
      .map(item => '- ' + item.label + ' (' + verdictLabels[item.verdict] + ')').join('\n') +
    '\n해당 내용과 자료를 보완해 제출해 주세요.';
}

export const conditionCatalog = {
  payeeProof: '지급 전 거래처별 받는 계좌 예금주 확인',
  sharedAccountStatement: '공동 계좌를 쓴 이유 확인서 받기',
  representativeProof: '사업자등록증으로 대표자 확인',
  addressProof: '사업장 주소 확인 자료 받기',
  precheck3m: '다음 3개월 이 묶음 지급 전 영업임원 사전 확인',
};

export function conditionBasis(item, { pastConclusion } = {}) {
  const matched = new Set(item.group.links.flatMap(link => link.matchedFields));
  const pairs = field => item.group.links.filter(link => link.matchedFields.includes(field))
    .map(link => link.agencyIds.join('·')).join(', ');
  const shared = item.collectionEvidence.filter(entry => new Set(entry.deposits.map(row => row.agencyId)).size > 1);
  const outside = shared.flatMap(entry => entry.deposits.filter(row =>
    !entry.registered.some(registered => registered.agencyId === row.agencyId)));
  const sharedText = shared.map(entry => [...new Set(entry.deposits.map(row => row.agencyId))].join('·') +
    '이 같은 입금계좌(•••• ' + entry.account.slice(-4) + ') 사용').join(', ');
  const outsideText = outside.length ? ' · 등록계좌가 다른 거래처의 입금 ' + outside.map(row => row.depositId).join('·') : '';
  const basis = {};
  if (shared.length || matched.has('bank_account_no')) {
    basis.payeeProof = shared.length ? sharedText + outsideText : '정산계좌 일치 ' + pairs('bank_account_no');
  }
  if (shared.length) basis.sharedAccountStatement = sharedText;
  if (matched.has('representative_name')) {
    basis.representativeProof = '대표자 일치 ' + pairs('representative_name') + ' · 동명이인 여부는 등록 정보만으로 판단 불가';
  }
  if (matched.has('address')) basis.addressProof = '주소 일치 ' + pairs('address');
  if (['audit_report', 'recovery'].includes(pastConclusion)) basis.precheck3m = '사후 검토 결론 ' + (pastConclusion === 'audit_report' ? '감사 보고' : '회수 검토');
  return basis;
}

export function validateConditions(raw, allowed) {
  const values = Array.isArray(raw?.conditions) ? raw.conditions : [];
  const unique = [...new Set(values)];
  if (!unique.length || unique.length > 3 || unique.length !== values.length || !unique.every(id => allowed.includes(id))) {
    throw new Error('허용된 승인 조건 목록에서 1~3개를 골라야 합니다.');
  }
  return unique;
}

export function conditionCutoff(record, events) {
  const times = [record?.acted_at, ...events.filter(event => event.action === 'review_approve').map(event => event.acted_at)]
    .filter(Boolean).map(value => new Date(value).getTime());
  return times.length ? Math.max(...times) : 0;
}

export function confirmedConditions(record, events) {
  const cutoff = conditionCutoff(record, events);
  return new Map(events.filter(event => event.action === 'condition_check' &&
    new Date(event.acted_at).getTime() >= cutoff && event.metadata?.condition)
    .map(event => [event.metadata.condition, event]));
}

export const postAuditConclusions = { closed: '정당 사유 확인 · 종결', audit_report: '감사 보고', recovery: '회수 검토' };

export const masterCheckResults = { same: '당시에도 지금과 같았음', different: '당시 등록 정보가 달랐음', unknown: '확인할 수 없음' };

// 원인 추정. 현재 마스터만으로는 승인 당시의 대표자·주소·계좌를 알 수 없다(W07 미해결 지점).
// 그래서 '현재 등록 정보 기준'으로만 말하고, 당시 정보 확인 결과(masterCheck)가 있을 때만 결론을 좁힌다.
export function postAuditCause(group, data, masterCheck) {
  const registered = group.members.map(id => data.agencies.find(row => row.agency_id === id)?.registered_date).filter(Boolean);
  const firstPaid = group.months.flatMap(month => month.paymentDates).sort()[0];
  const before = registered.length === group.members.length && registered.every(date => date < firstPaid);
  const span = registered.sort()[0] + '~' + registered.at(-1);
  if (masterCheck === 'same') return { code: 'approval_unit', confirmed: true,
    text: '승인 당시에도 등록 정보가 지금과 같았음(확인됨). 자료는 있었지만 거래처별로 승인해 합산 한도가 적용되지 않음 → 원인은 승인 단위.' };
  if (masterCheck === 'different') return { code: 'data_change', confirmed: true,
    text: '승인 당시 등록 정보가 지금과 달랐음(확인됨). 당시 자료로는 묶음을 알기 어려웠을 수 있음 → 원인은 등록 정보 변경 관리.' };
  return { code: before ? 'approval_unit_likely' : 'unknown', confirmed: false,
    text: (before ? '현재 등록 정보 기준으로는 세 거래처가 첫 지급(' + firstPaid + ') 전부터 등록돼 있어(' + span + ') 묶음 대상으로 보임. '
      : '일부 거래처가 첫 지급(' + firstPaid + ') 이후 등록됨. ') +
      '다만 승인 당시의 대표자·주소·계좌 기록은 원본에 없어 확인이 필요함.' };
}

// 지난 지급 점검에서 감사 보고·회수 검토로 결론 난 묶음은 결론 다음 달부터 3개월 동안
// 팀 승인 범위여도 영업임원 확인을 거친다(프로젝트 통제 · 원본 승인권한을 넓히지 않고 상향만 함).
const monthIndex = period => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
export function precheckGroups(auditEvents, period) {
  return new Set(auditEvents.filter(event => event.period && ['audit_report', 'recovery'].includes(event.metadata?.conclusion) &&
    monthIndex(period) - monthIndex(event.period) >= 1 && monthIndex(period) - monthIndex(event.period) <= 3).map(event => event.group_id));
}

// 장려금률(장려금 ÷ 매출): 원본 금액으로 코드가 계산한다. AI 설명의 근거 숫자는 여기서만 나온다.
export function rebateRates(data, period) {
  const rate = row => Number(row.rebate_amount_krw) / Number(row.sales_performance_krw) * 100;
  const current = data.rebates.filter(row => row.period_ym === period && Number(row.sales_performance_krw) > 0);
  const mean = current.length ? current.reduce((sum, row) => sum + rate(row), 0) / current.length : 0;
  const byAgency = new Map(current.map(row => {
    const past = data.rebates.filter(other => other.agency_id === row.agency_id && other.period_ym < period && Number(other.sales_performance_krw) > 0);
    return [row.agency_id, { rate: rate(row), usual: past.length ? past.reduce((sum, other) => sum + rate(other), 0) / past.length : null, months: past.length }];
  }));
  return { mean, byAgency };
}

export const pct = value => (Math.round(value * 10) / 10).toFixed(1) + '%';

// 팀 승인 이상 표시: 이번 달 장려금률이 그 거래처 평소(지난 달들 평균)보다 1.2%p 이상 높으면 표시한다.
export function rateAnomaly(rates, agencyId, threshold = 1.2) {
  const row = rates.byAgency.get(agencyId);
  if (!row || row.usual === null || row.rate - row.usual < threshold) return null;
  return { rate: pct(row.rate), usual: pct(row.usual), diff: (Math.round((row.rate - row.usual) * 10) / 10).toFixed(1) + '%p' };
}

// AI 문장 검증: 고른 사실 번호가 허용 목록에 있고, 문장의 숫자가 모두 고른 사실 안에 있어야 통과한다.
export function validateGroundedPoints(raw, facts, { max = 3, length = 80 } = {}) {
  const byId = new Map(facts.map(fact => [fact.id, fact.text]));
  const numbers = text => (String(text).match(/\d[\d,.]*/g) ?? []).map(token => token.replace(/,/g, '').replace(/\.$/, ''));
  const points = (Array.isArray(raw?.points) ? raw.points : []).slice(0, max).filter(point => {
    const ids = Array.isArray(point?.facts) ? point.facts : [];
    const text = String(point?.text ?? '').trim();
    if (!text || text.length > length || !ids.length || !ids.every(id => byId.has(id))) return false;
    const allowed = new Set(ids.flatMap(id => numbers(byId.get(id))));
    return numbers(text).every(token => allowed.has(token));
  }).map(point => ({ facts: [...new Set(point.facts)], text: String(point.text).trim() }));
  if (!points.length) throw new Error('근거와 맞는 문장이 없어요');
  return { points };
}
