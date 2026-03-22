import {
  DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE,
  choosePreferredMembershipState,
  createGroupMembershipState,
  hydratePersistedGroupMembershipState,
  toPersistedGroupMembershipRecordKey,
  updatePersistedGroupMembershipRecord
} from '@/lib/group-membership'
import indexedDb from '@/services/indexed-db.service'
import type { TGroupMetadata } from '@/types/groups'

describe('group membership persistence', () => {
  it('hydrates from lastComplete on boot', async () => {
    const accountPubkey = `account-${Date.now()}-complete`
    const liveComplete = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'discovery',
      selectedSnapshotCreatedAt: 123
    })
    const record = updatePersistedGroupMembershipRecord(null, {
      accountPubkey,
      groupId: 'group-boot',
      relayBase: 'wss://relay.example',
      lastKnown: liveComplete,
      lastComplete: liveComplete
    })

    await indexedDb.putGroupMembershipCache(record)
    const records = await indexedDb.getAllGroupMembershipCache(accountPubkey)
    const hydrated = hydratePersistedGroupMembershipState(
      records[0]?.lastComplete,
      'persisted-last-complete'
    )

    expect(records).toHaveLength(1)
    expect(records[0]?.key).toBe(
      toPersistedGroupMembershipRecordKey(accountPubkey, 'group-boot', 'wss://relay.example')
    )
    expect(hydrated?.members).toEqual(['alice', 'bob', 'carol'])
    expect(hydrated?.hydrationSource).toBe('persisted-last-complete')
  })

  it('supports keyed reads for direct group hydration', async () => {
    const accountPubkey = `account-${Date.now()}-direct`
    const completeState = createGroupMembershipState({
      members: ['alpha', 'beta'],
      quality: 'complete',
      hydrationSource: 'live-resolved-relay',
      selectedSnapshotSource: 'resolved-relay',
      selectedSnapshotCreatedAt: 456
    })
    const record = updatePersistedGroupMembershipRecord(null, {
      accountPubkey,
      groupId: 'group-direct',
      relayBase: 'wss://relay.example',
      lastKnown: completeState,
      lastComplete: completeState
    })
    await indexedDb.putGroupMembershipCache(record)

    const loaded = await indexedDb.getGroupMembershipCache(
      accountPubkey,
      'group-direct',
      'wss://relay.example'
    )

    expect(loaded?.lastComplete?.members).toEqual(['alpha', 'beta'])
  })

  it('keeps a persisted complete baseline when a smaller warming result arrives', () => {
    const visibleComplete = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'persisted-last-complete',
      selectedSnapshotSource: 'persisted-last-complete',
      selectedSnapshotCreatedAt: 500
    })
    const smallerWarming = createGroupMembershipState({
      members: ['alice'],
      quality: 'warming',
      hydrationSource: 'live-resolved-relay',
      selectedSnapshotSource: 'resolved-relay',
      selectedSnapshotCreatedAt: 400
    })

    const preferred = choosePreferredMembershipState(visibleComplete, smallerWarming)
    const record = updatePersistedGroupMembershipRecord(null, {
      accountPubkey: 'account-visible',
      groupId: 'group-visible',
      relayBase: 'wss://relay.example',
      lastKnown: smallerWarming,
      lastComplete: visibleComplete
    })

    expect(preferred).toBe(visibleComplete)
    expect(record.lastKnown?.members).toEqual(['alice'])
    expect(record.lastComplete?.members).toEqual(['alice', 'bob', 'carol'])
  })

  it('deletes persisted membership on leave', async () => {
    const accountPubkey = `account-${Date.now()}-leave`
    const state = createGroupMembershipState({
      members: ['alice'],
      quality: 'complete',
      hydrationSource: 'live-discovery',
      selectedSnapshotSource: 'discovery'
    })
    const record = updatePersistedGroupMembershipRecord(null, {
      accountPubkey,
      groupId: 'group-leave',
      relayBase: 'wss://relay.example',
      lastKnown: state,
      lastComplete: state
    })
    await indexedDb.putGroupMembershipCache(record)

    await indexedDb.deleteGroupMembershipCache(accountPubkey, 'group-leave', 'wss://relay.example')
    const loaded = await indexedDb.getGroupMembershipCache(
      accountPubkey,
      'group-leave',
      'wss://relay.example'
    )

    expect(loaded).toBeNull()
  })

  it('isolates membership caches per account', async () => {
    const groupId = `group-shared-${Date.now()}`
    const relayBase = 'wss://relay.example'
    const recordA = updatePersistedGroupMembershipRecord(null, {
      accountPubkey: 'account-a',
      groupId,
      relayBase,
      lastKnown: createGroupMembershipState({
        members: ['alice'],
        quality: 'complete',
        hydrationSource: 'live-discovery'
      }),
      lastComplete: createGroupMembershipState({
        members: ['alice'],
        quality: 'complete',
        hydrationSource: 'live-discovery'
      })
    })
    const recordB = updatePersistedGroupMembershipRecord(null, {
      accountPubkey: 'account-b',
      groupId,
      relayBase,
      lastKnown: createGroupMembershipState({
        members: ['bob'],
        quality: 'complete',
        hydrationSource: 'live-discovery'
      }),
      lastComplete: createGroupMembershipState({
        members: ['bob'],
        quality: 'complete',
        hydrationSource: 'live-discovery'
      })
    })

    await indexedDb.putGroupMembershipCache(recordA)
    await indexedDb.putGroupMembershipCache(recordB)

    const recordsA = await indexedDb.getAllGroupMembershipCache('account-a')
    const recordsB = await indexedDb.getAllGroupMembershipCache('account-b')

    expect(recordsA.some((record) => record.groupId === groupId && record.lastKnown?.members[0] === 'alice')).toBe(true)
    expect(recordsB.some((record) => record.groupId === groupId && record.lastKnown?.members[0] === 'bob')).toBe(true)
    expect(recordsA.every((record) => record.accountPubkey === 'account-a')).toBe(true)
    expect(recordsB.every((record) => record.accountPubkey === 'account-b')).toBe(true)
  })

  it('keeps discovery cache records separate from joined relay records', async () => {
    const accountPubkey = `account-${Date.now()}-discovery-scope`
    const groupId = 'group-discovery-scope'
    const joinedState = createGroupMembershipState({
      members: ['alice', 'bob'],
      quality: 'complete',
      hydrationSource: 'live-resolved-relay'
    })
    const discoveryState = createGroupMembershipState({
      members: ['alice', 'bob', 'carol'],
      quality: 'complete',
      hydrationSource: 'live-discovery'
    })

    await indexedDb.putGroupMembershipCache(
      updatePersistedGroupMembershipRecord(null, {
        accountPubkey,
        groupId,
        relayBase: 'wss://relay.example',
        lastKnown: joinedState,
        lastComplete: joinedState
      })
    )
    await indexedDb.putGroupMembershipCache(
      updatePersistedGroupMembershipRecord(null, {
        accountPubkey,
        groupId,
        relayBase: DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE,
        lastKnown: discoveryState,
        lastComplete: discoveryState
      })
    )

    const joinedRecord = await indexedDb.getGroupMembershipCache(
      accountPubkey,
      groupId,
      'wss://relay.example'
    )
    const discoveryRecord = await indexedDb.getGroupMembershipCache(
      accountPubkey,
      groupId,
      DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE
    )

    expect(joinedRecord?.key).toBe(
      toPersistedGroupMembershipRecordKey(accountPubkey, groupId, 'wss://relay.example')
    )
    expect(discoveryRecord?.key).toBe(
      toPersistedGroupMembershipRecordKey(
        accountPubkey,
        groupId,
        DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE
      )
    )
    expect(joinedRecord?.lastComplete?.members).toEqual(['alice', 'bob'])
    expect(discoveryRecord?.lastComplete?.members).toEqual(['alice', 'bob', 'carol'])
  })
})

