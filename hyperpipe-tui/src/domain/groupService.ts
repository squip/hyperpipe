import type { Event, EventTemplate } from 'nostr-tools'
import type {
  GroupJoinRequest,
  GroupInvite,
  GroupListEntry,
  GroupService as IGroupService,
  GroupSummary
} from './types.js'
import { NostrClient } from './nostrClient.js'
import { parseGroupListEvent } from '../lib/groups.js'
import { eventNow, signDraftEvent } from '../lib/nostr.js'
import type { WorkerHost } from '../runtime/workerHost.js'
import {
  applyGroupDiscoveryParity,
  filterActionableJoinRequests,
  parseGroupInviteWithPayload,
  parseJoinRequestEvent
} from './parity/groupFilters.js'
import { HYPERPIPE_IDENTIFIER_TAG, KIND_HYPERPIPE_RELAY } from '../lib/hyperpipe-group-events.js'

export class GroupService implements IGroupService {
  private client: NostrClient
  private workerHost: WorkerHost
  private getNsecHex: () => string

  constructor(client: NostrClient, workerHost: WorkerHost, getNsecHex: () => string) {
    this.client = client
    this.workerHost = workerHost
    this.getNsecHex = getNsecHex
  }

  async discoverGroups(relays: string[], limit = 250): Promise<GroupSummary[]> {
    const [metadataEvents, relayEvents] = await Promise.all([
      this.client.query(
        relays,
        {
          kinds: [39000],
          '#i': [HYPERPIPE_IDENTIFIER_TAG],
          limit
        },
        2_800
      ),
      this.client.query(
        relays,
        {
          kinds: [KIND_HYPERPIPE_RELAY],
          '#i': [HYPERPIPE_IDENTIFIER_TAG],
          limit: Math.max(limit, 300)
        },
        2_800
      )
    ])

    return applyGroupDiscoveryParity({
      metadataEvents,
      relayEvents
    })
  }

