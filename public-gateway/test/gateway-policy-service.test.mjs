import test from 'node:test';
import assert from 'node:assert/strict';

import GatewayPolicyService from '../src/GatewayPolicyService.mjs';

const CREATOR_A = 'a'.repeat(64);
const CREATOR_B = 'b'.repeat(64);
const RELAY_KEY = 'c'.repeat(64);

test('GatewayPolicyService open mode allows registration', () => {
  const policy = new GatewayPolicyService({
    config: {
      enabled: true,
      mode: 'open',
      allowList: [],
      banList: []
    }
  });

  const decision = policy.canRegisterRelay({ creatorPubkey: CREATOR_A });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'policy-open');
});

test('GatewayPolicyService allow-list mode enforces membership', () => {
  const policy = new GatewayPolicyService({
    config: {
      enabled: true,
      mode: 'allow-list',
      allowList: [CREATOR_A],
      banList: []
    }
  });

  const denied = policy.canRegisterRelay({ creatorPubkey: CREATOR_B });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'creator-not-allow-listed');

  const allowed = policy.canRegisterRelay({ creatorPubkey: CREATOR_A });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'creator-allow-listed');
});

test('GatewayPolicyService ban-list overrides allow-list and tracks relay creator map', () => {
  const policy = new GatewayPolicyService({
    config: {
      enabled: true,
      mode: 'allow-list',
      allowList: [CREATOR_A],
      banList: [CREATOR_A]
    }
  });

  const denied = policy.canRegisterRelay({ creatorPubkey: CREATOR_A });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'creator-banned');

  policy.noteRelayCreator(RELAY_KEY, CREATOR_B);
  assert.equal(policy.getRelayCreator(RELAY_KEY), CREATOR_B);
  assert.deepEqual(policy.listRelayKeysForCreator(CREATOR_B), [RELAY_KEY]);
  policy.removeRelay(RELAY_KEY);
  assert.equal(policy.getRelayCreator(RELAY_KEY), null);
});
