import test from 'node:test'
import assert from 'node:assert/strict'

import PublicGatewayService from '../src/PublicGatewayService.mjs'
import MemoryRegistrationStore from '../src/stores/MemoryRegistrationStore.mjs'
import MemoryGatewayAdminStateStore from '../src/stores/MemoryGatewayAdminStateStore.mjs'
import { createKeypair, signGatewayAuthEvent } from '../test-support/gateway-auth-helpers.mjs'

function createTestLogger() {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger
    }
  }
  return logger
}

async function requestJson(baseUrl, path, {
  method = 'GET',
  body = null,
  headers = {}
} = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    headers: response.headers
  }
}

async function issueScopedToken(baseUrl, keypair, scope, relayKey = null) {
  const challengeResp = await requestJson(baseUrl, '/api/auth/challenge', {
    method: 'POST',
    body: {
      pubkey: keypair.publicKeyHex,
      scope,
      relayKey
    }
  })
  assert.equal(challengeResp.ok, true)
  const challengeId = challengeResp.data?.challengeId
  const nonce = challengeResp.data?.nonce
  assert.ok(challengeId)
  assert.ok(nonce)

  const authEvent = await signGatewayAuthEvent({
    privateKeyHex: keypair.privateKeyHex,
    pubkey: keypair.publicKeyHex,
    nonce,
    scope
  })

  const verifyResp = await requestJson(baseUrl, '/api/auth/verify', {
    method: 'POST',
    body: {
      challengeId,
      authEvent
    }
  })
  assert.equal(verifyResp.ok, true)
  assert.ok(verifyResp.data?.token)
  return verifyResp.data.token
}

async function createRunningGateway({
  registrationStore,
  adminStateStore: providedAdminStateStore,
  operatorPubkey,
  operatorNsecHex,
  policy = 'OPEN'
} = {}) {
  const logger = createTestLogger()
  const store = registrationStore || new MemoryRegistrationStore({
    ttlSeconds: 0,
    relayTtlSeconds: 0,
    mirrorTtlSeconds: 0,
    openJoinPoolTtlSeconds: 0
  })
  const adminStateStore = providedAdminStateStore || new MemoryGatewayAdminStateStore({ activityRetention: 5000 })

  const service = new PublicGatewayService({
    logger,
    registrationStore: store,
    adminStateStore,
    config: {
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://127.0.0.1',
      metrics: { enabled: false },
      rateLimit: { enabled: false },
      discovery: { enabled: false, openAccess: false },
      relay: {},
      dispatcher: {},
      features: {
        hyperbeeRelayEnabled: false,
        dispatcherEnabled: false,
        tokenEnforcementEnabled: false
      },
      blindPeer: { enabled: false },
      openJoin: {
        enabled: true,
        poolEntryTtlMs: 3600000,
        challengeTtlMs: 120000,
        authWindowSeconds: 300
      },
      registration: {
        sharedSecret: 'integration-shared-secret',
        cacheTtlSeconds: 0,
        mirrorTtlSeconds: 0,
        openJoinPoolTtlSeconds: 0,
        relayGcAfterMs: 0
      },
      gateway: {
        enableMulti: true,
        operatorPubkey,
        operatorNsecHex,
        policy,
        allowList: [],
        banList: [],
        inviteOnly: false,
        discoveryRelays: ['wss://relay.integration.example'],
        authJwtSecret: 'integration-jwt-secret',
        authTokenTtlSec: 3600,
        authChallengeTtlMs: 120000,
        authWindowSec: 300
      }
    }
  })

  // Avoid starting hyperswarm networking during HTTP API tests.
  service.connectionPool.initialize = async () => {}
  service.connectionPool.destroy = async () => {}

  await service.init()
  await service.start()

  const address = service.server?.address()
  if (!address || typeof address !== 'object') {
    throw new Error('failed-to-start-test-gateway')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    service,
    store,
    adminStateStore,
    baseUrl,
    async stop() {
      await service.stop()
    }
  }
}

