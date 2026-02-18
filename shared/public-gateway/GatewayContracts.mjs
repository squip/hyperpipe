const GATEWAY_TAG_NAME = 'gateway';
const KIND_GATEWAY_EVENT = 30078;
const GATEWAY_EVENT_KIND_METADATA = 'hypertuna_gateway:metadata';
const GATEWAY_EVENT_KIND_INVITE = 'hypertuna_gateway:invite';
const GATEWAY_EVENT_KIND_JOIN_REQUEST = 'hypertuna_gateway:join_request';
const GATEWAY_POLICY_OPEN = 'OPEN';
const GATEWAY_POLICY_CLOSED = 'CLOSED';

function normalizeGatewayPolicy(value, fallback = GATEWAY_POLICY_OPEN) {
  if (typeof value !== 'string') return fallback;
  const upper = value.trim().toUpperCase();
  if (upper === GATEWAY_POLICY_OPEN || upper === GATEWAY_POLICY_CLOSED) return upper;
  return fallback;
}

function normalizeGatewayOrigin(value, { requireHttps = true } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (requireHttps) {
      if (parsed.protocol === 'http:') parsed.protocol = 'https:';
      if (parsed.protocol !== 'https:') return null;
    } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch (_err) {
    return null;
  }
}

function normalizePubkeyHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeGatewayTag(tag) {
  if (!Array.isArray(tag) || tag[0] !== GATEWAY_TAG_NAME) return null;
  const origin = normalizeGatewayOrigin(tag[1], { requireHttps: true });
  if (!origin) return null;
  const operatorPubkey = normalizePubkeyHex(tag[2]);
  if (!operatorPubkey) return null;
  const policy = normalizeGatewayPolicy(tag[3], GATEWAY_POLICY_OPEN);
  return {
    origin,
    operatorPubkey,
    policy
  };
}

function dedupeGatewayList(gateways = []) {
  const deduped = [];
  const seen = new Set();
  for (const entry of gateways) {
    const origin = normalizeGatewayOrigin(entry?.origin, { requireHttps: true });
    const operatorPubkey = normalizePubkeyHex(entry?.operatorPubkey);
    if (!origin || !operatorPubkey) continue;
    if (seen.has(origin)) continue;
    seen.add(origin);
    deduped.push({
      origin,
      operatorPubkey,
      policy: normalizeGatewayPolicy(entry?.policy, GATEWAY_POLICY_OPEN)
    });
  }
  return deduped;
}

function parseGatewayTags(tags = []) {
  const parsed = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const normalized = normalizeGatewayTag(tag);
    if (!normalized) continue;
    parsed.push(normalized);
  }
  return dedupeGatewayList(parsed);
}

function buildGatewayTag(gateway) {
  const origin = normalizeGatewayOrigin(gateway?.origin, { requireHttps: true });
  const operatorPubkey = normalizePubkeyHex(gateway?.operatorPubkey);
  if (!origin || !operatorPubkey) return null;
  const policy = normalizeGatewayPolicy(gateway?.policy, GATEWAY_POLICY_OPEN);
  return [GATEWAY_TAG_NAME, origin, operatorPubkey, policy];
}

function buildGatewayTags(gateways = []) {
  const tags = [];
  for (const gateway of dedupeGatewayList(gateways)) {
    const tag = buildGatewayTag(gateway);
    if (tag) tags.push(tag);
  }
  return tags;
}

function mergeGatewayTags(existingTags = [], gateways = []) {
  const nextTags = [];
  for (const tag of Array.isArray(existingTags) ? existingTags : []) {
    if (Array.isArray(tag) && tag[0] === GATEWAY_TAG_NAME) continue;
    nextTags.push(tag);
  }
  return [...nextTags, ...buildGatewayTags(gateways)];
}

function parseDTag(tags = []) {
  if (!Array.isArray(tags)) return null;
  const entry = tags.find((tag) => Array.isArray(tag) && tag[0] === 'd' && typeof tag[1] === 'string');
  return entry ? entry[1] : null;
}

function parseHTag(tags = []) {
  if (!Array.isArray(tags)) return null;
  const entry = tags.find((tag) => Array.isArray(tag) && tag[0] === 'h' && typeof tag[1] === 'string');
  return entry ? entry[1] : null;
}

function parseRTags(tags = []) {
  if (!Array.isArray(tags)) return [];
  const relays = [];
  const seen = new Set();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'r') continue;
    const relay = typeof tag[1] === 'string' ? tag[1].trim() : '';
    if (!relay || seen.has(relay)) continue;
    seen.add(relay);
    relays.push(relay);
  }
  return relays;
}