describe('group metadata persistence', () => {
  const buildMetadata = (groupId: string, creatorPubkey: string, relay?: string): TGroupMetadata => ({
    id: groupId,
    relay,
    name: `Group ${groupId}`,
    about: 'about',
    picture: 'https://example.com/picture.png',
    isPublic: true,
    isOpen: true,
    tags: [],
    event: {
      id: `evt-${groupId}`,
      pubkey: creatorPubkey,
      created_at: 1774217000,
      kind: 39000,
      tags: [
        ['d', groupId],
        ['h', groupId],
        ['name', `Group ${groupId}`],
        ['public'],
        ['open']
      ],
      content: '',
      sig: 'sig'
    } as any
  })

  it('hydrates persisted metadata with creator pubkey', async () => {
    const accountPubkey = `account-${Date.now()}-metadata`
    const metadata = buildMetadata('group-metadata-boot', 'creator-pubkey', 'wss://relay.example')

    await indexedDb.putGroupMetadataCache({
      key: `${accountPubkey}|group-metadata-boot`,
      accountPubkey,
      groupId: metadata.id,
      metadata,
      persistedAt: Date.now()
    })

    const loaded = await indexedDb.getGroupMetadataCache(accountPubkey, metadata.id)

    expect(loaded?.metadata.event.pubkey).toBe('creator-pubkey')
    expect(loaded?.metadata.name).toBe('Group group-metadata-boot')
  })

  it('isolates metadata caches per account', async () => {
    const groupId = `group-metadata-shared-${Date.now()}`
    await indexedDb.putGroupMetadataCache({
      key: `account-a|${groupId}`,
      accountPubkey: 'account-a',
      groupId,
      metadata: buildMetadata(groupId, 'creator-a'),
      persistedAt: Date.now()
    })
    await indexedDb.putGroupMetadataCache({
      key: `account-b|${groupId}`,
      accountPubkey: 'account-b',
      groupId,
      metadata: buildMetadata(groupId, 'creator-b'),
      persistedAt: Date.now()
    })

    const recordsA = await indexedDb.getAllGroupMetadataCache('account-a')
    const recordsB = await indexedDb.getAllGroupMetadataCache('account-b')

    expect(recordsA.some((record) => record.groupId === groupId && record.metadata.event.pubkey === 'creator-a')).toBe(true)
    expect(recordsB.some((record) => record.groupId === groupId && record.metadata.event.pubkey === 'creator-b')).toBe(true)
    expect(recordsA.every((record) => record.accountPubkey === 'account-a')).toBe(true)
    expect(recordsB.every((record) => record.accountPubkey === 'account-b')).toBe(true)
  })
})
