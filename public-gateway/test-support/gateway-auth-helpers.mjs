import { randomBytes, createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1'

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 !== 0 || /[^a-f0-9]/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function createKeypair() {
  const priv = randomBytes(32)
  const pub = schnorr.getPublicKey(priv)
  return {
    privateKeyHex: toHex(priv),
    publicKeyHex: toHex(pub)
  }
}

async function signGatewayAuthEvent({ privateKeyHex, pubkey, nonce, scope, createdAt = null, relayKey = null }) {
  const eventCreatedAt = Number.isFinite(createdAt) ? Math.trunc(createdAt) : Math.floor(Date.now() / 1000)
  const tags = [
    ['challenge', nonce],
    ['scope', scope]
  ]
  if (relayKey) {
    tags.push(['relay', relayKey])
  }

  const serialized = JSON.stringify([
    0,
    pubkey,
    eventCreatedAt,
    22242,
    tags,
    ''
  ])
  const id = createHash('sha256').update(serialized).digest('hex')
  const messageBytes = hexToBytes(id)
  const privateKey = hexToBytes(privateKeyHex)
  if (!messageBytes || !privateKey) {
    throw new Error('invalid-auth-signing-input')
  }
  const signature = await schnorr.sign(messageBytes, privateKey)
  return {
    id,
    pubkey,
    kind: 22242,
    created_at: eventCreatedAt,
    tags,
    content: '',
    sig: toHex(signature)
  }
}

export {
  createKeypair,
  signGatewayAuthEvent
}