test('GET /api/relays/:relayKey/status returns mirror freshness fields from registration', async () => {
  const operator = createKeypair()
  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex
  })

  try {
    const relayKey = 'd'.repeat(64)
    await gateway.store.upsertRelay(relayKey, {
      relayKey,
      relayCores: [
        { key: 'core-a', role: 'writer', length: 25 },
        { key: 'core-b', role: 'reader', length: 12 }
      ],
      updatedAt: 1700000123456,
      metadata: {
        latestViewLength: 40,
        writerMaterialUpdatedAt: 1700000123000,
        fastForward: {
          signedLength: 39
        },
        mirrorVersion: 3,
        isOpen: true,
        ownerPubkey: operator.publicKeyHex
      }
    })

    const status = await requestJson(gateway.baseUrl, `/api/relays/${relayKey}/status`)
    assert.equal(status.ok, true)
    assert.equal(status.data?.relayKey, relayKey)
    assert.equal(status.data?.source, 'registration')
    assert.equal(status.data?.latestViewLength, 40)
    assert.equal(status.data?.maxCoreLength, 25)
    assert.equal(status.data?.writerCount, 1)
    assert.equal(status.data?.fastForwardSignedLength, 39)
    assert.equal(status.data?.writerMaterialUpdatedAt, 1700000123000)
    assert.equal(status.data?.mirrorVersion, 3)
    assert.ok(typeof status.data?.coreRefsHash === 'string' && status.data.coreRefsHash.length === 64)
  } finally {
    await gateway.stop()
  }
})

test('invite redeem endpoint appends allow-list membership for invitee', async () => {
  const operator = createKeypair()
  const invitee = createKeypair()
  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    policy: 'CLOSED'
  })

  try {
    const operatorToken = await issueScopedToken(gateway.baseUrl, operator, 'gateway:operator')

    const createdInvite = await requestJson(gateway.baseUrl, '/api/gateway/invites', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operatorToken}`
      },
      body: {
        pubkey: invitee.publicKeyHex
      }
    })
    assert.equal(createdInvite.ok, true)
    const inviteToken = createdInvite.data?.invite?.inviteToken
    assert.ok(inviteToken)

    const inviteeToken = await issueScopedToken(gateway.baseUrl, invitee, 'gateway:invite-redeem')
    const redeem = await requestJson(gateway.baseUrl, '/api/gateway/invites/redeem', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${inviteeToken}`
      },
      body: {
        inviteToken
      }
    })
    assert.equal(redeem.ok, true)
    assert.equal(redeem.data?.allowListed, true)

    const allowList = await requestJson(gateway.baseUrl, '/api/gateway/allow-list', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${operatorToken}`
      }
    })
    assert.equal(allowList.ok, true)
    assert.ok(Array.isArray(allowList.data?.allowList))
    assert.ok(allowList.data.allowList.includes(invitee.publicKeyHex))
  } finally {
    await gateway.stop()
  }
})

test('POST /api/gateway/policy updates OPEN/CLOSED and invite-only settings', async () => {
  const operator = createKeypair()
  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    policy: 'OPEN'
  })

  try {
    const operatorToken = await issueScopedToken(gateway.baseUrl, operator, 'gateway:operator')
    const update = await requestJson(gateway.baseUrl, '/api/gateway/policy', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operatorToken}`
      },
      body: {
        policy: 'CLOSED',
        inviteOnly: true,
        discoveryRelays: ['wss://relay.alpha', 'wss://relay.beta', 'wss://relay.alpha']
      }
    })
    assert.equal(update.ok, true)
    assert.equal(update.data?.policy, 'CLOSED')
    assert.equal(update.data?.inviteOnly, true)
    assert.deepEqual(update.data?.discoveryRelays, ['wss://relay.alpha', 'wss://relay.beta'])

    const policy = await requestJson(gateway.baseUrl, '/api/gateway/policy')
    assert.equal(policy.ok, true)
    assert.equal(policy.data?.policy, 'CLOSED')
    assert.equal(policy.data?.inviteOnly, true)
    assert.deepEqual(policy.data?.discoveryRelays, ['wss://relay.alpha', 'wss://relay.beta'])
  } finally {
    await gateway.stop()
  }
})

