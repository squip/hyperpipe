import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import GatewayNostrProfileService from '../src/GatewayNostrProfileService.mjs';
import PublicGatewayService from '../src/PublicGatewayService.mjs';
import MemoryRegistrationStore from '../src/stores/MemoryRegistrationStore.mjs';
import MemoryGatewayAdminStateStore from '../src/stores/MemoryGatewayAdminStateStore.mjs';
import { createKeypair, signGatewayAuthEvent } from '../test-support/gateway-auth-helpers.mjs';

function createTestLogger() {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger;
    }
  };
  return logger;
}

function createProfileEvent({ pubkey, createdAt, metadata }) {
  return {
    id: `${pubkey.slice(0, 12)}-${createdAt}`,
    pubkey,
    kind: 0,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify(metadata || {})
  };
}

function buildHexPubkeyFromNumber(value) {
  const numeric = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return numeric.toString(16).padStart(64, '0').slice(-64);
}

function matchesFilter(event, filter = {}, { supportsSearch = true } = {}) {
  if (!event || !filter) return false;
  if (Array.isArray(filter.kinds) && filter.kinds.length && !filter.kinds.includes(event.kind)) return false;
  if (Array.isArray(filter.authors) && filter.authors.length && !filter.authors.includes(event.pubkey)) return false;
  if (Number.isFinite(filter.since) && event.created_at < filter.since) return false;
  if (Number.isFinite(filter.until) && event.created_at > filter.until) return false;
  if (supportsSearch && typeof filter.search === 'string' && filter.search.trim()) {
    const query = filter.search.trim().toLowerCase();
    let metadata = {};
    try {
      metadata = JSON.parse(String(event.content || '{}')) || {};
    } catch {
      metadata = {};
    }
    const haystack = [
      String(metadata?.display_name || ''),
      String(metadata?.name || ''),
      String(metadata?.nip05 || ''),
      String(event.pubkey || '')
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

async function createMockNostrRelay(events = [], { supportsSearch = true } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  server.on('connection', (socket) => {
    socket.on('message', (payload) => {
      let frame = null;
      try {
        frame = JSON.parse(String(payload || ''));
      } catch (_error) {
        return;
      }
      if (!Array.isArray(frame) || frame.length < 2) return;
      if (frame[0] !== 'REQ') return;

      const subscriptionId = frame[1];
      const filters = frame.slice(2).filter((entry) => entry && typeof entry === 'object');

      const emitted = new Set();
      for (const filter of filters) {
        const matched = events
          .filter((event) => matchesFilter(event, filter, { supportsSearch }))
          .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0));
        const limited = Number.isFinite(filter?.limit) && filter.limit > 0
          ? matched.slice(0, Math.trunc(filter.limit))
          : matched;

        for (const event of limited) {
          if (emitted.has(event.id)) continue;
          emitted.add(event.id);
          socket.send(JSON.stringify(['EVENT', subscriptionId, event]));
        }
      }

      socket.send(JSON.stringify(['EOSE', subscriptionId]));
    });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('relay-start-failed');
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
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
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function issueScopedToken(baseUrl, keypair, scope) {
  const challengeResp = await requestJson(baseUrl, '/api/auth/challenge', {
    method: 'POST',
    body: {
      pubkey: keypair.publicKeyHex,
      scope
    }
  });
  assert.equal(challengeResp.ok, true);

  const authEvent = await signGatewayAuthEvent({
    privateKeyHex: keypair.privateKeyHex,
    pubkey: keypair.publicKeyHex,
    nonce: challengeResp.data?.nonce,
    scope
  });

  const verifyResp = await requestJson(baseUrl, '/api/auth/verify', {
    method: 'POST',
    body: {
      challengeId: challengeResp.data?.challengeId,
      authEvent
    }
  });
  assert.equal(verifyResp.ok, true);
  assert.ok(verifyResp.data?.token);
  return verifyResp.data.token;
}

async function createRunningGateway({ operatorPubkey, operatorNsecHex, discoveryRelays = [] } = {}) {
  const logger = createTestLogger();
  const store = new MemoryRegistrationStore({
    ttlSeconds: 0,
    relayTtlSeconds: 0,
    mirrorTtlSeconds: 0,
    openJoinPoolTtlSeconds: 0
  });
  const adminStateStore = new MemoryGatewayAdminStateStore({ activityRetention: 5000 });

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
        cacheTtlSeconds: 0,
        mirrorTtlSeconds: 0,
        openJoinPoolTtlSeconds: 0,
        relayGcAfterMs: 0
      },
      gateway: {
        enableMulti: true,
        operatorPubkey,
        operatorNsecHex,
        policy: 'OPEN',
        allowList: [],
        banList: [],
        inviteOnly: false,
        discoveryRelays,
        authJwtSecret: 'profile-search-jwt-secret',
        authTokenTtlSec: 3600,
        authChallengeTtlMs: 120000,
        authWindowSec: 300,
        adminProfileQueryTimeoutMs: 1200,
        adminProfileSearchLimit: 10,
        adminProfileCacheTtlSec: 600
      }
    }
  });

  service.connectionPool.initialize = async () => {};
  service.connectionPool.destroy = async () => {};

  await service.init();
  await service.start();

  const address = service.server?.address();
  if (!address || typeof address !== 'object') {
    throw new Error('failed-to-start-profile-test-gateway');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async stop() {
      await service.stop();
    }
  };
}

