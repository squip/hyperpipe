import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

function hexToBytes(hex) {
  if (typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!trimmed || trimmed.length % 2 !== 0 || /[^0-9a-f]/i.test(trimmed)) return null;
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function buildAuthEvent({ pubkey, nonce, scope }) {
  const createdAt = Math.floor(Date.now() / 1000);
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ];
  const payload = [
    0,
    pubkey,
    createdAt,
    22242,
    tags,
    ''
  ];
  const id = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    id,
    kind: 22242,
    pubkey,
    created_at: createdAt,
    tags,
    content: ''
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(data?.error || `HTTP ${response.status}`);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function getScopedToken({
  baseUrl,
  pubkey,
  nsecHex,
  scope,
  relayKey = null
}) {
  const challenge = await fetchJson(new URL('/api/auth/challenge', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pubkey,
      scope,
      relayKey
    })
  });
  const nonce = challenge?.nonce;
  const challengeId = challenge?.challengeId;
  if (!nonce || !challengeId) {
    throw new Error('challenge-response-invalid');
  }
  const authEvent = buildAuthEvent({ pubkey, nonce, scope });
  const privKey = hexToBytes(nsecHex);
  const msg = hexToBytes(authEvent.id);
  if (!privKey || !msg) {
    throw new Error('invalid-operator-nsec-hex');
  }
  const sig = await schnorr.sign(msg, privKey);
  authEvent.sig = toHex(sig);

  const verified = await fetchJson(new URL('/api/auth/verify', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      authEvent
    })
  });
  if (!verified?.token) {
    throw new Error('token-verify-failed');
  }
  return verified.token;
}

function readCliGatewayConfig() {
  const baseUrl = process.env.GATEWAY_API_BASE || process.env.GATEWAY_PUBLIC_URL || 'http://127.0.0.1:4430';
  const pubkey = process.env.GATEWAY_OPERATOR_PUBKEY_HEX || process.env.GATEWAY_OPERATOR_PUBKEY || '';
  const nsecHex = process.env.GATEWAY_OPERATOR_NSEC_HEX || '';
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
    throw new Error('GATEWAY_OPERATOR_PUBKEY_HEX must be a 64-char hex pubkey');
  }
  if (!/^[a-f0-9]{64}$/i.test(nsecHex)) {
    throw new Error('GATEWAY_OPERATOR_NSEC_HEX must be a 64-char hex private key');
  }
  return {
    baseUrl: new URL(baseUrl).toString(),
    pubkey: pubkey.toLowerCase(),
    nsecHex: nsecHex.toLowerCase()
  };
}

async function gatewayRequest({
  baseUrl,
  pubkey,
  nsecHex,
  scope = 'gateway:operator',
  path,
  method = 'GET',
  body = null
}) {
  const token = await getScopedToken({ baseUrl, pubkey, nsecHex, scope });
  return await fetchJson(new URL(path, baseUrl), {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export {
  readCliGatewayConfig,
  gatewayRequest
};
