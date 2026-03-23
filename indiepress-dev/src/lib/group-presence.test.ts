import {
  compareGroupPresenceStates,
  createGroupPresenceState,
  mergeGroupPresenceInputs,
  normalizeGroupPresenceInput
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
})