test('GatewayNostrProfileService resolves and searches relay-backed profile metadata', async () => {
  const alice = createKeypair().publicKeyHex;
  const bob = createKeypair().publicKeyHex;
  const relay = await createMockNostrRelay([
    createProfileEvent({
      pubkey: alice,
      createdAt: 1_730_000_101,
      metadata: {
        display_name: 'Alice Harbor',
        name: 'alice',
        nip05: 'alice@example.com',
        picture: 'https://example.com/alice.png'
      }
    }),
    createProfileEvent({
      pubkey: bob,
      createdAt: 1_730_000_102,
      metadata: {
        display_name: 'Bob Nautical',
        name: 'bob',
        nip05: 'bob@example.com'
      }
    })
  ]);

  const service = new GatewayNostrProfileService({
    logger: createTestLogger(),
    relayUrls: [relay.url],
    queryTimeoutMs: 1500,
    cacheTtlSec: 600,
    defaultSearchLimit: 10
  });

  try {
    const resolvedFirst = await service.resolvePubkeys([alice, bob]);
    assert.equal(resolvedFirst.profiles.length, 2);
    assert.equal(resolvedFirst.missing.length, 0);
    assert.equal(resolvedFirst.sources.relays, 2);

    const resolvedSecond = await service.resolvePubkeys([alice]);
    assert.equal(resolvedSecond.profiles.length, 1);
    assert.equal(resolvedSecond.sources.cache, 1);

    const searchedByName = await service.searchProfiles('alice', 5);
    assert.equal(searchedByName.profiles.length > 0, true);
    assert.equal(searchedByName.profiles[0]?.pubkey, alice);

    const searchedByNip05 = await service.searchProfiles('bob@example.com', 5);
    assert.equal(searchedByNip05.profiles.length > 0, true);
    assert.equal(searchedByNip05.profiles[0]?.pubkey, bob);
  } finally {
    await relay.stop();
  }
});

test('GatewayNostrProfileService search avoids pubkey-noise for human text queries', async () => {
  const deadPubkey = 'dead'.repeat(16);
  const beefPubkey = 'beef'.repeat(16);
  const relay = await createMockNostrRelay([
    createProfileEvent({
      pubkey: deadPubkey,
      createdAt: 1_730_000_301,
      metadata: {
        display_name: 'Harbor Operator',
        name: 'harbor'
      }
    }),
    createProfileEvent({
      pubkey: beefPubkey,
      createdAt: 1_730_000_302,
      metadata: {
        display_name: 'Generic User',
        name: 'generic'
      }
    })
  ]);

  const service = new GatewayNostrProfileService({
    logger: createTestLogger(),
    relayUrls: [relay.url],
    queryTimeoutMs: 1500,
    cacheTtlSec: 600,
    defaultSearchLimit: 10
  });

  try {
    const humanQuery = await service.searchProfiles('beef', 10);
    assert.equal(humanQuery.profiles.length, 0);

    const pubkeyQuery = await service.searchProfiles('beefbeefbeefbeef', 10);
    assert.equal(pubkeyQuery.profiles.length > 0, true);
    assert.equal(pubkeyQuery.profiles[0]?.pubkey, beefPubkey);
  } finally {
    await relay.stop();
  }
});

