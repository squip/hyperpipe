import { randomBytes } from 'node:crypto';
import { normalizePubkey } from './GatewayPolicyService.mjs';

class GatewayInviteService {
  constructor({ logger = console, defaultInviteTtlSec = 7 * 24 * 60 * 60, adminStateStore = null } = {}) {
    this.logger = logger;
    this.adminStateStore = adminStateStore;
    this.defaultInviteTtlSec = Number.isFinite(defaultInviteTtlSec) && defaultInviteTtlSec > 0
      ? Math.trunc(defaultInviteTtlSec)
      : 7 * 24 * 60 * 60;
    this.joinRequests = new Map();
    this.invites = new Map();
  }

  async hydrateFromStore() {
    if (!this.adminStateStore) return;
    try {
      const [joinRequests, invites] = await Promise.all([
        this.adminStateStore.getJoinRequests?.() || [],
        this.adminStateStore.getInvites?.() || []
      ]);
      this.joinRequests.clear();
      this.invites.clear();
      for (const request of Array.isArray(joinRequests) ? joinRequests : []) {
        const id = typeof request?.id === 'string' ? request.id.trim() : '';
        const pubkey = normalizePubkey(request?.pubkey);
        if (!id || !pubkey) continue;
        this.joinRequests.set(id, {
          id,
          pubkey,
          content: typeof request.content === 'string' ? request.content : '',
          metadata: request.metadata && typeof request.metadata === 'object' ? request.metadata : null,
          status: typeof request.status === 'string' ? request.status : 'pending',
          createdAt: Number(request.createdAt) || Date.now(),
          updatedAt: Number(request.updatedAt) || Date.now(),
          inviteToken: typeof request.inviteToken === 'string' ? request.inviteToken : null
        });
      }

      for (const invite of Array.isArray(invites) ? invites : []) {
        const inviteToken = typeof invite?.inviteToken === 'string' ? invite.inviteToken.trim() : '';
        const pubkey = normalizePubkey(invite?.pubkey);
        if (!inviteToken || !pubkey) continue;
        this.invites.set(inviteToken, {
          inviteToken,
          pubkey,
          createdAt: Number(invite.createdAt) || Date.now(),
          expiresAt: Number(invite.expiresAt) || null,
          redeemedAt: Number(invite.redeemedAt) || null,
          metadata: invite.metadata && typeof invite.metadata === 'object' ? invite.metadata : null
        });
      }
    } catch (error) {
      this.logger?.warn?.('[GatewayInvite] Failed to hydrate state', {
        error: error?.message || error
      });
    }
  }

  async pruneExpired() {
    const now = Date.now();
    let changed = false;
    for (const [inviteToken, invite] of this.invites.entries()) {
      if (invite?.expiresAt && invite.expiresAt <= now) {
        this.invites.delete(inviteToken);
        changed = true;
      }
    }
    if (changed) {
      await this.#persistInvites();
    }
  }

  async submitJoinRequest({ pubkey, content = '', metadata = null } = {}) {
    const requesterPubkey = normalizePubkey(pubkey);
    if (!requesterPubkey) {
      throw new Error('invalid-requester-pubkey');
    }
    const id = `joinreq-${Date.now().toString(16)}-${randomBytes(6).toString('hex')}`;
    const request = {
      id,
      pubkey: requesterPubkey,
      content: typeof content === 'string' ? content : '',
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.joinRequests.set(id, request);
    await this.#persistJoinRequests();
    return request;
  }

  listJoinRequests({ status = null } = {}) {
    const filterStatus = typeof status === 'string' ? status.trim().toLowerCase() : null;
    const out = [];
    for (const request of this.joinRequests.values()) {
      if (filterStatus && request.status !== filterStatus) continue;
      out.push({ ...request });
    }
    out.sort((left, right) => right.createdAt - left.createdAt);
    return out;
  }

  async rejectJoinRequest({ requestId } = {}) {
    const request = this.joinRequests.get(requestId);
    if (!request) {
      throw new Error('join-request-not-found');
    }
    request.status = 'rejected';
    request.updatedAt = Date.now();
    this.joinRequests.set(requestId, request);
    await this.#persistJoinRequests();
    return { ...request };
  }

  async createInvite({ pubkey, ttlSec = null, metadata = null } = {}) {
    const inviteePubkey = normalizePubkey(pubkey);
    if (!inviteePubkey) {
      throw new Error('invalid-invitee-pubkey');
    }
    await this.pruneExpired();
    const inviteToken = randomBytes(24).toString('base64url');
    const ttlSeconds = Number.isFinite(ttlSec) && ttlSec > 0
      ? Math.trunc(ttlSec)
      : this.defaultInviteTtlSec;
    const now = Date.now();
    const invite = {
      inviteToken,
      pubkey: inviteePubkey,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      redeemedAt: null,
      metadata: metadata && typeof metadata === 'object' ? metadata : null
    };
    this.invites.set(inviteToken, invite);
    await this.#persistInvites();
    return { ...invite };
  }

  async approveJoinRequest({ requestId, ttlSec = null, metadata = null } = {}) {
    const request = this.joinRequests.get(requestId);
    if (!request) {
      throw new Error('join-request-not-found');
    }
    const invite = await this.createInvite({
      pubkey: request.pubkey,
      ttlSec,
      metadata: {
        ...(request.metadata || {}),
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        joinRequestId: requestId
      }
    });
    request.status = 'approved';
    request.updatedAt = Date.now();
    request.inviteToken = invite.inviteToken;
    this.joinRequests.set(requestId, request);
    await this.#persistJoinRequests();
    return {
      request: { ...request },
      invite
    };
  }

  async redeemInvite({ inviteToken, pubkey } = {}) {
    await this.pruneExpired();
    const token = typeof inviteToken === 'string' ? inviteToken.trim() : '';
    const requesterPubkey = normalizePubkey(pubkey);
    if (!token || !requesterPubkey) {
      throw new Error('invalid-redeem-input');
    }
    const invite = this.invites.get(token);
    if (!invite) {
      throw new Error('invite-not-found');
    }
    if (invite.expiresAt && invite.expiresAt <= Date.now()) {
      this.invites.delete(token);
      await this.#persistInvites();
      throw new Error('invite-expired');
    }
    if (invite.redeemedAt) {
      throw new Error('invite-already-redeemed');
    }
    if (invite.pubkey !== requesterPubkey) {
      throw new Error('invite-pubkey-mismatch');
    }
    invite.redeemedAt = Date.now();
    this.invites.set(token, invite);
    await this.#persistInvites();
    return { ...invite };
  }

  async #persistJoinRequests() {
    if (!this.adminStateStore?.setJoinRequests) return;
    try {
      await this.adminStateStore.setJoinRequests(Array.from(this.joinRequests.values()));
    } catch (error) {
      this.logger?.warn?.('[GatewayInvite] Failed to persist join requests', {
        error: error?.message || error
      });
    }
  }

  async #persistInvites() {
    if (!this.adminStateStore?.setInvites) return;
    try {
      await this.adminStateStore.setInvites(Array.from(this.invites.values()));
    } catch (error) {
      this.logger?.warn?.('[GatewayInvite] Failed to persist invites', {
        error: error?.message || error
      });
    }
  }
}

export {
  GatewayInviteService
};

export default GatewayInviteService;
