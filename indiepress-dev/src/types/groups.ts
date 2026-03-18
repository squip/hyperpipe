import { Event } from '@nostr/tools/wasm'

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
