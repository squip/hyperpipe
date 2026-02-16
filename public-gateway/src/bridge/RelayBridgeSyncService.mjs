import { CONTROL_METHODS } from '../../../shared/public-gateway/ControlPlaneMethods.mjs';
import { normalizePurpose } from '../../../shared/public-gateway/JoinMaterialTypes.mjs';

class RelayBridgeSyncService {
  constructor({
    logger = console,
    gatewayId = null,
    controlClientPool = null,
    bundleService = null,
    relayAuthorityPolicyService = null,
    onBundleVerified = null
  } = {}) {
    this.logger = logger;
    this.gatewayId = gatewayId || null;
    this.controlClientPool = controlClientPool;
    this.bundleService = bundleService;
    this.relayAuthorityPolicyService = relayAuthorityPolicyService;
    this.onBundleVerified = typeof onBundleVerified === 'function' ? onBundleVerified : null;
  }

  #resolveBridgeSources(authorityPolicy, gatewaySnapshot = {}) {
    const map = gatewaySnapshot && typeof gatewaySnapshot === 'object'
      ? gatewaySnapshot
      : {};
    const allGatewayIds = Object.keys(map);
    const rules = authorityPolicy?.bridgeRules || {};
    const allowAnyValidatedSource = rules.allowAnyValidatedSource === true;
    const allowList = Array.isArray(rules.allowedGatewayPubkeys)
      ? rules.allowedGatewayPubkeys.filter(Boolean)
      : [];
    let sourceIds = allowAnyValidatedSource
      ? allGatewayIds
      : allowList;
    if (!sourceIds.length) {
      sourceIds = Array.isArray(authorityPolicy?.validators)
        ? authorityPolicy.validators.map((entry) => entry?.gatewayPubkey || entry?.pubkey).filter(Boolean)
        : [];
    }
    return Array.from(new Set(sourceIds.filter((gatewayId) => gatewayId && gatewayId !== this.gatewayId)));
  }

  async #readRemoteBundle(gatewayId, relayKey, purpose) {
    if (!this.controlClientPool?.request) return null;
    const response = await this.controlClientPool.request(CONTROL_METHODS.BRIDGE_BUNDLE_READ, {
      relayKey,
      purpose
    }, {
      gatewayId,
      onlyGateway: true,
      hedged: false,
      timeoutMs: 5000
    });
    const data = response?.data && typeof response.data === 'object' ? response.data : null;
    return data?.bundle || null;
  }

  async fetchBridgeBundle({
    relayKey,
    purpose,
    authorityPolicy = null,
    gatewaySnapshot = null,
    expectedPolicyHash = null
  } = {}) {
    if (!relayKey) return null;
    const normalizedPurpose = normalizePurpose(purpose);
    const policy = authorityPolicy || await this.relayAuthorityPolicyService?.getPolicy?.(relayKey);
    if (!policy) return null;

    const snapshot = gatewaySnapshot || this.controlClientPool?.getGatewaySnapshot?.()?.gateways || {};
    const sourceGatewayIds = this.#resolveBridgeSources(policy, snapshot);
    if (!sourceGatewayIds.length) return null;

    const minQuorum = Number.isFinite(Number(policy.minQuorumWeight)) ? Number(policy.minQuorumWeight) : null;
    for (const gatewayId of sourceGatewayIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const rawBundle = await this.#readRemoteBundle(gatewayId, relayKey, normalizedPurpose);
        if (!rawBundle) continue;
        // eslint-disable-next-line no-await-in-loop
        const verified = this.bundleService?.verifyBundle?.(rawBundle, {
          expectedRelayKey: relayKey,
          expectedPurpose: normalizedPurpose,
          minQuorum
        });
        if (!verified?.ok) {
          this.logger?.debug?.('[RelayBridgeSync] Rejected bridge bundle', {
            relayKey,
            purpose: normalizedPurpose,
            gatewayId,
            errors: verified?.errors || []
          });
          continue;
        }
        if (expectedPolicyHash && verified?.bundle?.authorityPolicyHash && verified.bundle.authorityPolicyHash !== expectedPolicyHash) {
          continue;
        }
        const receipt = {
          relayKey,
          purpose: normalizedPurpose,
          sourceGatewayPubkey: verified.bundle.sourceGatewayPubkey || gatewayId,
          bundleId: verified.bundle.bundleId,
          materialDigest: verified.bundle.materialDigest,
          authorityPolicyHash: verified.bundle.authorityPolicyHash || null,
          receivedAt: Date.now(),
          expiresAt: verified.bundle.expiresAt || null,
          status: 'verified'
        };
        // eslint-disable-next-line no-await-in-loop
        await this.bundleService?.storeBundle?.(relayKey, normalizedPurpose, verified.bundle);
        if (typeof this.controlClientPool?.request === 'function') {
          // Best-effort ack propagation to origin.
          this.controlClientPool.request(CONTROL_METHODS.BRIDGE_BUNDLE_PUSH, {
            relayKey,
            purpose: normalizedPurpose,
            receipt
          }, {
            gatewayId,
            onlyGateway: true,
            hedged: false,
            timeoutMs: 2500
          }).catch(() => null);
        }
        if (this.onBundleVerified) {
          // eslint-disable-next-line no-await-in-loop
          await this.onBundleVerified({
            relayKey,
            purpose: normalizedPurpose,
            bundle: verified.bundle,
            receipt
          });
        }
        return {
          bundle: verified.bundle,
          receipt
        };
      } catch (error) {
        this.logger?.debug?.('[RelayBridgeSync] Bridge bundle fetch failed', {
          relayKey,
          purpose: normalizedPurpose,
          gatewayId,
          error: error?.message || error
        });
      }
    }

    return null;
  }
}

export default RelayBridgeSyncService;
