export async function approveSupportRequests({ role, ids, requests, savedIds, affected, approve }) {
  if (role !== '영업지원팀') return 403;
  if (!ids.length || new Set(ids).size !== ids.length) return 400;
  const byId = new Map(requests.map(request => [request.group.groupId, request]));
  for (const id of ids) {
    const request = byId.get(id);
    if (!request || request.approver !== role || request.exceedsLimit) return 403;
    if (savedIds.has(id) || request.group.members.some(member => affected.has(member.agencyId))) return 409;
  }
  for (const id of ids) await approve(id);
}
