import {
  finalizeEvent,
  getPublicKey,
  nip04,
  utils,
  type Event,
  type EventTemplate
} from 'nostr-tools'

export function isHex64(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

export function normalizeHex(value: string): string {
  return value.trim().toLowerCase()
}

export function eventNow(): number {
  return Math.floor(Date.now() / 1000)
}

export function getPubkeyFromNsecHex(nsecHex: string): string {
  const secret = utils.hexToBytes(normalizeHex(nsecHex))
  return getPublicKey(secret).toLowerCase()
}

export function signDraftEvent(nsecHex: string, draft: EventTemplate): Event {
  const secret = utils.hexToBytes(normalizeHex(nsecHex))
  return finalizeEvent(draft, secret)
}

export async function nip04Encrypt(nsecHex: string, pubkey: string, plaintext: string): Promise<string> {
  const secret = utils.hexToBytes(normalizeHex(nsecHex))
  return nip04.encrypt(secret, pubkey, plaintext)
}

export async function nip04Decrypt(nsecHex: string, pubkey: string, ciphertext: string): Promise<string> {
  const secret = utils.hexToBytes(normalizeHex(nsecHex))
  return nip04.decrypt(secret, pubkey, ciphertext)
}

export function uniqueRelayUrls(relays: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of relays) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) continue

    let normalized = trimmed
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') continue
      if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
        url.pathname = url.pathname.slice(0, -1)
      }
      url.hash = ''
      url.searchParams.sort()
      normalized = url.toString()
    } catch {
      continue
    }

    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }

  return out
}

export function findPTags(event: Event): string[] {
  return event.tags
    .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
    .map((tag) => tag[1])
}

export function buildReplyTags(replyToEventId: string, replyToPubkey: string): string[][] {
  return [
    ['e', replyToEventId, '', 'reply'],
    ['p', replyToPubkey]
  ]
}

export function buildReactionTags(eventId: string, eventPubkey: string): string[][] {
  return [
    ['e', eventId],
    ['p', eventPubkey]
  ]
}
