import type { EventTemplate } from 'nostr-tools'
import type {
  GroupInvite,
  GroupService as IGroupService,
  GroupSummary
} from './types.js'
import { NostrClient } from './nostrClient.js'
import { parseGroupInviteEvent, parseGroupMetadataEvent } from '../lib/groups.js'
import { eventNow, signDraftEvent } from '../lib/nostr.js'
import type { WorkerHost } from '../runtime/workerHost.js'

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
    const events = await this.client.query(
      relays,
      {
        kinds: [39000],
        limit
      },
      5_000
    )

    const byCoordinate = new Map<string, GroupSummary>()

    for (const event of events) {
      const parsed = parseGroupMetadataEvent(event)
      if (!parsed.id) continue
      const key = `${event.pubkey}:${parsed.id}`
      const current = byCoordinate.get(key)
      if (!current || (current.event?.created_at || 0) < event.created_at) {
        byCoordinate.set(key, {
          id: parsed.id,
          relay: parsed.relay,
          name: parsed.name,
          about: parsed.about,
          picture: parsed.picture,
          isPublic: parsed.isPublic,
          isOpen: parsed.isOpen,
          event
        })
      }
    }

    return Array.from(byCoordinate.values()).sort(
      (left, right) => (right.event?.created_at || 0) - (left.event?.created_at || 0)
    )
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
        limit: 300
      },
      5_000
    )

    const invites: GroupInvite[] = []

    for (const event of events) {
      const parsed = parseGroupInviteEvent(event)
      let token: string | undefined

      if (event.content) {
        try {
          const plaintext = await decrypt(event.pubkey, event.content)
          const payload = JSON.parse(plaintext)
          if (typeof payload?.token === 'string') {
            token = payload.token
          }
        } catch {
          // keep invite even if content decrypt fails
        }
      }

      invites.push({
        id: event.id,
        groupId: parsed.groupId,
        relay: parsed.relay,
        groupName: parsed.groupName,
        groupPicture: parsed.groupPicture,
        isPublic: parsed.isPublic,
        fileSharing: parsed.fileSharing,
        token,
        event
      })
    }

    invites.sort((left, right) => right.event.created_at - left.event.created_at)
    return invites
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
        ['i', 'hypertuna']
      ],
      content: encrypted
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
}
