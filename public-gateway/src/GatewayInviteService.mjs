import { randomBytes } from 'node:crypto';
import { normalizePubkey } from './GatewayPolicyService.mjs';

class GatewayInviteService {
  constructor({ logger = console, defaultInviteTtlSec = 7 * 24 * 60 * 60 } = {}) {
    this.logger = logger;
    this.defaultInviteTtlSec = Number.isFinite(defaultInviteTtlSec) && defaultInviteTtlSec > 0
      ? Math.trunc(defaultInviteTtlSec)
      : 7 * 24 * 60 * 60;
    this.joinRequests = new Map();
    this.invites = new Map();
  }

  pruneExpired() {
    const now = Date.now();
    for (const [inviteToken, invite] of this.invites.entries()) {
      if (invite?.expiresAt && invite.expiresAt <= now) {
        this.invites.delete(inviteToken);
      }
    }
  }

  submitJoinRequest({ pubkey, content = '', metadata = null } = {}) {
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

  rejectJoinRequest({ requestId } = {}) {
    const request = this.joinRequests.get(requestId);
    if (!request) {
      throw new Error('join-request-not-found');
    }
    request.status = 'rejected';
    request.updatedAt = Date.now();
    this.joinRequests.set(requestId, request);
    return { ...request };
  }

  createInvite({ pubkey, ttlSec = null, metadata = null } = {}) {
    const inviteePubkey = normalizePubkey(pubkey);
    if (!inviteePubkey) {
      throw new Error('invalid-invitee-pubkey');
    }
    this.pruneExpired();
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
    return { ...invite };
  }

  approveJoinRequest({ requestId, ttlSec = null, metadata = null } = {}) {
    const request = this.joinRequests.get(requestId);
    if (!request) {
      throw new Error('join-request-not-found');
    }
    const invite = this.createInvite({
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
    return {
      request: { ...request },
      invite
    };
  }

  redeemInvite({ inviteToken, pubkey } = {}) {
    this.pruneExpired();
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
    return { ...invite };
  }
}

export {
  GatewayInviteService
};

export default GatewayInviteService;
