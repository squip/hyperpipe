import { describe, expect, it } from 'vitest'
import {
  chatCreateRows,
  csvToUniqueList,
  groupCreateRows,
  type ChatCreateDraft,
  type GroupCreateDraft
} from '../src/ui/createFormAdapter.js'

describe('createFormAdapter', () => {
  it('normalizes CSV values into unique lists', () => {
    expect(csvToUniqueList('a,b b  c,,a')).toEqual(['a', 'b', 'c'])
    expect(csvToUniqueList('')).toEqual([])
  })

  it('builds relay create rows with gateway picker entries when directJoinOnly is false', () => {
    const draft: GroupCreateDraft = {
      name: 'Relay',
      about: 'Description',
      membership: 'closed',
      visibility: 'private',
      directJoinOnly: false,
      gatewayOrigin: 'https://gw-2.example',
      gatewayId: ''
    }

    const rows = groupCreateRows(draft, [
      { gatewayId: 'gw-1', publicUrl: 'https://gw-1.example' },
      { gatewayId: 'gw-2', publicUrl: 'https://gw-2.example' }
    ])

    expect(rows.some((row) => row.kind === 'gateway-refresh')).toBe(true)
    expect(rows.some((row) => row.kind === 'gateway-option' && row.label.includes('[x]'))).toBe(true)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })

  it('omits gateway picker entries in relay create rows when directJoinOnly is true', () => {
    const draft: GroupCreateDraft = {
      name: '',
      about: '',
      membership: 'open',
      visibility: 'public',
      directJoinOnly: true,
      gatewayOrigin: '',
      gatewayId: ''
    }

    const rows = groupCreateRows(draft, [
      { gatewayId: 'gw-1', publicUrl: 'https://gw-1.example' }
    ])

    expect(rows.some((row) => row.kind === 'gateway-refresh' || row.kind === 'gateway-option')).toBe(false)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })

  it('builds chat create rows with writable relay options only', () => {
    const draft: ChatCreateDraft = {
      name: '',
      description: '',
      inviteMembers: [],
      relayUrls: ['wss://relay-c']
    }

    const rows = chatCreateRows(
      draft,
      [
        { relayKey: 'relay-a', connectionUrl: 'wss://relay-a', writable: true, publicIdentifier: 'A' },
        { relayKey: 'relay-b', connectionUrl: 'wss://relay-b', writable: false, publicIdentifier: 'B' },
        { relayKey: 'relay-c', connectionUrl: 'wss://relay-c', writable: true, publicIdentifier: 'C' }
      ]
    )

    const relayRows = rows.filter((row) => row.kind === 'chat-relay')
    expect(relayRows).toHaveLength(2)
    expect(relayRows.some((row) => row.label.startsWith('[x]'))).toBe(true)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })
})
