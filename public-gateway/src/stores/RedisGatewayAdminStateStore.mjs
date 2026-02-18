import { createClient } from 'redis';
import {
  GatewayAdminStateStore,
  normalizePolicySnapshot,
  normalizeJoinRequest,
  normalizeInvite,
  normalizeActivityEntry
} from './GatewayAdminStateStore.mjs';

class RedisGatewayAdminStateStore extends GatewayAdminStateStore {
  constructor({
    url,
    prefix = 'gateway:admin:',
    activityRetention = 5000,
    logger
  } = {}) {
    super({ activityRetention });
    if (!url) {
      throw new Error('Redis URL is required for RedisGatewayAdminStateStore');
    }
    this.url = url;
    this.prefix = String(prefix || 'gateway:admin:').endsWith(':')
      ? String(prefix || 'gateway:admin:')
      : `${String(prefix || 'gateway:admin:')}:`;
    this.logger = logger || console;
    this.client = createClient({ url: this.url });
    this.readyPromise = null;
    this.client.on('error', (error) => {
      this.logger?.error?.('Redis admin state store error', { error: error?.message || error });
    });
  }

  #key(suffix) {
    return `${this.prefix}${suffix}`;
  }

  async #ensureConnected() {
    if (this.client.isReady) return;
    if (!this.readyPromise) {
      this.readyPromise = this.client.connect().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async connect() {
    await this.#ensureConnected();
  }

  async disconnect() {
    if (!this.client.isOpen) return;
    await this.client.disconnect();
  }

  async getPolicySnapshot() {
    await this.#ensureConnected();
    const value = await this.client.get(this.#key('policy'));
    if (!value) return null;
    try {
      return normalizePolicySnapshot(JSON.parse(value));
    } catch (error) {
      this.logger?.warn?.('Failed to parse admin policy snapshot', { error: error?.message || error });
      return null;
    }
  }

  async setPolicySnapshot(snapshot) {
    await this.#ensureConnected();
    const normalized = normalizePolicySnapshot(snapshot);
    await this.client.set(this.#key('policy'), JSON.stringify(normalized));
  }

  async getJoinRequests() {
    await this.#ensureConnected();
    const raw = await this.client.get(this.#key('join-requests'));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const normalized = [];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const item = normalizeJoinRequest(entry);
        if (!item) continue;
        normalized.push(item);
      }
      normalized.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
      return normalized;
    } catch (error) {
      this.logger?.warn?.('Failed to parse admin join requests', { error: error?.message || error });
      return [];
    }
  }

  async setJoinRequests(requests = []) {
    await this.#ensureConnected();
    const normalized = [];
    for (const raw of Array.isArray(requests) ? requests : []) {
      const entry = normalizeJoinRequest(raw);
      if (!entry) continue;
      normalized.push(entry);
    }
    await this.client.set(this.#key('join-requests'), JSON.stringify(normalized));
  }

  async getInvites() {
    await this.#ensureConnected();
    const raw = await this.client.get(this.#key('invites'));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const normalized = [];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const item = normalizeInvite(entry);
        if (!item) continue;
        normalized.push(item);
      }
      normalized.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
      return normalized;
    } catch (error) {
      this.logger?.warn?.('Failed to parse admin invites', { error: error?.message || error });
      return [];
    }
  }

  async setInvites(invites = []) {
    await this.#ensureConnected();
    const normalized = [];
    for (const raw of Array.isArray(invites) ? invites : []) {
      const entry = normalizeInvite(raw);
      if (!entry) continue;
      normalized.push(entry);
    }
    await this.client.set(this.#key('invites'), JSON.stringify(normalized));
  }

  async appendActivity(entry) {
    await this.#ensureConnected();
    const normalized = normalizeActivityEntry(entry);
    if (!normalized) return;
    const activityKey = this.#key('activity');
    await this.client.rPush(activityKey, JSON.stringify(normalized));
    const currentLength = await this.client.lLen(activityKey);
    if (currentLength > this.activityRetention) {
      await this.client.lTrim(activityKey, currentLength - this.activityRetention, -1);
    }
  }

  async listActivity({ limit = 100 } = {}) {
    await this.#ensureConnected();
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 100;
    if (bounded <= 0) return [];
    const rawEntries = await this.client.lRange(this.#key('activity'), -bounded, -1);
    const parsed = [];
    for (const raw of rawEntries) {
      try {
        const entry = normalizeActivityEntry(JSON.parse(raw));
        if (!entry) continue;
        parsed.push(entry);
      } catch (_) {}
    }
    return parsed.reverse();
  }
}

export {
  RedisGatewayAdminStateStore
};

export default RedisGatewayAdminStateStore;
