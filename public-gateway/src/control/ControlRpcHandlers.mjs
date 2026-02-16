import { CONTROL_METHODS } from '../../../shared/public-gateway/ControlPlaneMethods.mjs';

class ControlRpcHandlers {
  constructor({ delegates = {}, logger = console } = {}) {
    this.delegates = delegates || {};
    this.logger = logger;
  }

  registerProtocol(protocol) {
    if (!protocol || typeof protocol.registerControlMethod !== 'function') return;

    this.#register(protocol, CONTROL_METHODS.MESH_CATALOG_READ, 'discoveryCatalogRpc');
    this.#register(protocol, CONTROL_METHODS.MESH_STATE_READ, 'meshStateReadRpc');
    this.#register(protocol, CONTROL_METHODS.MESH_STATE_APPEND, 'meshStateAppendRpc');
    this.#register(protocol, CONTROL_METHODS.MESH_LEASE_VOTE, 'meshLeaseVoteRpc');
    this.#register(protocol, CONTROL_METHODS.RELAY_AUTHORITY_READ, 'relayAuthorityReadRpc');
    this.#register(protocol, CONTROL_METHODS.RELAY_AUTHORITY_UPSERT, 'relayAuthorityUpsertRpc');
    this.#register(protocol, CONTROL_METHODS.BRIDGE_BUNDLE_READ, 'bridgeBundleReadRpc');
    this.#register(protocol, CONTROL_METHODS.BRIDGE_BUNDLE_PUSH, 'bridgeBundlePushRpc');
    this.#register(protocol, CONTROL_METHODS.RELAY_POLICY_READ, 'relayPolicyReadRpc');
    this.#register(protocol, CONTROL_METHODS.AUTH_CHALLENGE, 'authChallengeRpc');
    this.#register(protocol, CONTROL_METHODS.AUTH_SESSION, 'authSessionRpc');
    this.#register(protocol, CONTROL_METHODS.RELAY_REGISTER, 'relayRegisterRpc');
    this.#register(protocol, CONTROL_METHODS.MIRROR_READ, 'mirrorReadRpc');

    this.#register(protocol, CONTROL_METHODS.OPEN_JOIN_CHALLENGE, 'openJoinChallengeRpc');
    this.#register(protocol, CONTROL_METHODS.OPEN_JOIN_POOL_SYNC, 'openJoinPoolSyncRpc');
    this.#register(protocol, CONTROL_METHODS.OPEN_JOIN_LEASE_CLAIM, 'openJoinLeaseClaimRpc');
    this.#register(protocol, CONTROL_METHODS.OPEN_JOIN_APPEND_CORES, 'openJoinAppendCoresRpc');

    this.#register(protocol, CONTROL_METHODS.CLOSED_JOIN_POOL_SYNC, 'closedJoinPoolSyncRpc');
    this.#register(protocol, CONTROL_METHODS.CLOSED_JOIN_LEASE_CLAIM, 'closedJoinLeaseClaimRpc');
  }

  #register(protocol, methodName, delegateName) {
    protocol.registerControlMethod(methodName, async (payload, request) => {
      const delegate = this.delegates?.[delegateName];
      if (typeof delegate !== 'function') {
        return {
          statusCode: 404,
          body: { error: `unsupported-control-method:${methodName}` }
        };
      }

      try {
        const result = await delegate(payload || {}, request || null);
        return {
          statusCode: Number.isFinite(Number(result?.statusCode)) ? Math.round(Number(result.statusCode)) : 200,
          body: result?.body ?? result ?? null
        };
      } catch (error) {
        this.logger?.warn?.('[ControlRpcHandlers] Delegate failed', {
          methodName,
          delegateName,
          error: error?.message || error
        });
        return {
          statusCode: Number.isFinite(Number(error?.statusCode)) ? Math.round(Number(error.statusCode)) : 500,
          body: { error: error?.message || 'internal-error' }
        };
      }
    });
  }
}

export default ControlRpcHandlers;
