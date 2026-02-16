import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto';

const X25519_SPKI_PREFIX_HEX = '302a300506032b656e032100';

function toBufferHex(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`Invalid hex for ${fieldName}`);
  }
  return Buffer.from(value, 'hex');
}

function x25519PublicKeyFromRawHex(pubkeyHex) {
  const raw = toBufferHex(pubkeyHex, 'recipientPubkey');
  if (raw.length !== 32) {
    throw new Error('recipientPubkey must be 32-byte hex for X25519 envelopes');
  }
  const der = Buffer.concat([Buffer.from(X25519_SPKI_PREFIX_HEX, 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

class WriterEnvelopeService {
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  wrapWriterSecret({ writerSecret, recipientPubkey, leaseId, relayKey, purpose = 'open-join', ttlMs = 300_000 } = {}) {
    if (typeof writerSecret !== 'string' || !writerSecret.length) {
      throw new Error('writerSecret is required');
    }
    if (typeof recipientPubkey !== 'string' || !recipientPubkey.length) {
      throw new Error('recipientPubkey is required');
    }
    if (typeof leaseId !== 'string' || !leaseId.length) {
      throw new Error('leaseId is required');
    }

    const recipientKey = x25519PublicKeyFromRawHex(recipientPubkey);
    const ephemeral = generateKeyPairSync('x25519');
    const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });

    const info = Buffer.from('hypertuna-writer-envelope-v1', 'utf8');
    const salt = createHash('sha256').update(`${leaseId}:${relayKey || ''}:${purpose || ''}`).digest();
    const derivedKey = hkdfSync('sha256', sharedSecret, salt, info, 32);

    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derivedKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(writerSecret, 'utf8')),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    const ephemeralDer = ephemeral.publicKey.export({ format: 'der', type: 'spki' });
    const ephemeralRaw = ephemeralDer.slice(-32);

    const now = Date.now();
    return {
      alg: 'x25519-aes-256-gcm-v1',
      ciphertext: ciphertext.toString('base64url'),
      nonce: nonce.toString('base64url'),
      authTag: authTag.toString('base64url'),
      ephemeralPubkey: ephemeralRaw.toString('hex'),
      recipientPubkey,
      leaseId,
      relayKey: relayKey || null,
      purpose: purpose === 'closed-join' ? 'closed-join' : 'open-join',
      createdAt: now,
      expiresAt: now + (Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Math.round(Number(ttlMs)) : 300_000),
      envelopeVersion: 1
    };
  }

  decryptEnvelope({ envelope, recipientPrivateKey }) {
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('envelope is required');
    }
    if (!recipientPrivateKey) {
      throw new Error('recipientPrivateKey is required');
    }

    const ephemeralPub = x25519PublicKeyFromRawHex(envelope.ephemeralPubkey);
    const sharedSecret = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPub });

    const info = Buffer.from('hypertuna-writer-envelope-v1', 'utf8');
    const salt = createHash('sha256').update(`${envelope.leaseId}:${envelope.relayKey || ''}:${envelope.purpose || ''}`).digest();
    const derivedKey = hkdfSync('sha256', sharedSecret, salt, info, 32);

    const decipher = createDecipheriv(
      'aes-256-gcm',
      derivedKey,
      Buffer.from(envelope.nonce, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final()
    ]);

    return plaintext.toString('utf8');
  }

  normalizeEnvelope(envelope = {}) {
    if (!envelope || typeof envelope !== 'object') return null;
    const leaseId = typeof envelope.leaseId === 'string' ? envelope.leaseId.trim() : null;
    if (!leaseId) return null;

    return {
      alg: typeof envelope.alg === 'string' ? envelope.alg : 'x25519-aes-256-gcm-v1',
      ciphertext: typeof envelope.ciphertext === 'string' ? envelope.ciphertext : null,
      nonce: typeof envelope.nonce === 'string' ? envelope.nonce : null,
      authTag: typeof envelope.authTag === 'string' ? envelope.authTag : null,
      ephemeralPubkey: typeof envelope.ephemeralPubkey === 'string' ? envelope.ephemeralPubkey : null,
      recipientPubkey: typeof envelope.recipientPubkey === 'string' ? envelope.recipientPubkey : null,
      leaseId,
      relayKey: typeof envelope.relayKey === 'string' ? envelope.relayKey : null,
      purpose: envelope.purpose === 'closed-join' ? 'closed-join' : 'open-join',
      createdAt: Number.isFinite(Number(envelope.createdAt)) ? Number(envelope.createdAt) : Date.now(),
      expiresAt: Number.isFinite(Number(envelope.expiresAt)) ? Number(envelope.expiresAt) : (Date.now() + 300_000),
      envelopeVersion: Number.isFinite(Number(envelope.envelopeVersion)) ? Math.round(Number(envelope.envelopeVersion)) : 1
    };
  }
}

export default WriterEnvelopeService;
