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

export const replyCriteria = [
  { id: 'history', label: '공동 입금계좌·등록정보 공유 경위' },
  { id: 'payee', label: '거래처별 지급 수취계좌·예금주 명의' },
  { id: 'evidence', label: '요청한 증빙 제출 또는 제출 위치' },
];
export const verdictLabels = { met: '충족', unclear: '불명확', missing: '부족' };
export const recommendationLabels = { verify: '확인 완료', resend: '보완 요청' };

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function validateReplyCheck(raw, reply) {
  if (!Array.isArray(raw?.items)) throw new Error('판정 형식이 올바르지 않습니다.');
  const text = normalize(reply);
  const items = replyCriteria.map(criterion => {
    const found = raw.items.filter(entry => entry?.id === criterion.id);
    if (found.length !== 1 || !Object.hasOwn(verdictLabels, found[0].verdict)) {
      throw new Error('확인 항목마다 판정이 하나씩 필요합니다.');
    }
    const quote = normalize(found[0].quote);
    const grounded = quote.length > 0 && text.includes(quote);
    if (found[0].verdict === 'met' && !grounded) {
      return { ...criterion, verdict: 'unclear', quote: null, note: '인용 문장을 답변에서 찾을 수 없어 불명확으로 표시' };
    }
    return { ...criterion, verdict: found[0].verdict, quote: grounded ? quote : null,
      note: quote && !grounded ? '인용 문장을 답변에서 찾을 수 없음' : '' };
  });
  const recommendation = items.every(item => item.verdict === 'met') ? 'verify' : 'resend';
  return { items, recommendation, draft: recommendation === 'resend' ? resendDraft(items) : '' };
}

export function resendDraft(items) {
  return '보내 주신 답변에서 다음 항목이 확인되지 않았습니다.\n' +
    items.filter(item => item.verdict !== 'met')
      .map(item => '- ' + item.label + ' (' + verdictLabels[item.verdict] + ')').join('\n') +
    '\n해당 내용과 자료를 보완해 제출해 주세요.';
}

export const conditionCatalog = {
  payeeProof: '지급 전 거래처별 통장 사본으로 수취계좌·예금주 명의 확인',
  sharedAccountStatement: '공동 계좌 사용 경위서 접수 확인',
  representativeProof: '사업자등록증으로 대표자 확인',
  addressProof: '사업장 주소 확인 자료 확인',
};

export function conditionBasis(item) {
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
