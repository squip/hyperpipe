import {
  compareGroupPresenceStates,
  createGroupPresenceState,
  mergeGroupPresenceInputs,
  normalizeGroupPresenceInput,
  selectGroupPresenceStateUpdate
} from '@/lib/group-presence'
import { describe, expect, it } from 'vitest'

describe('group presence helpers', () => {
  it('prefers richer presence hints when merging inputs', () => {
    const merged = mergeGroupPresenceInputs(
      {
        groupId: 'group-1',
        relay: 'wss://relay.example',
        gatewayOrigin: 'https://gateway.example',
        hostPeerKeys: ['peer-a']
      },
      {
        groupId: 'group-1',
        gatewayId: 'Gateway-A',
        directJoinOnly: true,
        discoveryTopic: 'topic-1',
        hostPeerKeys: ['PEER-A', 'peer-b'],
        leaseReplicaPeerKeys: ['peer-c']
      }
    )

    expect(merged).toEqual(
      normalizeGroupPresenceInput({
        groupId: 'group-1',
        relay: 'wss://relay.example',
        gatewayId: 'gateway-a',
        gatewayOrigin: 'https://gateway.example',
        directJoinOnly: true,
        discoveryTopic: 'topic-1',
        hostPeerKeys: ['peer-a', 'peer-b'],
        leaseReplicaPeerKeys: ['peer-c']
      })
    )
  })

  it('sorts ready counts ahead of scanning and unknown states', () => {
    const readyHigh = createGroupPresenceState({ status: 'ready', count: 9 })
    const readyLow = createGroupPresenceState({ status: 'ready', count: 2 })
    const scanning = createGroupPresenceState({ status: 'scanning', source: 'gateway' })
    const unknown = createGroupPresenceState({ status: 'unknown', unknown: true })

    expect(compareGroupPresenceStates(readyHigh, readyLow, 'desc')).toBeLessThan(0)
    expect(compareGroupPresenceStates(readyLow, readyHigh, 'desc')).toBeGreaterThan(0)
    expect(compareGroupPresenceStates(readyLow, scanning, 'desc')).toBeLessThan(0)
    expect(compareGroupPresenceStates(scanning, readyLow, 'desc')).toBeGreaterThan(0)
    expect(compareGroupPresenceStates(scanning, unknown, 'desc')).toBe(0)
  })

  it('preserves a recent gateway-backed count over a smaller fallback direct-probe result', () => {
    const existingState = createGroupPresenceState({
      count: 2,
      status: 'ready',
      source: 'gateway',
      gatewayIncluded: true,
      gatewayHealthy: true,
      lastUpdatedAt: 50_000
    })
    const nextState = createGroupPresenceState({
      count: 1,
      status: 'ready',
      source: 'direct-probe',
      lastUpdatedAt: 55_000,
      error: 'gateway-presence-timeout'
    })

    const selected = selectGroupPresenceStateUpdate({
      existingState,
      nextState,
      query: normalizeGroupPresenceInput({
        groupId: 'group-1',
        gatewayOrigin: 'https://gateway.example',
        directJoinOnly: false
      }),
      now: 55_500
    })

    expect(selected.preservedGatewayState).toBe(true)
    expect(selected.state.count).toBe(2)
    expect(selected.state.source).toBe('gateway')
    expect(selected.state.error).toBe('gateway-presence-timeout')
  })

  it('allows the fallback direct-probe count after the gateway-backed result is stale', () => {
    const existingState = createGroupPresenceState({
      count: 2,
      status: 'ready',
      source: 'gateway',
      gatewayIncluded: true,
      gatewayHealthy: true,
      lastUpdatedAt: 1_000
    })
    const nextState = createGroupPresenceState({
      count: 1,
      status: 'ready',
      source: 'direct-probe',
      lastUpdatedAt: 70_000,
      error: 'gateway-presence-timeout'
    })

    const selected = selectGroupPresenceStateUpdate({
      existingState,
      nextState,
      query: normalizeGroupPresenceInput({
        groupId: 'group-1',
        gatewayOrigin: 'https://gateway.example',
        directJoinOnly: false
      }),
      now: 70_500
    })

    expect(selected.preservedGatewayState).toBe(false)
    expect(selected.state.count).toBe(1)
    expect(selected.state.source).toBe('direct-probe')
  })
})