function parseAllowList(tags = []) {
  if (!Array.isArray(tags)) return [];
  const allowTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'allow-list');
  if (!allowTag) return [];
  const allowList = [];
  const seen = new Set();
  for (const value of allowTag.slice(1)) {
    const pubkey = normalizePubkeyHex(value);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    allowList.push(pubkey);
  }
  return allowList;
}

function parseGatewayMetadataEvent(event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT || !Array.isArray(event.tags)) return null;
  const h = parseHTag(event.tags);
  if (h !== GATEWAY_EVENT_KIND_METADATA) return null;
  const d = parseDTag(event.tags);
  const operatorTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'operator' && typeof tag[1] === 'string');
  const policyTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'policy' && typeof tag[1] === 'string');
  const operatorPubkey = normalizePubkeyHex(operatorTag?.[1]) || normalizePubkeyHex(event.pubkey);
  const originFromD = typeof d === 'string' && d.startsWith('hypertuna_gateway:')
    ? d.slice('hypertuna_gateway:'.length)
    : null;
  const origin = normalizeGatewayOrigin(originFromD, { requireHttps: true });
  if (!origin || !operatorPubkey) return null;
  return {
    id: event.id || null,
    pubkey: normalizePubkeyHex(event.pubkey) || null,
    createdAt: Number.isFinite(event.created_at) ? Number(event.created_at) : null,
    origin,
    operatorPubkey,
    policy: normalizeGatewayPolicy(policyTag?.[1], GATEWAY_POLICY_OPEN),
    allowList: parseAllowList(event.tags),
    discoveryRelays: parseRTags(event.tags),
    content: typeof event.content === 'string' ? event.content : ''
  };
}

function parseGatewayInviteEvent(event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT || !Array.isArray(event.tags)) return null;
  const h = parseHTag(event.tags);
  if (h !== GATEWAY_EVENT_KIND_INVITE) return null;
  const d = parseDTag(event.tags);
  const originFromD = typeof d === 'string' && d.startsWith('hypertuna_gateway:')
    ? d.slice('hypertuna_gateway:'.length)
    : null;
  const origin = normalizeGatewayOrigin(originFromD, { requireHttps: true });
  const inviteeTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string');
  const inviteTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'INVITE' && typeof tag[1] === 'string');
  const inviteePubkey = normalizePubkeyHex(inviteeTag?.[1]);
  if (!origin || !inviteePubkey || !inviteTag?.[1]) return null;
  return {
    id: event.id || null,
    origin,
    inviteePubkey,
    inviteToken: inviteTag[1],
    operatorPubkey: normalizePubkeyHex(event.pubkey) || null,
    createdAt: Number.isFinite(event.created_at) ? Number(event.created_at) : null
  };
}

function parseGatewayJoinRequestEvent(event) {
  if (!event || event.kind !== KIND_GATEWAY_EVENT || !Array.isArray(event.tags)) return null;
  const h = parseHTag(event.tags);
  if (h !== GATEWAY_EVENT_KIND_JOIN_REQUEST) return null;
  const d = parseDTag(event.tags);
  const originFromD = typeof d === 'string' && d.startsWith('hypertuna_gateway:')
    ? d.slice('hypertuna_gateway:'.length)
    : null;
  const origin = normalizeGatewayOrigin(originFromD, { requireHttps: true });
  const requesterTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string');
  const requesterPubkey = normalizePubkeyHex(requesterTag?.[1]) || normalizePubkeyHex(event.pubkey);
  if (!origin || !requesterPubkey) return null;
  return {
    id: event.id || null,
    origin,
    requesterPubkey,
    content: typeof event.content === 'string' ? event.content : '',
    createdAt: Number.isFinite(event.created_at) ? Number(event.created_at) : null
  };
}

export {
  GATEWAY_TAG_NAME,
  KIND_GATEWAY_EVENT,
  GATEWAY_EVENT_KIND_METADATA,
  GATEWAY_EVENT_KIND_INVITE,
  GATEWAY_EVENT_KIND_JOIN_REQUEST,
  GATEWAY_POLICY_OPEN,
  GATEWAY_POLICY_CLOSED,
  normalizeGatewayPolicy,
  normalizeGatewayOrigin,
  normalizeGatewayTag,
  parseGatewayTags,
  buildGatewayTag,
  buildGatewayTags,
  mergeGatewayTags,
  dedupeGatewayList,
  parseGatewayMetadataEvent,
  parseGatewayInviteEvent,
  parseGatewayJoinRequestEvent
};
