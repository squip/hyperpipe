import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnvMap,
  deriveOperatorPubkeyHex,
  deriveRelayAdminKeyPair
} from '../bin/lib/config-wizard.mjs';
import { serializeEnv } from '../bin/lib/template-renderer.mjs';

test('buildEnvMap creates expected profile-specific keys', () => {
  const local = buildEnvMap({
    profile: 'local',
    gatewayBindPort: '4444',
    gatewayPublicUrl: 'http://127.0.0.1:4444',
    registrationSecret: 'secret-local',
    operatorNsecHex: '1'.repeat(64),
    relaySeedHex: '2'.repeat(64),
    relayNamespace: 'gateway-relay-local',
    relayReplicationTopic: 'gateway-relay-local',
    policy: 'OPEN',
    inviteOnly: false,
    allowList: [],
    banList: [],
    discoveryRelays: ['wss://relay.one'],
    authJwtSecret: 'jwt-local',
    metricsEnabled: true
  });
  assert.equal(local.GATEWAY_PROFILE, 'local');
  assert.equal(local.GATEWAY_BIND_PORT, '4444');
  assert.equal(local.GATEWAY_PUBLIC_URL, 'http://127.0.0.1:4444');
  assert.equal(local.GATEWAY_HOST, undefined);
  assert.equal(local.GATEWAY_OPERATOR_PUBKEY_HEX, deriveOperatorPubkeyHex('1'.repeat(64)));
  assert.equal(local.GATEWAY_RELAY_NAMESPACE, 'gateway-relay-local');
  assert.equal(local.GATEWAY_RELAY_REPLICATION_TOPIC, 'gateway-relay-local');
  assert.equal(local.GATEWAY_RELAY_SEED, '2'.repeat(64));
  assert.equal(local.GATEWAY_RELAY_ADMIN_PUBLIC_KEY, deriveRelayAdminKeyPair('2'.repeat(64)).relayAdminPublicKeyHex);
  assert.equal(local.GATEWAY_LOG_DIR, '/app/public-gateway/logs');
  assert.ok(local.GATEWAY_HOST_LOG_PATH?.length > 0);

  const internet = buildEnvMap({
    profile: 'internet',
    gatewayHost: 'gateway.example.com',
    letsencryptEmail: 'ops@example.com',
    gatewayPublicUrl: 'https://gateway.example.com',
    registrationSecret: 'secret-internet',
    operatorNsecHex: '3'.repeat(64),
    relaySeedHex: '4'.repeat(64),
    relayNamespace: 'gateway-relay-internet',
    relayReplicationTopic: 'gateway-relay-internet',
    policy: 'CLOSED',
    inviteOnly: true,
    allowList: ['a'.repeat(64)],
    banList: ['b'.repeat(64)],
    discoveryRelays: ['wss://relay.alpha'],
    authJwtSecret: 'jwt-internet',
    metricsEnabled: false
  });
  assert.equal(internet.GATEWAY_PROFILE, 'internet');
  assert.equal(internet.GATEWAY_HOST, 'gateway.example.com');
  assert.equal(internet.LETSENCRYPT_EMAIL, 'ops@example.com');
  assert.equal(internet.GATEWAY_PUBLIC_URL, 'https://gateway.example.com');
  assert.equal(internet.GATEWAY_BIND_PORT, undefined);
  assert.equal(internet.GATEWAY_OPERATOR_PUBKEY_HEX, deriveOperatorPubkeyHex('3'.repeat(64)));
  assert.equal(internet.GATEWAY_RELAY_SEED, '4'.repeat(64));
  assert.ok(internet.GATEWAY_RELAY_ADMIN_SECRET_KEY?.length === 128);

  const serialized = serializeEnv(internet);
  assert.ok(serialized.includes('GATEWAY_PROFILE=internet'));
  assert.ok(serialized.includes('GATEWAY_HOST=gateway.example.com'));
  assert.ok(serialized.includes('GATEWAY_RELAY_ADMIN_PUBLIC_KEY='));
  assert.ok(serialized.includes('GATEWAY_LOG_DIR=/app/public-gateway/logs'));
});
