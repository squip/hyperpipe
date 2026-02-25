import { createHash } from 'node:crypto';

function toGatewayDTag(origin) {
  return `hypertuna_gateway:${origin}`;
}

function encryptBanListStub(banList = []) {
  const json = JSON.stringify({
    version: 1,
    pubkeys: Array.isArray(banList) ? banList : []
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

class GatewayEventPublisher {
  constructor({ logger = console, gatewayOrigin, policyService, eventRelayPublisher = null } = {}) {
    this.logger = logger;
    this.gatewayOrigin = gatewayOrigin || null;
    this.policyService = policyService || null;
    this.eventRelayPublisher = typeof eventRelayPublisher === 'function' ? eventRelayPublisher : null;
    this.latestMetadataEvent = null;
  }

  buildMetadataEvent({ reason = 'manual' } = {}) {
    if (!this.gatewayOrigin || !this.policyService) {
      return null;
    }
    const policy = this.policyService.getSnapshot();
    const tags = [
      ['d', toGatewayDTag(this.gatewayOrigin)],
      ['h', 'hypertuna_gateway:metadata'],
      ['operator', policy.operatorPubkey || ''],
      ['policy', policy.policy]
    ];
    if (policy.allowList.length) {
      tags.push(['allow-list', ...policy.allowList]);
    }
    for (const relayUrl of policy.discoveryRelays || []) {
      tags.push(['r', relayUrl]);
    }
    return {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: policy.operatorPubkey || '',
      tags,
      content: encryptBanListStub(policy.banList),
      meta: {
        reason,
        contentDigest: createHash('sha256').update(JSON.stringify(tags)).digest('hex')
      }
    };
  }

  publishGatewayMetadata({ reason = 'manual' } = {}) {
    const event = this.buildMetadataEvent({ reason });
    if (!event) return null;
    this.latestMetadataEvent = event;
    this.logger?.info?.('[GatewayEvents] Prepared gateway metadata event', {
      reason,
      gatewayOrigin: this.gatewayOrigin,
      policy: event.tags.find((tag) => tag[0] === 'policy')?.[1] || null,
      allowListCount: event.tags.find((tag) => tag[0] === 'allow-list')?.length
        ? Math.max(event.tags.find((tag) => tag[0] === 'allow-list').length - 1, 0)
        : 0
    });
    if (this.eventRelayPublisher) {
      Promise.resolve(this.eventRelayPublisher(event, { type: 'gateway-metadata', reason })).catch((error) => {
        this.logger?.warn?.('[GatewayEvents] Failed to publish metadata event to discovery relays', {
          error: error?.message || error
        });
      });
    }
    return event;
  }

  buildInviteEvent({ inviteePubkey, inviteToken } = {}) {
    if (!this.gatewayOrigin || !this.policyService) return null;
    const policy = this.policyService.getSnapshot();
    if (!inviteePubkey || !inviteToken) return null;
    return {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: policy.operatorPubkey || '',
      tags: [
        ['d', toGatewayDTag(this.gatewayOrigin)],
        ['h', 'hypertuna_gateway:invite'],
        ['p', inviteePubkey],
        ['INVITE', inviteToken]
      ],
      content: ''
    };
  }

  publishInviteEvent(input = {}) {
    const event = this.buildInviteEvent(input);
    if (!event) return null;
    this.logger?.info?.('[GatewayEvents] Prepared gateway invite event', {
      gatewayOrigin: this.gatewayOrigin,
      inviteePubkey: input.inviteePubkey ? String(input.inviteePubkey).slice(0, 12) : null
    });
    if (this.eventRelayPublisher) {
      Promise.resolve(this.eventRelayPublisher(event, { type: 'gateway-invite' })).catch((error) => {
        this.logger?.warn?.('[GatewayEvents] Failed to publish invite event to discovery relays', {
          error: error?.message || error
        });
      });
    }
    return event;
  }
}

export {
  GatewayEventPublisher,
  toGatewayDTag
};

export default GatewayEventPublisher;
