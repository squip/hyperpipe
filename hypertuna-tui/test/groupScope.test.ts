import { describe, expect, it } from 'vitest'
import { groupScopeKey, normalizeGroupScopeRelay } from '../src/lib/groupScope.js'

describe('groupScope', () => {
  it('normalizes tokenized relay urls to the same scope key as the plain relay url', () => {
    expect(groupScopeKey('npubseed:group-a', 'wss://relay.damus.io/?token=seed-token'))
      .toBe(groupScopeKey('npubseed:group-a', 'wss://relay.damus.io/'))
  })

  it('normalizes loopback relay urls by path instead of ephemeral port or token', () => {
    expect(groupScopeKey('npubseed:group-a', 'ws://127.0.0.1:53916/npubseed/group-a'))
      .toBe(groupScopeKey('npubseed:group-a', 'ws://127.0.0.1:56785/npubseed/group-a?token=seed-token'))
    expect(groupScopeKey('npubseed:group-a', 'ws://localhost:9999/npubseed/group-a/'))
      .toBe(groupScopeKey('npubseed:group-a', 'ws://127.0.0.1:4321/npubseed/group-a'))
  })

  it('preserves an empty relay scope when no relay url is provided', () => {
    expect(normalizeGroupScopeRelay(null)).toBe('')
    expect(groupScopeKey('npubseed:group-a', null)).toBe('|npubseed:group-a')
  })
})
