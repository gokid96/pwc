export const steps = {
  send: ['draft', 'waiting', '영업지원팀', '소명 요청 등록'],
  reply: ['waiting', 'received', '대리점', '답변 접수'],
  resend: ['received', 'waiting', '영업지원팀', '보완 요청 등록'],
  verify: ['received', 'verified', '영업지원팀', '소명 확인 완료'],
  resubmit: ['verified', 'resubmitted', '영업지원팀', '임원 재상신'],
  payment: ['paymentPending', 'paymentReady', '회계', '지급 증빙 확인'],
};

export const labels = {
  draft: '소명 요청 작성', waiting: '답변 대기', received: '답변 검토',
  verified: '확인 완료', resubmitted: '재상신 · 승인 대기',
  paymentPending: '확인 대기', paymentReady: '지급 검토 가능',
};

export function followupState(record, latest, executive) {
  if (record?.created_at) return latest === 'payment' ? 'paymentReady' : 'paymentPending';
  if (executive && ['reject', 'clarify'].includes(record?.action)) {
    return latest === 'resubmit' ? 'draft' : steps[latest]?.[1] ?? 'draft';
  }
  return latest === 'resubmit' ? 'resubmitted' : null;
}

export function followupError(action, state, role, reason) {
  if (!Object.hasOwn(steps, action)) return 400;
  const [from, , owner] = steps[action];
  if (role !== owner) return 403;
  if (state !== from) return 409;
  if (action !== 'resubmit' && (!reason.trim() || reason.length > 1000)) return 400;
  return null;
}
