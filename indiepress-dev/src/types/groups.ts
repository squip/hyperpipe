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
  tags: string[]
  event: Event
}

export type TGroupAdmin = {
  pubkey: string
  roles: string[]
}

export type TGroupMembershipStatus = 'member' | 'not-member' | 'removed' | 'pending'

export type TInviteMirrorSnapshot = {
  relayKey?: string | null
  publicIdentifier?: string | null
  relayUrl?: string | null
  mirrorSource?: string | null
  updatedAt?: number | null
  fetchedAt?: number | null
  inviteTraceId?: string | null
  blindPeer?: {
    publicKey?: string | null
    encryptionKey?: string | null
    replicationTopic?: string | null
    maxBytes?: number | null
  } | null
  cores?: { key: string; role?: string | null }[]
} | null

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
  name?: string
  about?: string
  fileSharing?: boolean
  relayUrl?: string | null
  relayKey?: string | null
  inviteProof?: {
    payload?: {
      relayKey?: string | null
      publicIdentifier?: string | null
      inviteePubkey?: string | null
      authToken?: string | null
      inviteTraceId?: string | null
      issuedAt?: number | null
      version?: number | null
    }
    signature?: string | null
    scheme?: string | null
  } | null
  writerCore?: string | null
  writerCoreHex?: string | null
  autobaseLocal?: string | null
  writerSecret?: string | null
  blindPeer?: {
    publicKey?: string | null
    encryptionKey?: string | null
    replicationTopic?: string | null
    maxBytes?: number | null
  } | null
  cores?: { key: string; role?: string | null }[]
  mirrorSnapshot?: TInviteMirrorSnapshot
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
