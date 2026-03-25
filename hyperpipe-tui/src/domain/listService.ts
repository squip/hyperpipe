import type { Event, EventTemplate } from 'nostr-tools'
import type { ListService as IListService, StarterPack } from './types.js'
import { NostrClient } from './nostrClient.js'
import { eventNow, signDraftEvent } from '../lib/nostr.js'

function parseStarterPack(event: Event): StarterPack | null {
  const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] || ''
  if (!dTag) return null

  const title = event.tags.find((tag) => tag[0] === 'title')?.[1] || 'Untitled list'
  const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
  const image = event.tags.find((tag) => tag[0] === 'image')?.[1]
  const pubkeys = event.tags
    .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
    .map((tag) => tag[1])

  return {
    id: dTag,
    title,
    description,
    image,
    pubkeys,
    event
  }
}

export class ListService implements IListService {
  private client: NostrClient
  private getNsecHex: () => string
  private getPubkey: () => string

  constructor(client: NostrClient, getNsecHex: () => string, getPubkey: () => string) {
    this.client = client
    this.getNsecHex = getNsecHex
    this.getPubkey = getPubkey
  }

  async fetchStarterPacks(relays: string[], maxWaitMs = 4_000): Promise<StarterPack[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [39089],
        limit: 300
      },
      maxWaitMs
    )

    const byCoordinate = new Map<string, StarterPack>()

    for (const event of events) {
      const parsed = parseStarterPack(event)
      if (!parsed) continue
      const key = `${event.pubkey}:${parsed.id}`
      const existing = byCoordinate.get(key)
      if (!existing || existing.event.created_at < event.created_at) {
        byCoordinate.set(key, parsed)
      }
    }

    return Array.from(byCoordinate.values()).sort(
      (left, right) => right.event.created_at - left.event.created_at
    )
  }

  async publishStarterPack(input: {
    dTag: string
    title: string
    description?: string
    image?: string
    pubkeys: string[]
    relays: string[]
  }): Promise<Event> {
    const tags: string[][] = [
      ['d', input.dTag],
      ['title', input.title]
    ]

    for (const pubkey of Array.from(new Set(input.pubkeys.map((item) => item.trim()).filter(Boolean)))) {
      tags.push(['p', pubkey])
    }

    if (input.description) {
      tags.push(['description', input.description])
    }

    if (input.image) {
      tags.push(['image', input.image])
    }

    const draft: EventTemplate = {
      kind: 39089,
      created_at: eventNow(),
      tags,
      content: ''
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(input.relays, event)
    return event
  }

  async loadFollowList(relays: string[], pubkey: string): Promise<string[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [3],
        authors: [pubkey],
        limit: 5
      },
      4_000
    )

    const latest = events.sort((left, right) => right.created_at - left.created_at)[0]
    if (!latest) return []

    return latest.tags
      .filter((tag) => tag[0] === 'p' && typeof tag[1] === 'string')
      .map((tag) => tag[1])
  }

  async publishFollowList(pubkeys: string[], relays: string[]): Promise<Event> {
    const unique = Array.from(new Set(pubkeys.map((item) => item.trim()).filter(Boolean)))

    const draft: EventTemplate = {
      kind: 3,
      created_at: eventNow(),
      tags: unique.map((pubkey) => ['p', pubkey]),
      content: ''
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(relays, event)
    return event
  }

  currentPubkey(): string {
    return this.getPubkey()
  }
}
