import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl, uniqueRelayUrls } from '../src/lib/nostr.js'

describe('relay normalization', () => {
  it('maps local public gateway relay to authoritative public URL', () => {
    const relays = uniqueRelayUrls([
      'ws://127.0.0.1:8443/public-gateway:hyperbee',
      'wss://hypertuna.com/relay'
    ])

    expect(relays).toEqual(['wss://hypertuna.com/relay'])
    expect(normalizeRelayUrl('ws://127.0.0.1:8443/public-gateway:hyperbee'))
      .toBe('wss://hypertuna.com/relay')
  })

  it('preserves local group relay URLs', () => {
    const relay = 'ws://127.0.0.1:8443/npubexample/group-alpha?token=abc123'
    expect(normalizeRelayUrl(relay)).toBe(relay)
    expect(uniqueRelayUrls([relay])).toEqual([relay])
  })
})
