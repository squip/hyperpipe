function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizePubkeyList(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const pubkey = normalizePubkey(raw);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

function normalizePolicyMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'allow-list' || normalized === 'allowlist' || normalized === 'closed') {
    return 'allow-list';
  }
  return 'open';
}

class GatewayPolicyService {
  constructor({ config = {}, logger = console } = {}) {
    this.logger = logger;
    this.enabled = config?.enabled === true;
    this.mode = normalizePolicyMode(config?.mode);
    this.allowList = new Set(normalizePubkeyList(config?.allowList));
    this.banList = new Set(normalizePubkeyList(config?.banList));
    this.relayCreatorMap = new Map();
  }

  getSnapshot() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      allowList: Array.from(this.allowList.values()),
      banList: Array.from(this.banList.values())
    };
  }

  isBanned(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) return false;
    return this.banList.has(normalized);
  }

  isAllowListed(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) return false;
    return this.allowList.has(normalized);
  }

  canRegisterRelay({ creatorPubkey = null } = {}) {
    const creator = normalizePubkey(creatorPubkey);
    if (this.enabled && creator && this.banList.has(creator)) {
      return { allowed: false, reason: 'creator-banned', creatorPubkey: creator };
    }

    if (!this.enabled || this.mode === 'open') {
      return { allowed: true, reason: this.enabled ? 'policy-open' : 'policy-disabled', creatorPubkey: creator };
    }

    if (!creator) {
      return { allowed: false, reason: 'missing-creator-pubkey', creatorPubkey: null };
    }

    if (!this.allowList.has(creator)) {
      return { allowed: false, reason: 'creator-not-allow-listed', creatorPubkey: creator };
    }

    return { allowed: true, reason: 'creator-allow-listed', creatorPubkey: creator };
  }

  canIssueCreatorCredential({ creatorPubkey = null } = {}) {
    return this.canRegisterRelay({ creatorPubkey });
  }

  noteRelayCreator(relayKey, creatorPubkey) {
    const normalizedRelayKey = typeof relayKey === 'string' && relayKey.trim()
      ? relayKey.trim().toLowerCase()
      : null;
    const normalizedCreator = normalizePubkey(creatorPubkey);
    if (!normalizedRelayKey || !normalizedCreator) return;
    this.relayCreatorMap.set(normalizedRelayKey, normalizedCreator);
  }

  getRelayCreator(relayKey) {
    const normalizedRelayKey = typeof relayKey === 'string' && relayKey.trim()
      ? relayKey.trim().toLowerCase()
      : null;
    if (!normalizedRelayKey) return null;
    return this.relayCreatorMap.get(normalizedRelayKey) || null;
  }

  removeRelay(relayKey) {
    const normalizedRelayKey = typeof relayKey === 'string' && relayKey.trim()
      ? relayKey.trim().toLowerCase()
      : null;
    if (!normalizedRelayKey) return;
    this.relayCreatorMap.delete(normalizedRelayKey);
  }

  listRelayKeysForCreator(creatorPubkey) {
    const normalizedCreator = normalizePubkey(creatorPubkey);
    if (!normalizedCreator) return [];
    const out = [];
    for (const [relayKey, creator] of this.relayCreatorMap.entries()) {
      if (creator === normalizedCreator) out.push(relayKey);
    }
    return out;
  }
}

export {
  GatewayPolicyService,
  normalizePubkey,
  normalizePolicyMode
};

export default GatewayPolicyService;
