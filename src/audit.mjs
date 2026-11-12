import { createHash } from 'node:crypto';

export const sourceLabels = { scenario: '추가 시나리오 자료', manual: '가상 회신 · 직접 입력' };
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function inputMetadata(form, period) {
  const occurredOn = form.get('occurredOn');
  const effectiveOn = form.get('sameEffectiveDate') === 'yes' ? occurredOn : form.get('effectiveOn');
  if (!validDate(occurredOn) || !validDate(effectiveOn) || form.get('effectivePeriod') !== period) return null;
  return { occurredOn, effectiveOn, effectivePeriod: period, source: form.get('source') === 'scenario' ? 'scenario' : 'manual' };
}
export function metadataFields(period, escape, previous, { reuseOccurred = false } = {}) {
  const inherited = previous?.effectivePeriod === period ? previous : null;
  return '<div class="record-fields"><label>업무 발생일 <input type="date" name="occurredOn" value="' +
    escape(reuseOccurred ? inherited?.occurredOn ?? '' : '') + '" required></label>' +
    '<details class="input-provenance"><summary>기록 정보 · 적용 ' + escape(period) + (inherited ? ' · 이전 정보 이어받음' : '') + '</summary>' +
    '<p class="muted">가상기업 기준일 2026-07-01 · 실제 입력 시각은 별도 기록합니다. 지정한 정산월에 즉시 반영하며 예약 적용은 하지 않습니다.</p>' +
    '<label>자료 구분 <select name="source">' + Object.entries(sourceLabels).map(([value, label]) =>
      '<option value="' + value + '"' + (value === (inherited?.source ?? 'manual') ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label> ' +
    '<label><input type="checkbox" name="sameEffectiveDate" value="yes" checked> 적용일은 업무 발생일과 같음</label> ' +
    '<label>적용일 <input type="date" name="effectiveOn" value="" disabled></label> ' +
    '<label>적용 정산월 <input name="effectivePeriod" value="' + escape(period) + '" readonly></label></details></div>';
}
export function newestFirstEvents(events) {
  return events.map((event, index) => ({ event, index })).sort((a, b) =>
    (new Date(b.event.acted_at).getTime() || 0) - (new Date(a.event.acted_at).getTime() || 0) ||
    b.index - a.index).map(({ event }) => event);
}
export function metadataView(metadata, escape) {
  if (!metadata) return '<small>기존 입력 · 출처·업무 발생일·적용일 미기록</small>';
  return '<small>' + escape(sourceLabels[metadata.source] ?? '출처 미확인') + ' · 업무 발생일 ' + escape(metadata.occurredOn) +
    ' · 적용일 ' + escape(metadata.effectiveOn) + ' · 적용 정산월 ' + escape(metadata.effectivePeriod) + '</small>';
}
export function paymentEvidence(form) {
  const reference = form.get('evidenceReference')?.trim();
  const finding = form.get('evidenceFinding')?.trim();
  if (!reference || reference.length > 200 || !finding || finding.length > 1000) return null;
  return { reference, finding };
}
export function summaryBasis(item, review, events, decision) {
  return createHash('sha256').update(JSON.stringify({ members: item.group.members.map(row => row.agencyId),
    links: item.group.links, amount: item.totalKrw, review: review?.id ?? null,
    decision: decision ? [decision.action, decision.acted_at] : null,
    events: events.map(row => String(row.id)), })).digest('hex');
}
