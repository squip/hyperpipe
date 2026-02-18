import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseGatewayTags,
  buildGatewayTags,
  mergeGatewayTags,
  parseGatewayMetadataEvent,
  parseGatewayInviteEvent,
  parseGatewayJoinRequestEvent
} from '../../shared/public-gateway/GatewayContracts.mjs'

const OPERATOR = '1'.repeat(64)
const INVITEE = '2'.repeat(64)
const REQUESTER = '3'.repeat(64)

test('gateway tag parser normalizes, dedupes, and enforces HTTPS origin', () => {
  const tags = [
    ['gateway', 'http://gw-one.example/some/path', OPERATOR, 'open'],
    ['gateway', 'https://gw-one.example', OPERATOR, 'OPEN'],
    ['gateway', 'wss://gw-two.example/socket', INVITEE, 'closed'],
    ['gateway', 'ftp://bad.example', OPERATOR, 'OPEN']
  ]

  const parsed = parseGatewayTags(tags)
  assert.deepEqual(parsed, [
    {
      origin: 'https://gw-one.example',
      operatorPubkey: OPERATOR,
      policy: 'OPEN'
    },
    {
      origin: 'https://gw-two.example',
      operatorPubkey: INVITEE,
      policy: 'CLOSED'
    }
  ])
})

test('gateway tag serializer and merger preserve non-gateway tags', () => {
  const existing = [
    ['d', 'group-1'],
    ['name', 'Example Group'],
    ['gateway', 'https://old.example', OPERATOR, 'OPEN'],
    ['x-custom', 'keep-me']
  ]
  const gateways = [
    { origin: 'https://new-one.example/path', operatorPubkey: OPERATOR, policy: 'closed' },
    { origin: 'https://new-two.example', operatorPubkey: INVITEE, policy: 'OPEN' }
  ]

  const built = buildGatewayTags(gateways)
  assert.deepEqual(built, [
    ['gateway', 'https://new-one.example', OPERATOR, 'CLOSED'],
    ['gateway', 'https://new-two.example', INVITEE, 'OPEN']
  ])

  const merged = mergeGatewayTags(existing, gateways)
  assert.deepEqual(merged, [
    ['d', 'group-1'],
    ['name', 'Example Group'],
    ['x-custom', 'keep-me'],
    ['gateway', 'https://new-one.example', OPERATOR, 'CLOSED'],
    ['gateway', 'https://new-two.example', INVITEE, 'OPEN']
  ])
})

test('parses kind 30078 metadata/invite/join-request variants', () => {
  const metadataEvent = {
    kind: 30078,
    id: 'meta1',
    pubkey: OPERATOR,
    created_at: 1700000000,
    content: 'encrypted-ban-list',
    tags: [
      ['d', 'hypertuna_gateway:https://gw.example'],
      ['h', 'hypertuna_gateway:metadata'],
      ['operator', OPERATOR],
      ['policy', 'CLOSED'],
      ['allow-list', OPERATOR, INVITEE],
      ['r', 'wss://relay.one'],
      ['r', 'wss://relay.two']
    ]
  }

  const inviteEvent = {
    kind: 30078,
    id: 'invite1',
    pubkey: OPERATOR,
    created_at: 1700000001,
    content: '',
    tags: [
      ['d', 'hypertuna_gateway:https://gw.example'],
      ['h', 'hypertuna_gateway:invite'],
      ['p', INVITEE],
      ['INVITE', 'opaque-token']
    ]
  }

  const joinRequestEvent = {
    kind: 30078,
    id: 'joinreq1',
    pubkey: REQUESTER,
    created_at: 1700000002,
    content: 'please add me',
    tags: [
      ['d', 'hypertuna_gateway:https://gw.example'],
      ['h', 'hypertuna_gateway:join_request'],
      ['p', REQUESTER]
    ]
  }

  assert.deepEqual(parseGatewayMetadataEvent(metadataEvent), {
    id: 'meta1',
    pubkey: OPERATOR,
    createdAt: 1700000000,
    origin: 'https://gw.example',
    operatorPubkey: OPERATOR,
    policy: 'CLOSED',
    allowList: [OPERATOR, INVITEE],
    discoveryRelays: ['wss://relay.one', 'wss://relay.two'],
    content: 'encrypted-ban-list'
  })

  assert.deepEqual(parseGatewayInviteEvent(inviteEvent), {
    id: 'invite1',
    origin: 'https://gw.example',
    inviteePubkey: INVITEE,
    inviteToken: 'opaque-token',
    operatorPubkey: OPERATOR,
    createdAt: 1700000001
  })

  assert.deepEqual(parseGatewayJoinRequestEvent(joinRequestEvent), {
    id: 'joinreq1',
    origin: 'https://gw.example',
    requesterPubkey: REQUESTER,
    content: 'please add me',
    createdAt: 1700000002
  })
})
