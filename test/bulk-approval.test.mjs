import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveSupportRequests } from '../src/bulk-approval.mjs';

const request = (id, approver, exceedsLimit = false) => ({
  group: { groupId: id, members: [{ agencyId: id }] }, approver, exceedsLimit,
});

test('bulk approval rejects a mixed executive batch before writing any decisions or tasks', async () => {
  const writes = [];
  const options = {
    role: '영업지원팀', requests: [request('A', '영업지원팀'), request('B', '영업임원', true), request('C', '영업지원팀')],
    savedIds: new Set(), affected: new Set(), approve: async id => writes.push(id),
  };
  assert.equal(await approveSupportRequests({ ...options, ids: ['A', 'B'] }), 403);
  assert.deepEqual(writes, []);
  assert.equal(await approveSupportRequests({ ...options, ids: ['A', 'C'], affected: new Set(['C']) }), 409);
  assert.deepEqual(writes, []);
  assert.equal(await approveSupportRequests({ ...options, ids: ['A', 'C'] }), undefined);
  assert.deepEqual(writes, ['A', 'C']);
});
