import test from 'node:test'
import assert from 'node:assert/strict'

import GatewayPolicyService from '../src/GatewayPolicyService.mjs'
import GatewayAuthService from '../src/GatewayAuthService.mjs'
import GatewayEventPublisher from '../src/GatewayEventPublisher.mjs'
import { createKeypair, signGatewayAuthEvent } from '../test-support/gateway-auth-helpers.mjs'

const ADMIN = 'a'.repeat(64)
const MEMBER = 'b'.repeat(64)
const BANNED = 'c'.repeat(64)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('GatewayPolicyService enforces OPEN/CLOSED allow/ban rules', () => {
  const openPolicy = new GatewayPolicyService({
    config: {
      policy: 'OPEN',
      banList: [BANNED]
    }
  })
  assert.equal(openPolicy.canRegisterRelay({ adminPubkey: ADMIN }).allowed, true)
  assert.equal(openPolicy.canRegisterRelay({ adminPubkey: BANNED }).allowed, false)
  assert.equal(openPolicy.canAccessRelay({ pubkey: MEMBER, relayAdminPubkey: ADMIN }).allowed, true)
  assert.equal(openPolicy.canAccessRelay({ pubkey: BANNED, relayAdminPubkey: ADMIN }).allowed, false)

  const closedPolicy = new GatewayPolicyService({
    config: {
      policy: 'CLOSED',
      allowList: [ADMIN],
      banList: [BANNED]
    }
  })

  const registerAllowed = closedPolicy.canRegisterRelay({ adminPubkey: ADMIN })
  const registerDenied = closedPolicy.canRegisterRelay({ adminPubkey: MEMBER })
  const memberAllowedByRelay = closedPolicy.canAccessRelay({ pubkey: MEMBER, relayAdminPubkey: ADMIN })
  const memberDenied = closedPolicy.canAccessRelay({ pubkey: MEMBER, relayAdminPubkey: MEMBER })
  const bannedDenied = closedPolicy.canAccessRelay({ pubkey: BANNED, relayAdminPubkey: ADMIN })

  assert.equal(registerAllowed.allowed, true)
  assert.equal(registerDenied.allowed, false)
  assert.equal(memberAllowedByRelay.allowed, true)
  assert.equal(memberDenied.allowed, false)
  assert.equal(bannedDenied.allowed, false)
})

test('GatewayAuthService verifies challenge signatures and JWT scopes', async () => {
  const kp = createKeypair()
  const authService = new GatewayAuthService({
    config: {
      jwtSecret: 'test-jwt-secret',
      tokenTtlSec: 1,
      challengeTtlMs: 500,
      authWindowSec: 60,
      issuer: 'test-gateway'
    }
  })

  const challenge = authService.issueChallenge({
    pubkey: kp.publicKeyHex,
    scope: 'gateway:operator',
    relayKey: 'relay-alpha'
  })
  assert.ok(challenge.challengeId)
  assert.ok(challenge.nonce)

  const authEvent = await signGatewayAuthEvent({
    privateKeyHex: kp.privateKeyHex,
    pubkey: kp.publicKeyHex,
    nonce: challenge.nonce,
    scope: 'gateway:operator'
  })

  const verified = await authService.verifyChallenge({
    challengeId: challenge.challengeId,
    authEvent
  })

  assert.equal(verified.ok, true)
  assert.ok(verified.token)

  const tokenCheck = authService.verifyToken(verified.token, {
    requiredScopes: ['gateway:operator'],
    relayKey: 'relay-alpha',
    pubkey: kp.publicKeyHex
  })
  assert.equal(tokenCheck.ok, true)

  const scopeMismatch = authService.verifyToken(verified.token, {
    requiredScopes: ['gateway:invite-redeem']
  })
  assert.equal(scopeMismatch.ok, false)
  assert.equal(scopeMismatch.reason, 'token-scope-mismatch')

  await sleep(1100)
  const expired = authService.verifyToken(verified.token, {
    requiredScopes: ['gateway:operator']
  })
  assert.equal(expired.ok, false)
  assert.equal(expired.reason, 'token-expired')
})

test('GatewayAuthService rejects expired challenges', async () => {
  const kp = createKeypair()
  const authService = new GatewayAuthService({
    config: {
      jwtSecret: 'challenge-expiry-secret',
      challengeTtlMs: 15,
      authWindowSec: 60
    }
  })

  const challenge = authService.issueChallenge({
    pubkey: kp.publicKeyHex,
    scope: 'gateway:operator'
  })
  await sleep(30)

  const authEvent = await signGatewayAuthEvent({
    privateKeyHex: kp.privateKeyHex,
    pubkey: kp.publicKeyHex,
    nonce: challenge.nonce,
    scope: 'gateway:operator'
  })

  const result = await authService.verifyChallenge({
    challengeId: challenge.challengeId,
    authEvent
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'challenge-not-found')
})

test('GatewayEventPublisher includes metadata + invite tags', () => {
  const policy = new GatewayPolicyService({
    config: {
      operatorPubkey: ADMIN,
      policy: 'CLOSED',
      allowList: [ADMIN, MEMBER],
      banList: [BANNED],
      discoveryRelays: ['wss://relay.one', 'wss://relay.two']
    }
  })

  const publisher = new GatewayEventPublisher({
    gatewayOrigin: 'https://gw.example',
    policyService: policy
  })

  const metadata = publisher.buildMetadataEvent({ reason: 'unit-test' })
  assert.equal(metadata?.kind, 30078)
  assert.equal(metadata?.tags?.find((tag) => tag[0] === 'h')?.[1], 'hypertuna_gateway:metadata')
  assert.equal(metadata?.tags?.find((tag) => tag[0] === 'policy')?.[1], 'CLOSED')
  assert.deepEqual(metadata?.tags?.find((tag) => tag[0] === 'allow-list')?.slice(1), [ADMIN, MEMBER])

  const invite = publisher.buildInviteEvent({
    inviteePubkey: MEMBER,
    inviteToken: 'invite-token-abc'
  })
  assert.equal(invite?.kind, 30078)
  assert.equal(invite?.tags?.find((tag) => tag[0] === 'h')?.[1], 'hypertuna_gateway:invite')
  assert.equal(invite?.tags?.find((tag) => tag[0] === 'p')?.[1], MEMBER)
  assert.equal(invite?.tags?.find((tag) => tag[0] === 'INVITE')?.[1], 'invite-token-abc')
})
