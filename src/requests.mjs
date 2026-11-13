// 소명 요청의 건별 확인 항목, 거래처별 답변, 보완 범위를 다룬다.
import { conditionCatalog, formatLabels, itemCatalog } from './controls.mjs';

export function effectiveCatalog(rows = []) {
  const items = Object.fromEntries(Object.entries(itemCatalog).map(([id, entry]) => [id, { ...entry, status: 'active' }]));
  const conditions = Object.fromEntries(Object.entries(conditionCatalog).map(([id, label]) => [id, { label, status: 'active' }]));
  for (const row of rows) {
    const target = row.kind === 'condition' ? conditions : items;
    target[row.id] = { ...(target[row.id] ?? { format: 'text', attachment: '', custom: true }),
      ...(row.label ? { label: row.label } : {}), ...(row.format ? { format: row.format } : {}),
      ...(row.attachment != null ? { attachment: row.attachment } : {}), status: row.status ?? 'active',
      ...(row.kind !== 'condition' && !itemCatalog[row.id] ? { custom: true } : {}) };
  }
  return { items, conditions };
}

export function addBusinessDays(isoDate, days) {
  const date = new Date(isoDate + 'T00:00:00Z');
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (![0, 6].includes(date.getUTCDay())) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

export function buildRequestItems(ids, customLabel, catalog, entry) {
  const members = entry.group.members.map(member => member.agencyId);
  const repAgencies = [...new Set(entry.group.links.filter(link => link.matchedFields.includes('representative_name'))
    .flatMap(link => link.agencyIds))];
  const items = ids.filter(id => catalog.items[id]).map(id => ({
    id, label: catalog.items[id].label, format: catalog.items[id].format ?? 'text',
    attachment: catalog.items[id].attachment ?? '',
    recipients: id === 'sameRep' && repAgencies.length ? repAgencies : members,
  }));
  const custom = String(customLabel ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (custom) items.push({ id: 'custom1', label: custom, format: 'text', attachment: '', recipients: members, custom: true });
  return items;
}

export const isRequest = event => ['send', 'resend'].includes(event.action);

export function latestRequest(events) {
  return events.findLast(isRequest);
}

export function requestItems(events, groupId) {
  const request = latestRequest(events);
  if (!request) return [];
  if (Array.isArray(request.metadata?.items) && request.metadata.items.length) return request.metadata.items;
  return [{ id: 'legacy', label: '요청 내용에 대한 답변', format: 'text', attachment: '',
    recipients: [request.agency_id ?? groupId] }];
}

export function allRequestedItems(events, groupId) {
  const first = events.find(event => event.action === 'send');
  if (Array.isArray(first?.metadata?.items) && first.metadata.items.length) return first.metadata.items;
  return requestItems(events, groupId);
}

export function recipientsOf(events, groupId) {
  return [...new Set(requestItems(events, groupId).flatMap(item => item.recipients))];
}

export function mergedAnswers(events) {
  const firstSend = events.findIndex(event => event.action === 'send');
  const answers = {};
  for (const event of events.slice(Math.max(firstSend, 0))) {
    if (event.action === 'send') { for (const key of Object.keys(answers)) delete answers[key]; continue; }
    if (event.action !== 'reply' || !event.agency_id) continue;
    const entry = answers[event.agency_id] ??= { items: {}, at: event.acted_at, eventId: event.id };
    entry.at = event.acted_at;
    entry.eventId = event.id;
    const structured = event.metadata?.answers;
    if (structured) Object.assign(entry.items, structured);
    else entry.items.legacy = { text: event.reason };
  }
  return answers;
}

const filled = answer => answer && Object.values(answer).some(value => String(value ?? '').trim());

export function composeReply(form, items) {
  const answers = {};
  const lines = [];
  for (const item of items) {
    const answer = {
      text: (form.get('ans_' + item.id) ?? '').trim().slice(0, 600),
      yesno: ['예', '아니오'].includes(form.get('yn_' + item.id)) ? form.get('yn_' + item.id) : '',
      account: (form.get('acc_' + item.id) ?? '').trim().slice(0, 80),
      holder: (form.get('holder_' + item.id) ?? '').trim().slice(0, 60),
      attachment: (form.get('att_' + item.id) ?? '').trim().slice(0, 300),
    };
    if (!filled(answer)) continue;
    answers[item.id] = answer;
    lines.push('[' + item.label + '] ' + [answer.yesno, answer.text,
      answer.account && '수취계좌 ' + answer.account + (answer.holder ? ' 예금주 ' + answer.holder : ''),
      answer.attachment && '첨부 ' + answer.attachment].filter(Boolean).join(' · '));
  }
  return { answers, text: lines.join('\n') };
}

export function replyText(merged, items) {
  return Object.entries(merged).map(([agency, entry]) => '[' + agency + ']\n' + items.map(item => {
    const answer = entry.items[item.id];
    if (!filled(answer)) return null;
    return item.label + ': ' + [answer.yesno, answer.text,
      answer.account && '수취계좌 ' + answer.account + (answer.holder ? ' 예금주 ' + answer.holder : ''),
      answer.attachment && '첨부 ' + answer.attachment].filter(Boolean).join(' · ');
  }).filter(Boolean).join('\n')).join('\n\n');
}

export function itemMarks(item, merged, verdict) {
  return item.recipients.map(agency => {
    const entry = merged[agency];
    const answer = entry?.items[item.id];
    const status = !entry ? 'none' : !filled(answer) ? 'missing' : 'met';
    return { agency, status, answer: answer ?? null };
  });
}

export function resendItems(items, merged, checks) {
  return items.flatMap(item => {
    const verdict = checks.find(check => check.id === item.id)?.verdict;
    if (verdict === 'met') return [];
    const missing = item.recipients.filter(agency => !filled(merged[agency]?.items[item.id]));
    return [{ ...item, recipients: missing.length ? missing : item.recipients }];
  });
}

export function resendText(items) {
  const byAgency = {};
  for (const item of items) for (const agency of item.recipients) (byAgency[agency] ??= []).push(item.label);
  return Object.entries(byAgency).map(([agency, labels]) => agency + ' · ' + labels.join(', ') + ' 보완이 필요합니다.').join('\n');
}

export { formatLabels };

// 지급 수취 계좌 계획: 지급은 등록 정산계좌로만 한다(회수·입금계좌를 지급계좌로 단정하지 않음).
// 거래처가 답한 받을 계좌가 등록 정산계좌와 다르면 정산계좌 변경을 먼저 확인해야 한다.
const digits = value => String(value ?? '').replace(/\D/g, '');
export function payeePlan(entry, events, agencies) {
  const merged = mergedAnswers(events);
  return entry.group.members.map(({ agencyId }) => {
    const registered = agencies.find(row => row.agency_id === agencyId)?.bank_account_no ?? '';
    const answer = Object.values(merged[agencyId]?.items ?? {}).find(value => value?.account);
    const status = !answer ? 'registered' : digits(answer.account).endsWith(digits(registered).slice(-6)) && digits(registered).endsWith(digits(answer.account).slice(-6)) ? 'ok' : 'mismatch';
    return { agencyId, account: registered, claimed: answer?.account ?? null, holder: answer?.holder ?? null, status };
  });
}

export function decisionSnapshot(entry) {
  return { members: entry.rebateRows.map(row => ({ agencyId: row.agencyId, rebateId: row.rebateId, amountKrw: row.amountKrw,
    source: row.source.file + ':' + row.source.row })), totalKrw: entry.totalKrw, approver: entry.approver,
    links: entry.group.links.map(link => ({ agencies: link.agencyIds, fields: link.matchedFields })) };
}
