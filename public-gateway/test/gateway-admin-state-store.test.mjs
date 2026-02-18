import test from 'node:test';
import assert from 'node:assert/strict';

import MemoryGatewayAdminStateStore from '../src/stores/MemoryGatewayAdminStateStore.mjs';

test('MemoryGatewayAdminStateStore persists policy, invites, requests, and activity', async () => {
  const store = new MemoryGatewayAdminStateStore({ activityRetention: 3 });

  await store.setPolicySnapshot({
    policy: 'CLOSED',
    allowList: ['a'.repeat(64)],
    banList: ['b'.repeat(64)],
    discoveryRelays: ['wss://relay.one'],
    inviteOnly: true
  });

  await store.setJoinRequests([
    {
      id: 'jr-1',
      pubkey: 'c'.repeat(64),
      status: 'pending',
      createdAt: 2,
      updatedAt: 2
    }
  ]);

  await store.setInvites([
    {
      inviteToken: 'invite-1',
      pubkey: 'd'.repeat(64),
      createdAt: 3,
      expiresAt: Date.now() + 60_000,
      redeemedAt: null
    }
  ]);

  await store.appendActivity({ type: 'one', createdAt: 1 });
  await store.appendActivity({ type: 'two', createdAt: 2 });
  await store.appendActivity({ type: 'three', createdAt: 3 });
  await store.appendActivity({ type: 'four', createdAt: 4 });

  const policy = await store.getPolicySnapshot();
  const joinRequests = await store.getJoinRequests();
  const invites = await store.getInvites();
  const activity = await store.listActivity({ limit: 10 });

  assert.equal(policy.policy, 'CLOSED');
  assert.deepEqual(policy.allowList, ['a'.repeat(64)]);
  assert.deepEqual(policy.banList, ['b'.repeat(64)]);
  assert.equal(policy.inviteOnly, true);

  assert.equal(joinRequests.length, 1);
  assert.equal(joinRequests[0].id, 'jr-1');

  assert.equal(invites.length, 1);
  assert.equal(invites[0].inviteToken, 'invite-1');

  assert.equal(activity.length, 3);
  assert.deepEqual(activity.map((entry) => entry.type), ['four', 'three', 'two']);
});
