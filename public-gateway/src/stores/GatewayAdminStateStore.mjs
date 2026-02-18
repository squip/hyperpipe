const DEFAULT_ACTIVITY_LIMIT = 5000;

function normalizePolicySnapshot(snapshot = {}) {
  const policy = typeof snapshot?.policy === 'string' ? snapshot.policy.trim().toUpperCase() : 'OPEN';
  const allowList = Array.isArray(snapshot?.allowList)
    ? snapshot.allowList.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const banList = Array.isArray(snapshot?.banList)
    ? snapshot.banList.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const discoveryRelays = Array.isArray(snapshot?.discoveryRelays)
    ? snapshot.discoveryRelays.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  return {
    policy: policy === 'CLOSED' ? 'CLOSED' : 'OPEN',
    allowList: Array.from(new Set(allowList)),
    banList: Array.from(new Set(banList)),
    discoveryRelays: Array.from(new Set(discoveryRelays)),
    inviteOnly: snapshot?.inviteOnly === true
  };
}

function normalizeJoinRequest(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.trim().toLowerCase() : '';
  if (!id || !pubkey) return null;
  return {
    id,
    pubkey,
    content: typeof entry.content === 'string' ? entry.content : '',
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : null,
    status: typeof entry.status === 'string' ? entry.status : 'pending',
    createdAt: Number(entry.createdAt) || Date.now(),
    updatedAt: Number(entry.updatedAt) || Date.now(),
    inviteToken: typeof entry.inviteToken === 'string' ? entry.inviteToken : null
  };
}

function normalizeInvite(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const inviteToken = typeof entry.inviteToken === 'string' ? entry.inviteToken.trim() : '';
  const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.trim().toLowerCase() : '';
  if (!inviteToken || !pubkey) return null;
  return {
    inviteToken,
    pubkey,
    createdAt: Number(entry.createdAt) || Date.now(),
    expiresAt: Number(entry.expiresAt) || null,
    redeemedAt: Number(entry.redeemedAt) || null,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : null
  };
}

function normalizeActivityEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const type = typeof entry.type === 'string' ? entry.type.trim() : '';
  if (!type) return null;
  return {
    id: typeof entry.id === 'string' ? entry.id : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    type,
    actorPubkey: typeof entry.actorPubkey === 'string' ? entry.actorPubkey.trim().toLowerCase() : null,
    relayKey: typeof entry.relayKey === 'string' ? entry.relayKey : null,
    details: entry.details && typeof entry.details === 'object' ? entry.details : null,
    createdAt: Number(entry.createdAt) || Date.now()
  };
}

class GatewayAdminStateStore {
  constructor({ activityRetention = DEFAULT_ACTIVITY_LIMIT } = {}) {
    this.activityRetention = Number.isFinite(activityRetention) && activityRetention > 0
      ? Math.trunc(activityRetention)
      : DEFAULT_ACTIVITY_LIMIT;
  }

  async connect() {}

  async disconnect() {}

  async getPolicySnapshot() {
    return null;
  }

  async setPolicySnapshot(_snapshot) {}

  async getJoinRequests() {
    return [];
  }

  async setJoinRequests(_requests) {}

  async getInvites() {
    return [];
  }

  async setInvites(_invites) {}

  async appendActivity(_entry) {}

  async listActivity({ limit = 100 } = {}) {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 100;
    return bounded > 0 ? [] : [];
  }
}

export {
  GatewayAdminStateStore,
  DEFAULT_ACTIVITY_LIMIT,
  normalizePolicySnapshot,
  normalizeJoinRequest,
  normalizeInvite,
  normalizeActivityEntry
};

export default GatewayAdminStateStore;
