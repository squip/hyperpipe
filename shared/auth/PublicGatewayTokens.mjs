import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify
} from 'node:crypto';

function stableStringify(value) {
  const replacer = (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce((acc, key) => {
          acc[key] = val[key];
          return acc;
        }, {});
    }
    return val;
  };
  return JSON.stringify(value, replacer);
}

function createSignature(payload, secret) {
  if (!secret) throw new Error('Missing shared secret for signature');
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : stableStringify(payload));
  return hmac.digest('hex');
}

function verifySignature(payload, signature, secret) {
  const expected = createSignature(payload, secret);
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function issueClientToken(payload, secret) {
  const tokenPayload = {
    ...payload,
    issuedAt: Date.now()
  };
  const serialized = stableStringify(tokenPayload);
  const signature = createSignature(serialized, secret);
  return Buffer.from(serialized).toString('base64url') + '.' + signature;
}

function verifyClientToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  try {
    const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const isValid = verifySignature(json, signature, secret);
    if (!isValid) return null;
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function createRelayRegistration(relayKey, data = {}) {
  return {
    relayKey,
    nonce: randomBytes(12).toString('hex'),
    issuedAt: Date.now(),
    ...data
  };
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('Expected non-empty base64url string');
  }
  return Buffer.from(value, 'base64url');
}

function coerceEd25519PrivateKey(key) {
  if (!key) throw new Error('Missing Ed25519 private key');
  if (typeof key === 'object' && key.type === 'private') return key;
  if (typeof key !== 'string') throw new Error('Ed25519 private key must be PEM or KeyObject');
  return createPrivateKey(key);
}

function coerceEd25519PublicKey(key) {
  if (!key) throw new Error('Missing Ed25519 public key');
  if (typeof key === 'object' && key.type === 'public') return key;
  if (typeof key !== 'string') throw new Error('Ed25519 public key must be PEM or KeyObject');
  return createPublicKey(key);
}

function signObjectEd25519(payload, privateKey) {
  const serialized = stableStringify(payload);
  const signature = sign(
    null,
    Buffer.from(serialized, 'utf8'),
    coerceEd25519PrivateKey(privateKey)
  );
  return base64UrlEncode(signature);
}

function verifyObjectEd25519(payload, signature, publicKey) {
  if (typeof signature !== 'string' || !signature.length) return false;
  const serialized = stableStringify(payload);
  try {
    return verify(
      null,
      Buffer.from(serialized, 'utf8'),
      coerceEd25519PublicKey(publicKey),
      base64UrlDecode(signature)
    );
  } catch (_) {
    return false;
  }
}

function issueEd25519SessionToken(payload = {}, privateKey, options = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    typ: 'JWT',
    alg: 'EdDSA',
    ...(options?.header && typeof options.header === 'object' ? options.header : {})
  };
  const claims = {
    iat: nowSec,
    jti: randomBytes(12).toString('hex'),
    ...payload
  };
  if (options?.ttlSeconds && Number.isFinite(Number(options.ttlSeconds)) && Number(options.ttlSeconds) > 0) {
    claims.exp = nowSec + Math.round(Number(options.ttlSeconds));
  }
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(
    null,
    Buffer.from(signingInput, 'utf8'),
    coerceEd25519PrivateKey(privateKey)
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function verifyEd25519SessionToken(token, publicKey, options = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  try {
    const verified = verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      coerceEd25519PublicKey(publicKey),
      base64UrlDecode(encodedSignature)
    );
    if (!verified) return null;

    const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
    if (header?.alg !== 'EdDSA') return null;
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));

    const nowSec = Math.floor((typeof options?.clock === 'function' ? options.clock() : Date.now()) / 1000);
    const leeway = Number.isFinite(Number(options?.leewaySeconds)) ? Math.max(0, Math.round(Number(options.leewaySeconds))) : 30;
    if (payload?.nbf != null && Number(payload.nbf) > (nowSec + leeway)) return null;
    if (payload?.exp != null && Number(payload.exp) < (nowSec - leeway)) return null;

    if (options?.issuer && payload?.iss !== options.issuer) return null;
    if (options?.audience) {
      const audience = payload?.aud;
      if (Array.isArray(audience)) {
        if (!audience.includes(options.audience)) return null;
      } else if (audience !== options.audience) {
        return null;
      }
    }
    if (options?.subject && payload?.sub !== options.subject) return null;
    if (options?.gatewayId && payload?.gatewayId !== options.gatewayId) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function createSessionNonce(bytes = 16) {
  const size = Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Math.trunc(Number(bytes)) : 16;
  return randomBytes(size).toString('hex');
}

export {
  createSessionNonce,
  createSignature,
  verifySignature,
  issueClientToken,
  verifyClientToken,
  createRelayRegistration,
  issueEd25519SessionToken,
  verifyEd25519SessionToken,
  signObjectEd25519,
  verifyObjectEd25519
};
