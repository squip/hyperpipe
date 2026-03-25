import { describe, expect, it } from 'vitest'
import {
  chatCreateRows,
  chatRelayPickerOptions,
  csvToUniqueList,
  gatewayPickerOptions,
  groupCreateRows,
  type ChatCreateDraft,
  type GroupCreateDraft
} from '../src/ui/createFormAdapter.js'

describe('createFormAdapter', () => {
  it('normalizes CSV values into unique lists', () => {
    expect(csvToUniqueList('a,b b  c,,a')).toEqual(['a', 'b', 'c'])
    expect(csvToUniqueList('')).toEqual([])
  })

  it('builds relay create rows with gateway server branch when directJoinOnly is false', () => {
    const draft: GroupCreateDraft = {
      name: 'Relay',
      about: 'Description',
      membership: 'closed',
      visibility: 'private',
      directJoinOnly: false,
      gatewayOrigin: 'https://gw-2.example',
      gatewayId: ''
    }

    const rows = groupCreateRows(draft, '', [
      { gatewayId: 'gw-1', publicUrl: 'https://gw-1.example' },
      {
        gatewayId: 'gw-2',
        publicUrl: 'https://gw-2.example',
        operatorIdentity: {
          pubkey: 'a'.repeat(64)
        }
      }
    ], {
      ['a'.repeat(64)]: { name: 'Alice' }
    })

    expect(rows.some((row) => row.kind === 'field' && row.label === 'Gateway Origin')).toBe(false)
    expect(rows.some((row) => row.kind === 'field' && row.label === 'Gateway ID')).toBe(false)
    expect(rows.some((row) => row.kind === 'branch-parent' && row.label === 'Gateway Server')).toBe(true)
    const gatewayServerRow = rows.find((row) => row.kind === 'branch-parent' && row.label === 'Gateway Server')
    expect(gatewayServerRow && 'value' in gatewayServerRow ? gatewayServerRow.value : '').toContain('Alice')
    expect(rows.some((row) => row.kind === 'branch-child')).toBe(false)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })

  it('expands relay gateway server branch children when requested', () => {
    const draft: GroupCreateDraft = {
      name: 'Relay',
      about: 'Description',
      membership: 'closed',
      visibility: 'private',
      directJoinOnly: false,
      gatewayOrigin: 'https://gw-2.example',
      gatewayId: ''
    }

    const rows = groupCreateRows(draft, 'group:gateway-server', [
      { gatewayId: 'gw-1', publicUrl: 'https://gw-1.example' }
    ])

    const branchChildren = rows.filter((row) => row.kind === 'branch-child')
    expect(branchChildren).toHaveLength(2)
    expect(branchChildren.map((row) => row.label)).toEqual(['Gateway Picker', 'Manual entry'])
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

    const rows = groupCreateRows(draft, '', [
      { gatewayId: 'gw-1', publicUrl: 'https://gw-1.example' }
    ])

    expect(rows.some((row) => row.kind === 'branch-parent' || row.kind === 'branch-child')).toBe(false)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })

  it('builds chat create rows with relay branch and no inline relay options', () => {
    const draft: ChatCreateDraft = {
      name: '',
      description: '',
      inviteMembers: [],
      relayUrls: ['wss://relay-c']
    }

    const rows = chatCreateRows(
      draft,
      '',
      [
        { relayKey: 'relay-a', connectionUrl: 'wss://relay-a', writable: true, publicIdentifier: 'A' },
        { relayKey: 'relay-b', connectionUrl: 'wss://relay-b', writable: false, publicIdentifier: 'B' },
        { relayKey: 'relay-c', connectionUrl: 'wss://relay-c', writable: true, publicIdentifier: 'C' }
      ]
    )

    expect(rows.some((row) => row.kind === 'branch-parent' && row.label === 'Chat Relays')).toBe(true)
    expect(rows.some((row) => row.kind === 'branch-child')).toBe(false)
    expect(rows[rows.length - 1]?.kind).toBe('submit')
  })

  it('builds picker options and keeps chat relay picker labels URL-only', () => {
    const groupDraft: GroupCreateDraft = {
      name: '',
      about: '',
      membership: 'open',
      visibility: 'public',
      directJoinOnly: false,
      gatewayOrigin: 'https://gw-1.example',
      gatewayId: ''
    }

    const gateways = gatewayPickerOptions(groupDraft, [
      {
        gatewayId: 'gw-1',
        publicUrl: 'https://gw-1.example',
        displayName: 'Public Gateway',
        operatorIdentity: {
          pubkey: 'b'.repeat(64)
        }
      }
    ], {
      ['b'.repeat(64)]: { name: 'Operator Bob' }
    })
    expect(gateways).toHaveLength(1)
    expect(gateways[0]?.selected).toBe(true)
    expect(gateways[0]?.label).toContain('Operator Bob')
    expect(gateways[0]?.label).toContain('operator')

    const chatDraft: ChatCreateDraft = {
      name: '',
      description: '',
      inviteMembers: [],
      relayUrls: ['wss://relay-c']
    }
    const relayOptions = chatRelayPickerOptions(chatDraft, [
      { relayKey: 'relay-a', connectionUrl: 'wss://relay-a', writable: true, publicIdentifier: 'A' },
      { relayKey: 'relay-c', connectionUrl: 'wss://relay-c', writable: true, publicIdentifier: 'C' }
    ])

    expect(relayOptions).toHaveLength(2)
    expect(relayOptions[0]?.relayUrl).toBe('wss://relay-a')
    expect(relayOptions[1]?.relayUrl).toBe('wss://relay-c')
  })
})