test('GatewayNostrProfileService uses participant index candidates when relay text search is weak', async () => {
  const targetPubkey = createKeypair().publicKeyHex;
  const participantAuthor = buildHexPubkeyFromNumber(9_999);
  const noiseProfiles = Array.from({ length: 180 }).map((_, index) =>
    createProfileEvent({
      pubkey: buildHexPubkeyFromNumber(index + 1),
      createdAt: 1_730_100_000 + index,
      metadata: {
        display_name: `Noise ${index + 1}`,
        name: `noise-${index + 1}`
      }
    })
  );
  const targetProfile = createProfileEvent({
    pubkey: targetPubkey,
    createdAt: 1_720_000_000,
    metadata: {
      display_name: 'Captain Target',
      name: 'captain-target',
      nip05: 'captain@hypertuna.com'
    }
  });
  const participantEvent = {
    id: `participant-${Date.now()}`,
    pubkey: participantAuthor,
    kind: 39002,
    created_at: 1_730_200_000,
    tags: [
      ['h', 'group:example'],
      ['i', 'hypertuna:relay'],
      ['p', targetPubkey]
    ],
    content: ''
  };
  const relay = await createMockNostrRelay(
    [...noiseProfiles, targetProfile, participantEvent],
    { supportsSearch: false }
  );

  const service = new GatewayNostrProfileService({
    logger: createTestLogger(),
    relayUrls: [relay.url],
    queryTimeoutMs: 1500,
    cacheTtlSec: 600,
    defaultSearchLimit: 8,
    participantEventLimit: 200,
    candidateResolveLimit: 240
  });

  try {
    const search = await service.searchProfiles('captain', 8);
    assert.equal(search.profiles.length > 0, true);
    assert.equal(search.profiles[0]?.pubkey, targetPubkey);
    assert.equal(Number(search.sources?.local || 0) >= 1, true);
  } finally {
    await relay.stop();
  }
});

test('admin profile resolve/search endpoints require operator scope and return normalized payloads', async () => {
  const operator = createKeypair();
  const invitee = createKeypair().publicKeyHex;
  const relay = await createMockNostrRelay([
    createProfileEvent({
      pubkey: invitee,
      createdAt: 1_730_001_200,
      metadata: {
        display_name: 'Invitee User',
        name: 'invitee',
        nip05: 'invitee@example.com',
        picture: 'https://example.com/invitee.png'
      }
    })
  ]);

  const gateway = await createRunningGateway({
    operatorPubkey: operator.publicKeyHex,
    operatorNsecHex: operator.privateKeyHex,
    discoveryRelays: [relay.url]
  });

  try {
    const unauthorized = await requestJson(gateway.baseUrl, '/api/admin/profiles/search?q=invitee');
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.status, 401);

    const token = await issueScopedToken(gateway.baseUrl, operator, 'gateway:operator');

    const search = await requestJson(gateway.baseUrl, '/api/admin/profiles/search?q=invitee&limit=5', {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(search.ok, true);
    assert.equal(search.data?.status, 'ok');
    assert.equal(search.data?.query, 'invitee');
    assert.equal(Array.isArray(search.data?.profiles), true);
    assert.equal(search.data.profiles[0]?.pubkey, invitee);
    assert.equal(typeof search.data?.profiles[0]?.displayName, 'string');

    const defaultLimitSearch = await requestJson(gateway.baseUrl, '/api/admin/profiles/search?q=invitee', {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    assert.equal(defaultLimitSearch.ok, true);
    assert.equal(defaultLimitSearch.data?.limit, 10);

    const resolve = await requestJson(
      gateway.baseUrl,
      `/api/admin/profiles/resolve?pubkeys=${invitee},${'0'.repeat(64)}`,
      {
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    );
    assert.equal(resolve.ok, true);
    assert.equal(resolve.data?.status, 'ok');
    assert.equal(Array.isArray(resolve.data?.profiles), true);
    assert.equal(resolve.data.profiles.some((entry) => entry.pubkey === invitee), true);
    assert.equal(Array.isArray(resolve.data?.missing), true);
    assert.equal(resolve.data.missing.includes('0'.repeat(64)), true);
  } finally {
    await gateway.stop();
    await relay.stop();
  }
});
