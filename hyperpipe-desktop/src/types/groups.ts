import { Event } from '@jsr/nostr__tools/wasm'

export type TGroupIdentifier = {
  rawId: string
  groupId: string
  relay?: string
}

export type TGroupMetadata = {
  id: string
  relay?: string
  name: string
  about?: string
  picture?: string
  isPublic?: boolean
  isOpen?: boolean
  discoveryTopic?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  gatewayAuthMethod?: string | null
  gatewayDelegation?: string | null
  gatewaySponsorPubkey?: string | null
  directJoinOnly?: boolean
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  tags: string[]
  event: Event
}

export type TGroupAdmin = {
  pubkey: string
  roles: string[]
}

export type TGroupGatewayAccess = {
  version?: string | null
  authMethod?: string | null
  grantId?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  scopes?: string[]
}

export type TGroupMembershipStatus = 'member' | 'not-member' | 'removed' | 'pending'

export type TGroupMembershipQuality = 'complete' | 'warming' | 'partial'

export type TGroupMembershipHydrationSource =
  | 'live-resolved-relay'
  | 'live-discovery'
  | 'live-op-reconstruction'
  | 'persisted-last-complete'
  | 'persisted-last-known'
  | 'optimistic'
  | 'unknown'

export type TGroupMembershipSnapshotSource =
  | 'resolved-relay'
  | 'discovery'
  | 'op-only'
  | 'persisted-last-complete'
  | 'persisted-last-known'
  | 'optimistic'
  | 'unknown'

export type TGroupMembershipFetchSource =
  | 'group-relay'
  | 'fallback-discovery'
  | 'group-relay-empty'
  | 'persisted-last-complete'
  | 'persisted-last-known'
  | 'optimistic'

export type TGroupMembershipState = {
  members: string[]
  memberCount: number
  membershipStatus: TGroupMembershipStatus
  quality: TGroupMembershipQuality
  hydrationSource: TGroupMembershipHydrationSource
  updatedAt: number
  selectedSnapshotId: string | null
  selectedSnapshotCreatedAt: number | null
  selectedSnapshotSource: TGroupMembershipSnapshotSource | null
  sourcesUsed: TGroupMembershipSnapshotSource[]
  relayReadyForReq: boolean
  relayWritable: boolean
  opsOverflowed: boolean
  authoritative: boolean
  source: TGroupMembershipSnapshotSource
  membershipAuthoritative: boolean
  membershipEventsCount: number
  membersFromEventCount: number
  membersSnapshotCreatedAt: number | null
  membershipFetchTimedOutLike: boolean
  membershipFetchSource: TGroupMembershipFetchSource
}

export type TPersistedGroupMembershipSnapshot = Pick<
  TGroupMembershipState,
  | 'members'
  | 'memberCount'
  | 'membershipStatus'
  | 'quality'
  | 'hydrationSource'
  | 'updatedAt'
  | 'selectedSnapshotId'
  | 'selectedSnapshotCreatedAt'
  | 'selectedSnapshotSource'
  | 'sourcesUsed'
  | 'relayReadyForReq'
  | 'relayWritable'
  | 'opsOverflowed'
  | 'authoritative'
  | 'source'
  | 'membershipAuthoritative'
  | 'membershipEventsCount'
  | 'membersFromEventCount'
  | 'membersSnapshotCreatedAt'
  | 'membershipFetchTimedOutLike'
  | 'membershipFetchSource'
>

export type TPersistedGroupMembershipRecord = {
  key: string
  accountPubkey: string
  groupId: string
  relayBase: string
  lastKnown: TPersistedGroupMembershipSnapshot | null
  lastComplete: TPersistedGroupMembershipSnapshot | null
  persistedAt: number
}

export type TPersistedGroupMetadataRecord = {
  key: string
  accountPubkey: string
  groupId: string
  metadata: TGroupMetadata
  persistedAt: number
}

export type TGroupPresenceSource =
  | 'gateway'
  | 'direct-probe'
  | 'local-worker'
  | 'mixed'
  | 'unknown'

export type TGroupPresenceStatus =
  | 'idle'
  | 'scanning'
  | 'ready'
  | 'error'
  | 'unknown'

export type TGroupPresenceInput = {
  groupId: string
  relay?: string
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
}

export type TGroupPresenceState = {
  count: number | null
  status: TGroupPresenceStatus
  source: TGroupPresenceSource
  gatewayIncluded: boolean
  gatewayHealthy: boolean
  lastUpdatedAt: number | null
  unknown: boolean
  error?: string | null
}

export type TGroupPresenceProbeResult = TGroupPresenceState & {
  verifiedAt: number | null
  usablePeerCount: number | null
  aggregatePeerCount: number | null
  registeredPeerCount: number | null
  staleRegisteredPeerCount: number | null
}

export type TGroupMemberSnapshot = {
  pubkeys: string[]
  event: Event
}

export type TGroupRoles = {
  roles: { name: string; description?: string }[]
  event: Event
}

export type TGroupInvite = {
  groupId: string
  relay?: string
  gatewayId?: string | null
  gatewayOrigin?: string | null
  gatewayAuthMethod?: string | null
  gatewayDelegation?: string | null
  gatewaySponsorPubkey?: string | null
  directJoinOnly?: boolean
  groupName?: string
  groupPicture?: string
  name?: string
  about?: string
  authorizedMemberPubkeys?: string[]
  isOpen?: boolean
  fileSharing?: boolean
  isPublic?: boolean
  relayUrl?: string | null
  relayKey?: string | null
  writerCore?: string | null
  writerCoreHex?: string | null
  autobaseLocal?: string | null
  writerSecret?: string | null
  fastForward?: {
    key?: string | null
    length?: number | null
    signedLength?: number | null
    timeoutMs?: number | null
  } | null
  blindPeer?: {
    publicKey?: string | null
    encryptionKey?: string | null
    replicationTopic?: string | null
    maxBytes?: number | null
  } | null
  cores?: { key: string; role?: string | null }[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  writerLeaseEnvelope?: Record<string, unknown> | null
  gatewayAccess?: TGroupGatewayAccess | null
  token?: string
  event: Event
}

export type TGroupListEntry = {
  groupId: string
  relay?: string
}

export type TJoinRequest = {
  groupId: string
  pubkey: string
  created_at: number
  content?: string
  inviteCode?: string
  event: Event
}
