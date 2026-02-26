import { schnorr } from '@noble/curves/secp256k1.js';

import {
  bytesToHex,
  hexToBytes,
  normalizeHex64
} from './utils.js';

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export function derivePubkeyFromNsecHex(nsecHex) {
  const normalizedNsec = normalizeHex64(nsecHex);
  if (!normalizedNsec) {
    throw new Error('invalid-nsec-hex');
  }
  const privateBytes = hexToBytes(normalizedNsec);
  if (!privateBytes || privateBytes.length !== 32) {
    throw new Error('invalid-nsec-hex');
  }
  const pubkey = bytesToHex(schnorr.getPublicKey(privateBytes));
  const normalizedPubkey = normalizeHex64(pubkey);
  if (!normalizedPubkey) {
    throw new Error('invalid-derived-pubkey');
  }
  return normalizedPubkey;
}

async function buildAuthEvent({ pubkey, nonce, scope, nsecHex }) {
  const createdAt = Math.floor(Date.now() / 1000);
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ];
  const payload = [0, pubkey, createdAt, 22242, tags, ''];
  const id = await sha256Hex(JSON.stringify(payload));
  const event = {
    id,
    kind: 22242,
    pubkey,
    created_at: createdAt,
    tags,
    content: ''
  };

  const privateBytes = hexToBytes(nsecHex);
  const messageBytes = hexToBytes(id);
  if (!privateBytes || !messageBytes) {
    throw new Error('invalid-nsec-hex');
  }
  const signature = await schnorr.sign(messageBytes, privateBytes);
  return {
    ...event,
    sig: bytesToHex(signature)
  };
}

async function requestChallenge(pubkey, scope) {
  const response = await fetch('/api/auth/challenge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      pubkey,
      scope
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'challenge-failed');
  }
  return payload;
}

async function verifyChallenge({ challengeId, authEvent, adminSession = true }) {
  const response = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      challengeId,
      authEvent,
      adminSession
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'verify-failed');
  }
  return payload;
}

export async function loginOperator({ nsecHex, scope = 'gateway:operator', setStatus = null } = {}) {
  const normalizedNsec = normalizeHex64(nsecHex);
  if (!normalizedNsec) {
    throw new Error('invalid-nsec-hex');
  }

  const pubkey = derivePubkeyFromNsecHex(normalizedNsec);

  if (typeof setStatus === 'function') setStatus('Requesting challenge...');
  const challenge = await requestChallenge(pubkey, scope);

  if (typeof setStatus === 'function') setStatus('Signing challenge...');
  const authEvent = await buildAuthEvent({
    pubkey,
    nonce: challenge?.nonce,
    scope,
    nsecHex: normalizedNsec
  });

  if (typeof setStatus === 'function') setStatus('Verifying...');
  const verified = await verifyChallenge({
    challengeId: challenge?.challengeId,
    authEvent,
    adminSession: true
  });

  if (!verified?.token) {
    throw new Error('token-missing');
  }

  return {
    token: verified.token,
    pubkey
  };
}
