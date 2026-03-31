import { getPublicKey, nip19, utils } from 'nostr-tools'
import { DEFAULT_DISCOVERY_RELAYS } from '../lib/constants.js'
import { isHex64, normalizeRelayUrl, uniqueRelayUrls } from '../lib/nostr.js'

export type ParsedNsecCredential = {
  nsecHex: string
  nsec: string
  pubkeyHex: string
  npub: string
}

export function parseNsecCredentialInput(input: string): ParsedNsecCredential {
  const raw = String(input || '').trim()
  if (!raw) {
    throw new Error('nsec input is required')
  }

  let secret: Uint8Array
  const asHex = raw.toLowerCase()
  if (isHex64(asHex)) {
    secret = utils.hexToBytes(asHex)
  } else {
    const decoded = nip19.decode(raw)
    if (decoded.type !== 'nsec') {
      throw new Error('Expected a 64-char hex nsec or bech32 nsec value')
    }
    secret = decoded.data
  }

  const nsecHex = utils.bytesToHex(secret).toLowerCase()
  if (!isHex64(nsecHex)) {
    throw new Error('Invalid nsec credential')
  }
  const pubkeyHex = getPublicKey(secret).toLowerCase()

  return {
    nsecHex,
    nsec: nip19.nsecEncode(secret),
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex)
  }
}

export type DiscoveryRelayState = {
  options: string[]
  selected: string[]
}

export function buildDiscoveryRelayState(input?: {
  persisted?: string[]
  active?: string[]
}): DiscoveryRelayState {
  const persisted = uniqueRelayUrls(input?.persisted || [])
  const active = uniqueRelayUrls(input?.active || [])
  const options = uniqueRelayUrls([
    ...persisted,
    ...active,
    ...DEFAULT_DISCOVERY_RELAYS
  ])
  const selectedSeed = persisted.length
    ? persisted
    : (active.length ? active : uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS))
  const selectedSet = new Set(selectedSeed)
  const selected = options.filter((url) => selectedSet.has(url))

  if (selected.length > 0) {
    return { options, selected }
  }
  const fallback = uniqueRelayUrls(DEFAULT_DISCOVERY_RELAYS)
  return {
    options: uniqueRelayUrls([...options, ...fallback]),
    selected: fallback
  }
}

export function toggleDiscoveryRelay(selected: string[], relayUrl: string): string[] {
  const normalized = normalizeRelayUrl(relayUrl)
  if (!normalized) return selected
  const set = new Set(uniqueRelayUrls(selected))
  if (set.has(normalized)) {
    set.delete(normalized)
  } else {
    set.add(normalized)
  }
  return Array.from(set)
}

export function appendDiscoveryRelay(
  options: string[],
  selected: string[],
  input: string
): DiscoveryRelayState {
  const normalized = normalizeRelayUrl(String(input || '').trim())
  if (!normalized) {
    throw new Error('Relay URL must be a valid ws:// or wss:// URL')
  }

  const nextOptions = uniqueRelayUrls([...options, normalized])
  const nextSelected = uniqueRelayUrls([...selected, normalized])
  return {
    options: nextOptions,
    selected: nextSelected
  }
}