  async discoverInvites(
    relays: string[],
    pubkey: string,
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>
  ): Promise<GroupInvite[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [9009],
        '#p': [pubkey],
        limit: 200
      },
      5_000
    )

    const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
      let timeoutId: NodeJS.Timeout | null = null
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`invite decrypt timeout after ${timeoutMs}ms`))
            }, timeoutMs)
          })
        ])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    }

    const invites = await Promise.all(events.map(async (event) => {
      let decryptedPayload: Record<string, unknown> | null = null

      if (event.content) {
        try {
          const plaintext = await withTimeout(decrypt(event.pubkey, event.content), 1_200)
          const payload = JSON.parse(plaintext)
          if (payload && typeof payload === 'object') {
            decryptedPayload = payload as Record<string, unknown>
          }
        } catch {
          // keep invite even if content decrypt fails or times out
        }
      }

      return parseGroupInviteWithPayload({
        event,
        decryptedPayload
      })
    }))

    invites.sort((left, right) => right.event.created_at - left.event.created_at)
    return invites
  }

  async loadMyGroupList(relays: string[], pubkey: string): Promise<GroupListEntry[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [10009],
        authors: [pubkey],
        limit: 1
      },
      2_500
    )
    const sorted = events.sort((left, right) => right.created_at - left.created_at)
    const latest = sorted[0]
    if (!latest) return []
    return parseGroupListEvent(latest).map((entry) => ({
      groupId: entry.groupId,
      relay: entry.relay
    }))
  }

  async saveMyGroupList(
    relays: string[],
    _pubkey: string,
    nsecHex: string,
    entries: GroupListEntry[]
  ): Promise<void> {
    const tags: string[][] = []
    for (const entry of entries) {
      const groupId = String(entry.groupId || '').trim()
      if (!groupId) continue
      const relay = String(entry.relay || '').trim()
      if (relay) {
        tags.push(['group', groupId, relay])
      } else {
        tags.push(['group', groupId])
      }
    }

    const draft: EventTemplate = {
      kind: 10009,
      created_at: eventNow(),
      tags,
      content: ''
    }

    const event = signDraftEvent(nsecHex, draft)
    await this.client.publish(relays, event)
  }

  dismissInvite(inviteIds: Set<string>, inviteId: string): Set<string> {
    const normalizedInviteId = String(inviteId || '').trim()
    if (!normalizedInviteId) return new Set(inviteIds)
    const next = new Set(inviteIds)
    next.add(normalizedInviteId)
    return next
  }

  markInviteAccepted(
    acceptedInviteIds: Set<string>,
    acceptedGroupIds: Set<string>,
    inviteId: string,
    groupId?: string
  ): { inviteIds: Set<string>; groupIds: Set<string> } {
    const nextInviteIds = new Set(acceptedInviteIds)
    const nextGroupIds = new Set(acceptedGroupIds)
    const normalizedInviteId = String(inviteId || '').trim()
    const normalizedGroupId = String(groupId || '').trim()

    if (normalizedInviteId) nextInviteIds.add(normalizedInviteId)
    if (normalizedGroupId) nextGroupIds.add(normalizedGroupId)

    return {
      inviteIds: nextInviteIds,
      groupIds: nextGroupIds
    }
  }

  async loadJoinRequests(
    relays: string[],
    groupId: string,
    opts?: { handledKeys?: Set<string>; currentMembers?: Set<string> }
  ): Promise<GroupJoinRequest[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [9021],
        '#h': [groupId],
        limit: 200
      },
      5_000
    )

    const parsed = events
      .map((event) => parseJoinRequestEvent(event))
      .filter((event): event is GroupJoinRequest => !!event)

    return filterActionableJoinRequests({
      requests: parsed,
      handledKeys: opts?.handledKeys,
      currentMembers: opts?.currentMembers
    })
  }

  async approveJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.updateMembers({
      publicIdentifier: groupId,
      relayKey: relay && /^[a-f0-9]{64}$/i.test(relay) ? relay.toLowerCase() : undefined,
      memberAdds: [{ pubkey, ts: Date.now() }]
    })
  }

  async rejectJoinRequest(groupId: string, pubkey: string, relay?: string): Promise<void> {
    await this.workerHost.send({
      type: 'reject-join-request',
      data: {
        publicIdentifier: groupId,
        relayKey: relay && /^[a-f0-9]{64}$/i.test(relay) ? relay.toLowerCase() : undefined,
        pubkey
      }
    })
  }

  async sendInvite(input: {
    groupId: string
    relayUrl: string
    inviteePubkey: string
    token?: string
    payload: Record<string, unknown>
    encrypt: (pubkey: string, plaintext: string) => Promise<string>
    relayTargets: string[]
  }) {
    const payload = {
      ...input.payload,
      relayUrl: input.relayUrl,
      token: input.token
    }

    const encrypted = await input.encrypt(input.inviteePubkey, JSON.stringify(payload))

    const draft: EventTemplate = {
      kind: 9009,
      created_at: eventNow(),
      tags: [
        ['h', input.groupId],
        ['p', input.inviteePubkey],
        ['i', 'hyperpipe']
      ],
      content: encrypted
    }

    if (payload.isOpen === true) {
      draft.tags.push(['open'])
    }
    if (payload.isPublic === true) {
      draft.tags.push(['public'])
    }
    if (typeof payload.fileSharing === 'boolean') {
      draft.tags.push([payload.fileSharing ? 'file-sharing-on' : 'file-sharing-off'])
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(input.relayTargets, event)
    return event
  }

  async updateMembers(input: {
    relayKey?: string
    publicIdentifier?: string
    members?: string[]
    memberAdds?: Array<{ pubkey: string; ts: number }>
    memberRemoves?: Array<{ pubkey: string; ts: number }>
  }): Promise<void> {
    const sent = await this.workerHost.send({
      type: 'update-members',
      data: {
        relayKey: input.relayKey,
        publicIdentifier: input.publicIdentifier,
        members: input.members,
        member_adds: input.memberAdds,
        member_removes: input.memberRemoves
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to update members')
    }
  }

  async updateAuthData(input: {
    relayKey?: string
    publicIdentifier?: string
    pubkey: string
    token: string
  }): Promise<void> {
    const sent = await this.workerHost.send({
      type: 'update-auth-data',
      data: {
        relayKey: input.relayKey,
        publicIdentifier: input.publicIdentifier,
        pubkey: input.pubkey,
        token: input.token
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to update auth data')
    }
  }

  async sendJoinRequest(input: {
    groupId: string
    reason?: string
    code?: string
    relayTargets: string[]
  }): Promise<Event> {
    const tags: string[][] = [['h', input.groupId]]
    const code = String(input.code || '').trim()
    if (code) {
      tags.push(['code', code])
    }

    const draft: EventTemplate = {
      kind: 9021,
      created_at: eventNow(),
      tags,
      content: typeof input.reason === 'string' ? input.reason : ''
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(input.relayTargets, event)
    return event
  }
}
