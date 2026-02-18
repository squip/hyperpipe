function normalizePubkey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizePolicy(value) {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return upper === 'CLOSED' ? 'CLOSED' : 'OPEN';
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

class GatewayPolicyService {
  constructor({ config = {}, logger = console } = {}) {
    this.logger = logger;
    this.operatorPubkey = normalizePubkey(config?.operatorPubkey) || null;
    this.operatorNsecHex = typeof config?.operatorNsecHex === 'string'
      ? config.operatorNsecHex.trim()
      : null;
    this.policy = normalizePolicy(config?.policy);
    this.allowList = new Set(normalizePubkeyList(config?.allowList));
    this.banList = new Set(normalizePubkeyList(config?.banList));
    this.discoveryRelays = Array.isArray(config?.discoveryRelays)
      ? config.discoveryRelays.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    this.inviteOnly = config?.inviteOnly === true;
  }

  getSnapshot() {
    return {
      operatorPubkey: this.operatorPubkey,
      operatorNsecHex: this.operatorNsecHex,
      policy: this.policy,
      allowList: Array.from(this.allowList.values()),
      banList: Array.from(this.banList.values()),
      discoveryRelays: [...this.discoveryRelays],
      inviteOnly: this.inviteOnly
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

  canRegisterRelay({ adminPubkey = null } = {}) {
    const normalizedAdmin = normalizePubkey(adminPubkey);
    if (normalizedAdmin && this.banList.has(normalizedAdmin)) {
      return { allowed: false, reason: 'admin-banned' };
    }
    if (this.policy === 'OPEN') {
      return { allowed: true, reason: 'open-policy' };
    }
    if (!normalizedAdmin) {
      return { allowed: false, reason: 'missing-admin-pubkey' };
    }
    if (!this.allowList.has(normalizedAdmin)) {
      return { allowed: false, reason: 'admin-not-allow-listed' };
    }
    return { allowed: true, reason: 'closed-policy-allow-listed' };
  }

  canAccessRelay({ pubkey = null, relayAdminPubkey = null } = {}) {
    const requester = normalizePubkey(pubkey);
    if (!requester) {
      return { allowed: false, reason: 'missing-requester-pubkey' };
    }
    if (this.banList.has(requester)) {
      return { allowed: false, reason: 'requester-banned' };
    }
    if (this.policy === 'OPEN') {
      return { allowed: true, reason: 'open-policy' };
    }
    const relayAdmin = normalizePubkey(relayAdminPubkey);
    if (relayAdmin && this.allowList.has(relayAdmin)) {
      return { allowed: true, reason: 'closed-policy-relay-admin-allow-listed' };
    }
    if (this.allowList.has(requester)) {
      return { allowed: true, reason: 'closed-policy-requester-allow-listed' };
    }
    return { allowed: false, reason: 'closed-policy-denied' };
  }

  setPolicy(policy) {
    this.policy = normalizePolicy(policy);
    return this.policy;
  }

  setInviteOnly(inviteOnly) {
    this.inviteOnly = inviteOnly === true;
    return this.inviteOnly;
  }

  setDiscoveryRelays(relays = []) {
    const values = Array.isArray(relays)
      ? relays.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    this.discoveryRelays = Array.from(new Set(values));
    return [...this.discoveryRelays];
  }

  addAllow(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return { ok: false, reason: 'invalid-pubkey' };
    }
    this.allowList.add(normalized);
    return { ok: true, pubkey: normalized };
  }

  removeAllow(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return { ok: false, reason: 'invalid-pubkey' };
    }
    this.allowList.delete(normalized);
    return { ok: true, pubkey: normalized };
  }

  addBan(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return { ok: false, reason: 'invalid-pubkey' };
    }
    this.banList.add(normalized);
    return { ok: true, pubkey: normalized };
  }

  removeBan(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return { ok: false, reason: 'invalid-pubkey' };
    }
    this.banList.delete(normalized);
    return { ok: true, pubkey: normalized };
  }
}

export {
  GatewayPolicyService,
  normalizePubkey,
  normalizePolicy
};

export default GatewayPolicyService;
