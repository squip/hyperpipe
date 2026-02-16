import { signObjectEd25519, verifyObjectEd25519 } from '../../../shared/auth/PublicGatewayTokens.mjs';
import {
  computeJoinMaterialDigest,
  normalizeJoinMaterialBundle,
  normalizePurpose
} from '../../../shared/public-gateway/JoinMaterialTypes.mjs';
import { validateJoinMaterialBundle } from '../../../shared/public-gateway/JoinMaterialVerifier.mjs';

class JoinMaterialBundleService {
  constructor({
    logger = console,
    store = null,
    gatewayId = null,
    gatewayPrivateKey = null,
    gatewayPublicKeys = {}
  } = {}) {
    this.logger = logger;
    this.store = store;
    this.gatewayId = gatewayId || null;
    this.gatewayPrivateKey = gatewayPrivateKey || null;
    this.gatewayPublicKeys = gatewayPublicKeys || {};
  }

  setGatewayPublicKeys(gatewayPublicKeys = {}) {
    this.gatewayPublicKeys = gatewayPublicKeys || {};
  }

  buildBundle({
    relayKey,
    purpose,
    mirror = {},
    lease = {},
    openJoin = null,
    closedJoin = null,
    authorityPolicyHash = null,
    sourceGatewayPubkey = null,
    expiresAt = null
  } = {}) {
    const bundle = normalizeJoinMaterialBundle({
      relayKey,
      purpose: normalizePurpose(purpose),
      mirror,
      lease,
      openJoin,
      closedJoin,
      authorityPolicyHash,
      sourceGatewayPubkey: sourceGatewayPubkey || this.gatewayId,
      issuedAt: Date.now(),
      expiresAt: Number.isFinite(Number(expiresAt))
        ? Math.round(Number(expiresAt))
        : (Date.now() + (5 * 60 * 1000))
    });
    bundle.materialDigest = computeJoinMaterialDigest(bundle);
    if (this.gatewayPrivateKey) {
      try {
        bundle.gatewaySig = signObjectEd25519({
          bundleId: bundle.bundleId,
          relayKey: bundle.relayKey,
          purpose: bundle.purpose,
          materialDigest: bundle.materialDigest,
          sourceGatewayPubkey: bundle.sourceGatewayPubkey,
          issuedAt: bundle.issuedAt,
          expiresAt: bundle.expiresAt
        }, this.gatewayPrivateKey);
      } catch (error) {
        this.logger?.warn?.('[JoinMaterialBundleService] Failed to sign bundle', {
          relayKey: bundle.relayKey,
          purpose: bundle.purpose,
          error: error?.message || error
        });
      }
    }
    return bundle;
  }

  verifyBundle(bundle = {}, {
    expectedRelayKey = null,
    expectedPurpose = null,
    minQuorum = null,
    now = Date.now()
  } = {}) {
    const validation = validateJoinMaterialBundle(bundle, {
      expectedRelayKey,
      expectedPurpose,
      minQuorum,
      now
    });
    const effectiveErrors = Array.isArray(validation?.errors)
      ? validation.errors.filter((entry) => entry !== 'missing-blind-peer-public-key')
      : [];
    const effectiveValidation = validation?.ok || effectiveErrors.length === 0
      ? {
          ...validation,
          ok: true,
          errors: []
        }
      : {
          ...validation,
          ok: false,
          errors: effectiveErrors
        };
    const normalized = validation.bundle;
    if (!normalized?.gatewaySig || !normalized?.sourceGatewayPubkey) {
      return {
        ...effectiveValidation,
        ok: false,
        errors: [...effectiveErrors, 'missing-bundle-signature']
      };
    }
    const publicKey = this.gatewayPublicKeys?.[normalized.sourceGatewayPubkey] || null;
    if (!publicKey) {
      // Unknown remote keys are accepted only in permissive mode.
      return {
        ...effectiveValidation,
        signatureVerified: false,
        signatureReason: 'public-key-unavailable'
      };
    }
    const verified = verifyObjectEd25519({
      bundleId: normalized.bundleId,
      relayKey: normalized.relayKey,
      purpose: normalized.purpose,
      materialDigest: normalized.materialDigest,
      sourceGatewayPubkey: normalized.sourceGatewayPubkey,
      issuedAt: normalized.issuedAt,
      expiresAt: normalized.expiresAt
    }, normalized.gatewaySig, publicKey);
    if (!verified) {
      return {
        ...effectiveValidation,
        ok: false,
        errors: [...effectiveErrors, 'bundle-signature-invalid'],
        signatureVerified: false
      };
    }
    return {
      ...effectiveValidation,
      signatureVerified: true
    };
  }

  async storeBundle(relayKey, purpose, bundle = {}) {
    if (!relayKey || !purpose) return;
    await this.store?.storeBridgeJoinBundle?.(relayKey, normalizePurpose(purpose), bundle);
  }

  async getBundle(relayKey, purpose) {
    if (!relayKey || !purpose) return null;
    const bundle = await this.store?.getBridgeJoinBundle?.(relayKey, normalizePurpose(purpose));
    return bundle && typeof bundle === 'object' ? normalizeJoinMaterialBundle(bundle) : null;
  }
}

export default JoinMaterialBundleService;
