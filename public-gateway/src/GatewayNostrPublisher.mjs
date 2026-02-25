import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import WebSocket from 'ws';

const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 !== 0) return null;
  if (/[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function normalizeOperatorSecretHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed;
  // Some deployments accidentally persist 64-byte "secret+pubkey". Use the seed half.
  if (/^[a-f0-9]{128}$/i.test(trimmed)) return trimmed.slice(0, 64);
  return null;
}

function normalizePubkeyHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeRelayUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_err) {
    return null;
  }
}

function serializeEventForId(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    Array.isArray(event.tags) ? event.tags : [],
    typeof event.content === 'string' ? event.content : ''
  ]);
}

function finalizeEvent(template, { operatorNsecHex, operatorPubkey = null }) {
  const normalizedSecretHex = normalizeOperatorSecretHex(operatorNsecHex);
  if (!normalizedSecretHex) {
    throw new Error('invalid-operator-secret');
  }
  const secretBytes = hexToBytes(normalizedSecretHex);
  if (!secretBytes || secretBytes.length !== 32) {
    throw new Error('invalid-operator-secret-bytes');
  }
  const derivedPubkeyHex = Buffer.from(schnorr.getPublicKey(secretBytes)).toString('hex');
  const normalizedOperatorPubkey = normalizePubkeyHex(operatorPubkey) || derivedPubkeyHex;

  const draft = {
    kind: Number(template?.kind || 0),
    created_at: Number.isFinite(template?.created_at)
      ? Math.floor(template.created_at)
      : Math.floor(Date.now() / 1000),
    tags: Array.isArray(template?.tags) ? template.tags : [],
    content: typeof template?.content === 'string' ? template.content : '',
    pubkey: normalizedOperatorPubkey
  };
  const id = createHash('sha256').update(serializeEventForId(draft)).digest('hex');
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), secretBytes)).toString('hex');
  return {
    ...draft,
    id,
    sig
  };
}

async function publishEventToRelay(relayUrl, event, { timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(relayUrl);
    let settled = false;
    let sent = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (_err) {
        // best effort
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      settle({
        relayUrl,
        ok: false,
        accepted: false,
        reason: 'timeout'
      });
    }, timeoutMs);

    socket.once('open', () => {
      sent = true;
      socket.send(JSON.stringify(['EVENT', event]));
    });

    socket.on('message', (payload) => {
      let parsed = null;
      try {
        parsed = JSON.parse(String(payload || ''));
      } catch (_err) {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === 'OK' && parsed[1] === event.id) {
        clearTimeout(timeout);
        settle({
          relayUrl,
          ok: parsed[2] === true,
          accepted: parsed[2] === true,
          reason: typeof parsed[3] === 'string' ? parsed[3] : null
        });
      }
    });

    socket.once('error', (error) => {
      clearTimeout(timeout);
      settle({
        relayUrl,
        ok: false,
        accepted: false,
        reason: error?.message || 'socket-error'
      });
    });

    socket.once('close', () => {
      if (settled) return;
      clearTimeout(timeout);
      settle({
        relayUrl,
        ok: false,
        accepted: false,
        reason: sent ? 'closed-before-ok' : 'closed-before-send'
      });
    });
  });
}

async function publishGatewayEventToNostrRelays({
  eventTemplate,
  relayUrls = [],
  operatorNsecHex,
  operatorPubkey = null,
  timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS,
  logger = console
} = {}) {
  const normalizedRelayUrls = Array.from(
    new Set(
      (Array.isArray(relayUrls) ? relayUrls : [])
        .map((entry) => normalizeRelayUrl(entry))
        .filter((entry) => !!entry)
    )
  );
  if (!eventTemplate || !normalizedRelayUrls.length) {
    return {
      eventId: null,
      total: normalizedRelayUrls.length,
      successCount: 0,
      results: []
    };
  }

  const signedEvent = finalizeEvent(eventTemplate, { operatorNsecHex, operatorPubkey });
  const settled = await Promise.all(
    normalizedRelayUrls.map((relayUrl) =>
      publishEventToRelay(relayUrl, signedEvent, { timeoutMs }).catch((error) => ({
        relayUrl,
        ok: false,
        accepted: false,
        reason: error?.message || 'publish-error'
      }))
    )
  );
  const successCount = settled.filter((entry) => entry?.ok && entry?.accepted).length;

  logger?.debug?.('[GatewayEvents] Nostr relay publish summary', {
    eventId: signedEvent.id,
    total: normalizedRelayUrls.length,
    successCount
  });

  return {
    eventId: signedEvent.id,
    total: normalizedRelayUrls.length,
    successCount,
    results: settled
  };
}

export {
  finalizeEvent,
  publishGatewayEventToNostrRelays
};

export default publishGatewayEventToNostrRelays;
