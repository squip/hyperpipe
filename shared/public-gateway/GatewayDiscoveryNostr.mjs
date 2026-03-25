const GATEWAY_ANNOUNCEMENT_KIND = 30078;
const GATEWAY_ANNOUNCEMENT_TAG = 'hyperpipe-public-gateway';
const DEFAULT_GATEWAY_DISCOVERY_RELAYS = Object.freeze([
  'wss://relay.damus.io/',
  'wss://relay.primal.net/',
  'wss://nos.lol/',
  'wss://hypertuna.com/relay'
]);
const DEFAULT_TTL_SECONDS = 60;

function normalizeRelayUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function normalizeHttpOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function readTag(tags = [], name) {
  const found = tags.find((tag) => Array.isArray(tag) && tag[0] === name);
  return typeof found?.[1] === 'string' ? found[1].trim() : null;
}

function readAllTags(tags = [], name) {
  return (Array.isArray(tags) ? tags : [])
    .filter((tag) => Array.isArray(tag) && tag[0] === name && typeof tag[1] === 'string')
    .map((tag) => String(tag[1]).trim())
    .filter(Boolean);
}

function parseIntTag(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function isFresh(createdAtSeconds, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()) {
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return false;
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.round(ttlSeconds) : DEFAULT_TTL_SECONDS;
  return (createdAtSeconds * 1000) + (ttl * 1000) > now;
}

function buildGatewayAnnouncementEventTemplate({
  gatewayId,
  httpOrigin,
  wsOrigin = null,
  displayName = null,
  region = null,
  secretUrl = null,
  secretHash = null,
  sharedSecretVersion = null,
  relayKey = null,
  relayDiscoveryKey = null,
  relayReplicationTopic = null,
  defaultTokenTtl = null,
  tokenRefreshWindowSeconds = null,
  capabilities = [],
  openAccess = true,
  authMethod = null,
  hostPolicy = null,
  memberDelegationMode = null,
  operatorPubkey = null,
  wotRootPubkey = null,
  wotMaxDepth = null,
  wotMinFollowersDepth2 = null,
  ttlSeconds = DEFAULT_TTL_SECONDS
} = {}) {
  const normalizedGatewayId =
    typeof gatewayId === 'string' && gatewayId.trim()
      ? gatewayId.trim().toLowerCase()
      : null;
  const normalizedHttpOrigin = normalizeHttpOrigin(httpOrigin);
  if (!normalizedGatewayId || !normalizedHttpOrigin) {
    throw new Error('buildGatewayAnnouncementEventTemplate requires gatewayId and httpOrigin');
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const tags = [
    ['d', normalizedGatewayId],
    ['t', GATEWAY_ANNOUNCEMENT_TAG],
    ['gateway-id', normalizedGatewayId],
    ['http', normalizedHttpOrigin],
    ['open-access', openAccess ? '1' : '0'],
    ['ttl', String(parseIntTag(ttlSeconds, DEFAULT_TTL_SECONDS))]
  ];

  const normalizedWsOrigin = normalizeRelayUrl(wsOrigin);
  if (normalizedWsOrigin) tags.push(['ws', normalizedWsOrigin]);
  if (typeof displayName === 'string' && displayName.trim()) tags.push(['name', displayName.trim()]);
  if (typeof region === 'string' && region.trim()) tags.push(['region', region.trim()]);
  if (typeof secretUrl === 'string' && secretUrl.trim()) tags.push(['secret', secretUrl.trim()]);
  if (typeof secretHash === 'string' && secretHash.trim()) tags.push(['secret-hash', secretHash.trim()]);
  if (typeof sharedSecretVersion === 'string' && sharedSecretVersion.trim()) {
    tags.push(['secret-version', sharedSecretVersion.trim()]);
  }
  if (typeof relayKey === 'string' && relayKey.trim()) tags.push(['relay-key', relayKey.trim()]);
  if (typeof relayDiscoveryKey === 'string' && relayDiscoveryKey.trim()) {
    tags.push(['relay-discovery-key', relayDiscoveryKey.trim()]);
  }
  if (typeof relayReplicationTopic === 'string' && relayReplicationTopic.trim()) {
    tags.push(['relay-replication-topic', relayReplicationTopic.trim()]);
  }
  if (Number.isFinite(defaultTokenTtl) && defaultTokenTtl > 0) {
    tags.push(['token-ttl', String(Math.round(defaultTokenTtl))]);
  }
  if (Number.isFinite(tokenRefreshWindowSeconds) && tokenRefreshWindowSeconds > 0) {
    tags.push(['token-refresh-window', String(Math.round(tokenRefreshWindowSeconds))]);
  }
  if (typeof authMethod === 'string' && authMethod.trim()) tags.push(['auth-method', authMethod.trim()]);
  if (typeof hostPolicy === 'string' && hostPolicy.trim()) tags.push(['host-policy', hostPolicy.trim()]);
  if (typeof memberDelegationMode === 'string' && memberDelegationMode.trim()) {
    tags.push(['member-delegation', memberDelegationMode.trim()]);
  }
  const normalizedOperatorPubkey = normalizePubkey(operatorPubkey);
  if (normalizedOperatorPubkey) tags.push(['operator-pubkey', normalizedOperatorPubkey]);
  const normalizedWotRootPubkey = normalizePubkey(wotRootPubkey);
  if (normalizedWotRootPubkey) tags.push(['wot-root-pubkey', normalizedWotRootPubkey]);
  if (Number.isFinite(wotMaxDepth) && Number(wotMaxDepth) > 0) {
    tags.push(['wot-max-depth', String(Math.round(Number(wotMaxDepth)))]);
  }
  if (Number.isFinite(wotMinFollowersDepth2) && Number(wotMinFollowersDepth2) >= 0) {
    tags.push(['wot-min-followers-depth2', String(Math.round(Number(wotMinFollowersDepth2)))]);
  }

  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    if (typeof capability !== 'string') continue;
    const normalized = capability.trim();
    if (!normalized) continue;
    tags.push(['capability', normalized]);
  }

  const content = JSON.stringify({
    v: 1,
    gatewayId: normalizedGatewayId,
    httpOrigin: normalizedHttpOrigin,
    openAccess: openAccess === true,
    authMethod: typeof authMethod === 'string' && authMethod.trim() ? authMethod.trim() : null,
    hostPolicy: typeof hostPolicy === 'string' && hostPolicy.trim() ? hostPolicy.trim() : null,
    memberDelegationMode: typeof memberDelegationMode === 'string' && memberDelegationMode.trim()
      ? memberDelegationMode.trim()
      : null
  });

  return {
    kind: GATEWAY_ANNOUNCEMENT_KIND,
    created_at: createdAt,
    tags,
    content
  };
}

function parseGatewayAnnouncementEvent(event, { now = Date.now() } = {}) {
  if (!event || typeof event !== 'object') return null;
  if (Number(event.kind) !== GATEWAY_ANNOUNCEMENT_KIND) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  if (!tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === GATEWAY_ANNOUNCEMENT_TAG)) {
    return null;
  }

  const gatewayId =
    readTag(tags, 'gateway-id')
    || readTag(tags, 'd');
  const httpOrigin = normalizeHttpOrigin(readTag(tags, 'http'));
  if (!gatewayId || !httpOrigin) return null;

  const ttlSeconds = parseIntTag(readTag(tags, 'ttl'), DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const openAccessRaw = readTag(tags, 'open-access');
  const openAccess = openAccessRaw !== '0' && openAccessRaw !== 'false';
  const createdAtSeconds = Number.isFinite(event.created_at) ? Number(event.created_at) : 0;
  const fresh = isFresh(createdAtSeconds, ttlSeconds, now);
  const expiresAt = createdAtSeconds > 0 ? (createdAtSeconds * 1000) + (ttlSeconds * 1000) : null;

  return {
    gatewayId: String(gatewayId).toLowerCase(),
    publicUrl: httpOrigin,
    wsUrl: normalizeRelayUrl(readTag(tags, 'ws')) || '',
    secretUrl: readTag(tags, 'secret') || '',
    secretHash: readTag(tags, 'secret-hash') || '',
    sharedSecretVersion: readTag(tags, 'secret-version') || '',
    displayName: readTag(tags, 'name') || '',
    region: readTag(tags, 'region') || '',
    relayHyperbeeKey: readTag(tags, 'relay-key') || '',
    relayDiscoveryKey: readTag(tags, 'relay-discovery-key') || '',
    relayReplicationTopic: readTag(tags, 'relay-replication-topic') || '',
    defaultTokenTtl: parseIntTag(readTag(tags, 'token-ttl'), null),
    tokenRefreshWindowSeconds: parseIntTag(readTag(tags, 'token-refresh-window'), null),
    authMethod: readTag(tags, 'auth-method') || '',
    hostPolicy: readTag(tags, 'host-policy') || '',
    memberDelegationMode: readTag(tags, 'member-delegation') || '',
    operatorPubkey: normalizePubkey(readTag(tags, 'operator-pubkey')) || '',
    wotRootPubkey: normalizePubkey(readTag(tags, 'wot-root-pubkey')) || '',
    wotMaxDepth: parseIntTag(readTag(tags, 'wot-max-depth'), null),
    wotMinFollowersDepth2: parseIntTag(readTag(tags, 'wot-min-followers-depth2'), 0),
    capabilities: readAllTags(tags, 'capability'),
    openAccess,
    ttl: ttlSeconds,
    timestamp: createdAtSeconds > 0 ? createdAtSeconds * 1000 : Date.now(),
    lastSeenAt: now,
    expiresAt,
    isExpired: !fresh,
    source: 'nostr',
    eventId: typeof event.id === 'string' ? event.id : null,
    eventPubkey: typeof event.pubkey === 'string' ? event.pubkey : null
  };
}

function normalizeNostrRelayList(relays = DEFAULT_GATEWAY_DISCOVERY_RELAYS) {
  const out = [];
  const seen = new Set();
  for (const relay of Array.isArray(relays) ? relays : []) {
    const normalized = normalizeRelayUrl(relay);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export {
  DEFAULT_GATEWAY_DISCOVERY_RELAYS,
  DEFAULT_TTL_SECONDS,
  GATEWAY_ANNOUNCEMENT_KIND,
  GATEWAY_ANNOUNCEMENT_TAG,
  buildGatewayAnnouncementEventTemplate,
  isFresh as isGatewayAnnouncementFresh,
  normalizeHttpOrigin,
  normalizeNostrRelayList,
  parseGatewayAnnouncementEvent
};
