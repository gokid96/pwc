export const steps = {
  send: ['draft', 'waiting', '영업지원팀', '소명 요청 등록'],
  reply: ['waiting', 'received', '대리점', '답변 접수'],
  resend: ['received', 'waiting', '영업지원팀', '보완 요청 등록'],
  verify: ['received', 'verified', '영업지원팀', '소명 확인 완료'],
  resubmit: ['verified', 'resubmitted', '영업지원팀', '임원 재상신'],
  payment: ['paymentPending', 'paymentReady', '회계', '지급 시스템 반영'],
};

export const labels = {
  draft: '소명 요청 작성', waiting: '답변 대기', received: '답변 검토',
  verified: '확인 완료', resubmitted: '재상신 · 승인 대기',
  paymentPending: '지급 반영 대기', paymentReady: '지급 반영 완료',
};

export function followupState(record, latest, executive) {
  if (record?.created_at) return latest === 'payment' ? 'paymentReady' : 'paymentPending';
  if (executive && ['reject', 'clarify'].includes(record?.action)) {
    return latest === 'resubmit' ? 'draft' : steps[latest]?.[1] ?? 'draft';
  }
  return latest === 'resubmit' ? 'resubmitted' : null;
}

export function requestProgress(record, events, executive, review) {
  const business = events.filter(event => Object.hasOwn(steps, event.action) || event.action.startsWith('review_'));
  if (!review) return { state: followupState(record, business.at(-1)?.action, executive), held: false };
  const matching = business.filter(event => String(event.review_id) === String(review.id));
  const latest = matching.at(-1)?.action;
  if (matching.some(event => event.action === 'review_approve')) {
    return { state: latest === 'payment' ? 'paymentReady' : 'paymentPending', held: false };
  }
  const previous = business.filter(event => event.acted_at >= (record?.acted_at ?? new Date(0))).at(-1);
  const ongoingReview = previous?.review_id && !business.some(event =>
    event.review_id === previous.review_id && event.action === 'review_approve');
  const inherited = (record?.action !== 'approve' || ongoingReview) &&
    Object.hasOwn(steps, previous?.action) && previous.action !== 'payment'
    ? previous.action : null;
  return { state: steps[latest ?? inherited]?.[1] ?? 'draft', held: true };
}

export function followupError(action, state, role, reason) {
  if (!Object.hasOwn(steps, action)) return 400;
  const [from, , owner] = steps[action];
  if (role !== owner) return 403;
  if (state !== from && !(action === 'reply' && state === 'received')) return 409;
  if (action !== 'resubmit' && (!reason.trim() || reason.length > (action === 'reply' ? 3000 : 1000))) return 400;
  return null;
}
