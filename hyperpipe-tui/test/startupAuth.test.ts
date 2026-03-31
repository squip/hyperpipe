import { describe, expect, it } from 'vitest'
import { nip19, utils } from 'nostr-tools'
import {
  appendDiscoveryRelay,
  buildDiscoveryRelayState,
  parseNsecCredentialInput,
  toggleDiscoveryRelay
} from '../src/ui/startupAuth.js'

describe('startupAuth', () => {
  it('parses 64-char hex nsec input', () => {
    const nsecHex = '1'.repeat(64)
    const parsed = parseNsecCredentialInput(nsecHex)
    expect(parsed.nsecHex).toBe(nsecHex)
    expect(parsed.nsec.startsWith('nsec1')).toBe(true)
    expect(parsed.pubkeyHex).toHaveLength(64)
    expect(parsed.npub.startsWith('npub1')).toBe(true)
  })

  it('parses bech32 nsec input', () => {
    const bytes = utils.hexToBytes('2'.repeat(64))
    const nsec = nip19.nsecEncode(bytes)
    const parsed = parseNsecCredentialInput(nsec)
    expect(parsed.nsec).toBe(nsec)
    expect(parsed.nsecHex).toBe('2'.repeat(64))
  })

  it('rejects invalid nsec input', () => {
    expect(() => parseNsecCredentialInput('not-a-key')).toThrow()
  })

  it('builds discovery relay state with defaults and dedupe', () => {
    const state = buildDiscoveryRelayState({
      persisted: ['wss://relay.damus.io/', 'wss://relay.damus.io/'],
      active: ['wss://nos.lol/']
    })
    expect(state.options.includes('wss://relay.damus.io/')).toBe(true)
    expect(state.options.includes('wss://nos.lol/')).toBe(true)
    expect(state.selected).toEqual(['wss://relay.damus.io/'])
  })

  it('appends and selects manual relay entries', () => {
    const next = appendDiscoveryRelay(
      ['wss://relay.damus.io/'],
      ['wss://relay.damus.io/'],
      'wss://example.com/relay'
    )
    expect(next.options).toContain('wss://example.com/relay')
    expect(next.selected).toContain('wss://example.com/relay')
  })

  it('toggles discovery relay selection', () => {
    const first = toggleDiscoveryRelay(['wss://relay.damus.io/'], 'wss://nos.lol/')
    expect(first).toContain('wss://nos.lol/')
    const second = toggleDiscoveryRelay(first, 'wss://nos.lol/')
    expect(second).not.toContain('wss://nos.lol/')
  })
})
