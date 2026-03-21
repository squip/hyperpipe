import { createHash } from 'node:crypto';

const OPERATOR_ATTESTATION_VERSION = 1;
const OPERATOR_ATTESTATION_PURPOSE = 'gateway-operator-attestation';
const ATTESTATION_EXPIRY_WARNING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHex(value, length) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return '';
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`);
  return pattern.test(normalized) ? normalized : '';
}

function normalizePubkey(value) {
  return normalizeHex(value, 64);
}

function normalizeGatewayId(value) {
  return normalizeHex(value, 64);
}

function normalizePublicUrl(value) {
  const text = normalizeString(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function normalizeTimestamp(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function assertSchnorrImpl(schnorrImpl) {
  if (!schnorrImpl
    || typeof schnorrImpl.getPublicKey !== 'function'
    || typeof schnorrImpl.sign !== 'function'
    || typeof schnorrImpl.verify !== 'function') {
    throw new Error('schnorr-implementation-required');
  }
}

function hexToBytes(hex) {
  const normalized = normalizeString(hex);
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/iu.test(normalized)) {
    return null;
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bech32Charset() {
  return 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
}

function bech32Polymod(values) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) chk ^= generator[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i += 1) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i += 1) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32VerifyChecksum(hrp, data) {
  return bech32Polymod(bech32HrpExpand(hrp).concat(data)) === 1;
}

function bech32Decode(value) {
  const text = normalizeString(value).toLowerCase();
  if (!text || text.length < 8) return null;
  const separator = text.lastIndexOf('1');
  if (separator <= 0 || separator + 7 > text.length) return null;
  const hrp = text.slice(0, separator);
  const dataPart = text.slice(separator + 1);
  const charset = bech32Charset();
  const data = [];
  for (const char of dataPart) {
    const index = charset.indexOf(char);
    if (index === -1) return null;
    data.push(index);
  }
  if (!bech32VerifyChecksum(hrp, data)) return null;
  return {
    prefix: hrp,
    words: data.slice(0, -6)
  };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || (value >> from) !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return ret;
}

export function normalizeOperatorSecretInput(input) {
  const text = normalizeString(input);
  if (!text) return '';
  const hex = normalizeHex(text, 64);
  if (hex) return hex;
  if (!text.toLowerCase().startsWith('nsec1')) return '';
  const decoded = bech32Decode(text);
  if (!decoded || decoded.prefix !== 'nsec') return '';
  const bytes = convertBits(decoded.words, 5, 8, false);
  if (!bytes || bytes.length !== 32) return '';
  return bytesToHex(bytes);
}

export function normalizeOperatorAttestationPayload(payload = {}) {
  const purpose = normalizeString(payload.purpose) || OPERATOR_ATTESTATION_PURPOSE;
  const normalized = {
    purpose,
    operatorPubkey: normalizePubkey(payload.operatorPubkey),
    gatewayId: normalizeGatewayId(payload.gatewayId),
    publicUrl: normalizePublicUrl(payload.publicUrl),
    issuedAt: normalizeTimestamp(payload.issuedAt),
    expiresAt: normalizeTimestamp(payload.expiresAt)
  };
  return normalized;
}

export function serializeOperatorAttestationPayload(payload = {}) {
  const normalized = normalizeOperatorAttestationPayload(payload);
  return JSON.stringify({
    purpose: normalized.purpose,
    operatorPubkey: normalized.operatorPubkey,
    gatewayId: normalized.gatewayId,
    publicUrl: normalized.publicUrl,
    issuedAt: normalized.issuedAt,
    expiresAt: normalized.expiresAt
  });
}

export function hashOperatorAttestationPayload(payload = {}) {
  return createHash('sha256')
    .update(serializeOperatorAttestationPayload(payload), 'utf8')
    .digest();
}

export function createOperatorAttestationRequest({
  operatorPubkey,
  gatewayId,
  publicUrl,
  purpose = OPERATOR_ATTESTATION_PURPOSE
} = {}) {
  return {
    version: OPERATOR_ATTESTATION_VERSION,
    payload: {
      purpose: normalizeString(purpose) || OPERATOR_ATTESTATION_PURPOSE,
      operatorPubkey: normalizePubkey(operatorPubkey),
      gatewayId: normalizeGatewayId(gatewayId),
      publicUrl: normalizePublicUrl(publicUrl)
    }
  };
}

export function normalizeOperatorAttestationRequest(request = {}) {
  const payload = request && typeof request === 'object' ? request.payload : null;
  return {
    version: Number(request?.version) || 0,
    payload: {
      purpose: normalizeString(payload?.purpose) || OPERATOR_ATTESTATION_PURPOSE,
      operatorPubkey: normalizePubkey(payload?.operatorPubkey),
      gatewayId: normalizeGatewayId(payload?.gatewayId),
      publicUrl: normalizePublicUrl(payload?.publicUrl)
    }
  };
}

export function signOperatorAttestationRequest(request = {}, {
  secretInput,
  issuedAt = Date.now(),
  expiresAt = Date.now() + (365 * 24 * 60 * 60 * 1000),
  schnorrImpl = null
} = {}) {
  assertSchnorrImpl(schnorrImpl);
  const normalizedRequest = normalizeOperatorAttestationRequest(request);
  if (normalizedRequest.version !== OPERATOR_ATTESTATION_VERSION) {
    throw new Error('operator-attestation-request-version-invalid');
  }
  if (!normalizedRequest.payload.operatorPubkey || !normalizedRequest.payload.gatewayId || !normalizedRequest.payload.publicUrl) {
    throw new Error('operator-attestation-request-invalid');
  }
  const secretHex = normalizeOperatorSecretInput(secretInput);
  if (!secretHex) {
    throw new Error('operator-secret-invalid');
  }
  const derivedPubkey = bytesToHex(schnorrImpl?.getPublicKey?.(Buffer.from(secretHex, 'hex')));
  if (derivedPubkey !== normalizedRequest.payload.operatorPubkey) {
    throw new Error('operator-secret-pubkey-mismatch');
  }
  const payload = normalizeOperatorAttestationPayload({
    ...normalizedRequest.payload,
    issuedAt,
    expiresAt
  });
  const signature = bytesToHex(
    schnorrImpl?.sign?.(hashOperatorAttestationPayload(payload), Buffer.from(secretHex, 'hex'))
  );
  return {
    version: OPERATOR_ATTESTATION_VERSION,
    payload,
    signature
  };
}

export function verifyOperatorAttestation(attestation = {}, {
  expectedOperatorPubkey = null,
  expectedGatewayId = null,
  expectedPublicUrl = null,
  now = Date.now(),
  schnorrImpl = null
} = {}) {
  assertSchnorrImpl(schnorrImpl);
  const version = Number(attestation?.version) || 0;
  if (version !== OPERATOR_ATTESTATION_VERSION) {
    return { ok: false, error: 'operator-attestation-version-invalid' };
  }
  const payload = normalizeOperatorAttestationPayload(attestation?.payload || {});
  const signature = normalizeHex(attestation?.signature, 128);
  if (payload.purpose !== OPERATOR_ATTESTATION_PURPOSE) {
    return { ok: false, error: 'operator-attestation-purpose-invalid' };
  }
  if (!payload.operatorPubkey || !payload.gatewayId || !payload.publicUrl || !payload.issuedAt || !payload.expiresAt) {
    return { ok: false, error: 'operator-attestation-payload-invalid' };
  }
  if (payload.expiresAt <= payload.issuedAt) {
    return { ok: false, error: 'operator-attestation-expiry-invalid' };
  }
  if (payload.expiresAt <= now) {
    return { ok: false, error: 'operator-attestation-expired', payload };
  }
  const normalizedExpectedPubkey = normalizePubkey(expectedOperatorPubkey);
  if (normalizedExpectedPubkey && payload.operatorPubkey !== normalizedExpectedPubkey) {
    return { ok: false, error: 'operator-attestation-pubkey-mismatch', payload };
  }
  const normalizedExpectedGatewayId = normalizeGatewayId(expectedGatewayId);
  if (normalizedExpectedGatewayId && payload.gatewayId !== normalizedExpectedGatewayId) {
    return { ok: false, error: 'operator-attestation-gateway-id-mismatch', payload };
  }
  const normalizedExpectedPublicUrl = normalizePublicUrl(expectedPublicUrl);
  if (normalizedExpectedPublicUrl && payload.publicUrl !== normalizedExpectedPublicUrl) {
    return { ok: false, error: 'operator-attestation-public-url-mismatch', payload };
  }
  const signatureBytes = hexToBytes(signature);
  const pubkeyBytes = hexToBytes(payload.operatorPubkey);
  if (!signatureBytes || !pubkeyBytes) {
    return { ok: false, error: 'operator-attestation-signature-invalid', payload };
  }
  try {
    const ok = schnorrImpl?.verify?.(signatureBytes, hashOperatorAttestationPayload(payload), pubkeyBytes);
    if (!ok) {
      return { ok: false, error: 'operator-attestation-signature-invalid', payload };
    }
  } catch (error) {
    return { ok: false, error: 'operator-attestation-signature-invalid', payload, message: error?.message || String(error) };
  }
  return {
    ok: true,
    payload,
    attestation: {
      version,
      payload,
      signature
    }
  };
}

export function operatorAttestationNeedsRenewal(attestation = {}, now = Date.now(), schnorrImpl = null) {
  const verification = verifyOperatorAttestation(attestation, { now, schnorrImpl });
  if (!verification.ok) return false;
  return verification.payload.expiresAt <= now + ATTESTATION_EXPIRY_WARNING_WINDOW_MS;
}

export {
  ATTESTATION_EXPIRY_WARNING_WINDOW_MS,
  OPERATOR_ATTESTATION_PURPOSE,
  OPERATOR_ATTESTATION_VERSION
};
