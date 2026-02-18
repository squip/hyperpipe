import {
  GatewayAdminStateStore,
  normalizePolicySnapshot,
  normalizeJoinRequest,
  normalizeInvite,
  normalizeActivityEntry
} from './GatewayAdminStateStore.mjs';

class MemoryGatewayAdminStateStore extends GatewayAdminStateStore {
  constructor(options = {}) {
    super(options);
    this.policySnapshot = null;
    this.joinRequests = new Map();
    this.invites = new Map();
    this.activity = [];
  }

  async getPolicySnapshot() {
    return this.policySnapshot ? { ...this.policySnapshot } : null;
  }

  async setPolicySnapshot(snapshot) {
    this.policySnapshot = normalizePolicySnapshot(snapshot);
  }

  async getJoinRequests() {
    const items = [];
    for (const entry of this.joinRequests.values()) {
      items.push({ ...entry });
    }
    items.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
    return items;
  }

  async setJoinRequests(requests = []) {
    this.joinRequests.clear();
    for (const raw of Array.isArray(requests) ? requests : []) {
      const normalized = normalizeJoinRequest(raw);
      if (!normalized) continue;
      this.joinRequests.set(normalized.id, normalized);
    }
  }

  async getInvites() {
    const items = [];
    for (const entry of this.invites.values()) {
      items.push({ ...entry });
    }
    items.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
    return items;
  }

  async setInvites(invites = []) {
    this.invites.clear();
    for (const raw of Array.isArray(invites) ? invites : []) {
      const normalized = normalizeInvite(raw);
      if (!normalized) continue;
      this.invites.set(normalized.inviteToken, normalized);
    }
  }

  async appendActivity(entry) {
    const normalized = normalizeActivityEntry(entry);
    if (!normalized) return;
    this.activity.push(normalized);
    if (this.activity.length > this.activityRetention) {
      this.activity.splice(0, this.activity.length - this.activityRetention);
    }
  }

  async listActivity({ limit = 100 } = {}) {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 100;
    if (bounded <= 0) return [];
    return this.activity
      .slice(Math.max(0, this.activity.length - bounded))
      .slice()
      .reverse()
      .map((entry) => ({ ...entry }));
  }
}

export {
  MemoryGatewayAdminStateStore
};

export default MemoryGatewayAdminStateStore;