test('admin auth session cookie can access admin overview + activity endpoints', async () => {
  const operator = createKeypair()
  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    policy: 'OPEN'
  })

  try {
    const challenge = await requestJson(gateway.baseUrl, '/api/auth/challenge', {
      method: 'POST',
      body: {
        pubkey: operator.publicKeyHex,
        scope: 'gateway:operator'
      }
    })
    assert.equal(challenge.ok, true)

    const authEvent = await signGatewayAuthEvent({
      privateKeyHex: operator.privateKeyHex,
      pubkey: operator.publicKeyHex,
      nonce: challenge.data?.nonce,
      scope: 'gateway:operator'
    })

    const verify = await requestJson(gateway.baseUrl, '/api/auth/verify', {
      method: 'POST',
      body: {
        challengeId: challenge.data?.challengeId,
        authEvent,
        adminSession: true
      }
    })
    assert.equal(verify.ok, true)
    const setCookie = verify.headers.get('set-cookie')
    assert.ok(setCookie)

    const overview = await requestJson(gateway.baseUrl, '/api/admin/overview', {
      method: 'GET',
      headers: {
        cookie: setCookie
      }
    })
    assert.equal(overview.ok, true)
    assert.equal(overview.data?.status, 'ok')
    assert.equal(typeof overview.data?.counts?.activeSessions, 'number')

    const policyUpdate = await requestJson(gateway.baseUrl, '/api/gateway/policy', {
      method: 'POST',
      headers: {
        cookie: setCookie
      },
      body: {
        policy: 'CLOSED',
        inviteOnly: true
      }
    })
    assert.equal(policyUpdate.ok, true)

    const activity = await requestJson(gateway.baseUrl, '/api/admin/activity?limit=20', {
      method: 'GET',
      headers: {
        cookie: setCookie
      }
    })
    assert.equal(activity.ok, true)
    assert.ok(Array.isArray(activity.data?.activity))
    assert.ok(activity.data.activity.some((entry) => entry.type === 'policy-update'))
  } finally {
    await gateway.stop()
  }
})

test('admin policy/invite state persists across service restart with shared admin store', async () => {
  const operator = createKeypair()
  const relayStore = new MemoryRegistrationStore({
    ttlSeconds: 0,
    relayTtlSeconds: 0,
    mirrorTtlSeconds: 0,
    openJoinPoolTtlSeconds: 0
  })
  const adminStateStore = new MemoryGatewayAdminStateStore({ activityRetention: 5000 })

  const first = await createRunningGateway({
    registrationStore: relayStore,
    adminStateStore,
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    policy: 'OPEN'
  })

  try {
    const operatorToken = await issueScopedToken(first.baseUrl, operator, 'gateway:operator')
    const allowAdd = await requestJson(first.baseUrl, '/api/gateway/allow-list', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operatorToken}`
      },
      body: {
        pubkey: 'e'.repeat(64)
      }
    })
    assert.equal(allowAdd.ok, true)

    const inviteCreate = await requestJson(first.baseUrl, '/api/gateway/invites', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operatorToken}`
      },
      body: {
        pubkey: 'f'.repeat(64)
      }
    })
    assert.equal(inviteCreate.ok, true)
  } finally {
    await first.stop()
  }

  const second = await createRunningGateway({
    registrationStore: relayStore,
    adminStateStore,
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    policy: 'OPEN'
  })

  try {
    const operatorToken = await issueScopedToken(second.baseUrl, operator, 'gateway:operator')
    const allowList = await requestJson(second.baseUrl, '/api/gateway/allow-list', {
      headers: {
        authorization: `Bearer ${operatorToken}`
      }
    })
    assert.equal(allowList.ok, true)
    assert.ok(allowList.data.allowList.includes('e'.repeat(64)))

    const invites = await requestJson(second.baseUrl, '/api/admin/invites', {
      headers: {
        authorization: `Bearer ${operatorToken}`
      }
    })
    assert.equal(invites.ok, true)
    assert.ok(Array.isArray(invites.data?.invites))
    assert.ok(invites.data.invites.some((entry) => entry.pubkey === 'f'.repeat(64)))
  } finally {
    await second.stop()
  }
})

test('admin auth refresh/logout lifecycle revokes refreshed bearer token', async () => {
  const operator = createKeypair()
  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex
  })

  try {
    const token = await issueScopedToken(gateway.baseUrl, operator, 'gateway:operator')
    const refresh = await requestJson(gateway.baseUrl, '/api/admin/auth/refresh', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`
      }
    })
    assert.equal(refresh.ok, true)
    const refreshedToken = refresh.data?.token
    assert.ok(refreshedToken)

    const logout = await requestJson(gateway.baseUrl, '/api/admin/auth/logout', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${refreshedToken}`
      }
    })
    assert.equal(logout.ok, true)

    const denied = await requestJson(gateway.baseUrl, '/api/admin/overview', {
      headers: {
        authorization: `Bearer ${refreshedToken}`
      }
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.status, 401)
  } finally {
    await gateway.stop()
  }
})
