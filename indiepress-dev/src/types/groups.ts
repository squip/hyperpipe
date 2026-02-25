import { Event } from '@nostr/tools/wasm'

export type TGroupIdentifier = {
  rawId: string
  groupId: string
  relay?: string
}

export type TGatewayDescriptor = {
  origin: string
  operatorPubkey: string
  policy: 'OPEN' | 'CLOSED'
}

export type TGatewayMetadata = {
  origin: string
  operatorPubkey: string
  policy: 'OPEN' | 'CLOSED'
  allowList: string[]
  banList: string[]
  discoveryRelays: string[]
  content: string
  createdAt?: number | null
  event: Event
}

export type TGatewayDirectoryEntry = {
  origin: string
  operatorPubkey: string
  policy: 'OPEN' | 'CLOSED'
  allowListed: boolean
  popularityCount: number
  followedOperator: boolean
  operatorName?: string | null
  operatorNip05?: string | null
  operatorPicture?: string | null
}

export type TGatewayReachabilityStatus = 'unknown' | 'checking' | 'online' | 'offline'

export type TGatewayReachabilityEntry = {
  status: TGatewayReachabilityStatus
  checkedAt?: number | null
  latencyMs?: number | null
  error?: string | null
}

export type TGatewayInvite = {
  origin: string
  inviteePubkey: string
  inviteToken: string
  operatorPubkey?: string | null
  createdAt?: number | null
  event: Event
}

export type TGatewayJoinRequest = {
  origin: string
  requesterPubkey: string
  content?: string
  createdAt?: number | null
  event: Event
}

export type TGroupMetadata = {
  id: string
  relay?: string
  name: string
  about?: string
  picture?: string
  isPublic?: boolean
  isOpen?: boolean
  tags: string[]
  gateways?: TGatewayDescriptor[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  event: Event
}

export type WriterLeaseEnvelope = {
  version: number
  leaseId: string
  relayKey: string
  publicIdentifier?: string | null
  scope: string
  inviteePubkey: string
  tokenHash: string
  writerCore?: string | null
  writerCoreHex?: string | null
  autobaseLocal?: string | null
  writerSecret: string
  issuedAt: number
  expiresAt: number
  issuerPubkey: string
  issuerPeerKey?: string | null
  signature: string
}

export type TGroupAdmin = {
  pubkey: string
  roles: string[]
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
  groupName?: string
  groupPicture?: string
  name?: string
  about?: string
  authorizedMemberPubkeys?: string[]
  fileSharing?: boolean
  isPublic?: boolean
  relayUrl?: string | null
  relayKey?: string | null
  gatewayOrigins?: string[]
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  writerCore?: string | null
  writerCoreHex?: string | null
  autobaseLocal?: string | null
  writerSecret?: string | null
  writerLease?: WriterLeaseEnvelope | null
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
