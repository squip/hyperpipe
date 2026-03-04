import test from 'node:test';
import assert from 'node:assert/strict';

import GatewayCredentialService from '../src/GatewayCredentialService.mjs';

test('GatewayCredentialService issues and verifies creator credentials', () => {
  const service = new GatewayCredentialService({
    rootSecret: 'test-root-secret',
    creatorCredentialTtlMs: 60_000
  });

  const credential = service.issueCreatorCredential({
    origin: 'https://gateway.example',
    creatorPubkey: 'a'.repeat(64),
    credentialVersion: 3
  });

  assert.ok(credential.token);
  assert.equal(credential.scope, 'creator');
  assert.equal(credential.origin, 'https://gateway.example');
  assert.equal(credential.creatorPubkey, 'a'.repeat(64));
  assert.equal(credential.credentialVersion, 3);

  const verified = service.verifyToken(credential.token, {
    origin: 'https://gateway.example',
    scope: 'creator',
    creatorPubkey: 'a'.repeat(64)
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.payload.scope, 'creator');
  assert.equal(verified.payload.creatorPubkey, 'a'.repeat(64));
  assert.equal(verified.payload.credentialVersion, 3);
});

test('GatewayCredentialService enforces relay scope fields', () => {
  const service = new GatewayCredentialService({
    rootSecret: 'test-root-secret-2',
    relayCredentialTtlMs: 60_000
  });

  const credential = service.issueRelayCredential({
    origin: 'https://gateway.example',
    relayKey: 'b'.repeat(64),
    creatorPubkey: 'c'.repeat(64),
    credentialVersion: 5
  });

  assert.equal(credential.scope, 'relay');
  assert.equal(credential.relayKey, 'b'.repeat(64));

  const relayMatch = service.verifyToken(credential.token, {
    origin: 'https://gateway.example',
    scope: 'relay',
    relayKey: 'b'.repeat(64)
  });
  assert.equal(relayMatch.ok, true);

  const relayMismatch = service.verifyToken(credential.token, {
    origin: 'https://gateway.example',
    scope: 'relay',
    relayKey: 'd'.repeat(64)
  });
  assert.equal(relayMismatch.ok, false);
  assert.equal(relayMismatch.reason, 'credential-relay-mismatch');
});

test('GatewayCredentialService challenge is single-use', () => {
  const service = new GatewayCredentialService({
    rootSecret: 'test-root-secret-3',
    challengeTtlMs: 10_000
  });

  const challenge = service.issueChallenge({ origin: 'https://gateway.example' });
  assert.ok(challenge.challenge);
  assert.ok(challenge.nonce);

  const firstConsume = service.consumeChallenge(challenge.challenge);
  assert.ok(firstConsume);

  const secondConsume = service.consumeChallenge(challenge.challenge);
  assert.equal(secondConsume, null);
});
