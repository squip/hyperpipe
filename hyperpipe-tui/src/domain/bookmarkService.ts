import type { Event, EventTemplate } from 'nostr-tools'
import type { BookmarkList, BookmarkService as IBookmarkService } from './types.js'
import { NostrClient } from './nostrClient.js'
import { eventNow, signDraftEvent } from '../lib/nostr.js'

export class BookmarkService implements IBookmarkService {
  private client: NostrClient
  private getPubkey: () => string
  private getNsecHex: () => string

  constructor(client: NostrClient, getPubkey: () => string, getNsecHex: () => string) {
    this.client = client
    this.getPubkey = getPubkey
    this.getNsecHex = getNsecHex
  }

  async loadBookmarks(relays: string[], pubkey: string): Promise<BookmarkList> {
    const events = await this.client.query(
      relays,
      {
        kinds: [10003],
        authors: [pubkey],
        limit: 5
      },
      4_000
    )

    const latest = events.sort((left, right) => right.created_at - left.created_at)[0] || null
    const eventIds = latest
      ? latest.tags
          .filter((tag) => tag[0] === 'e' && typeof tag[1] === 'string')
          .map((tag) => tag[1])
      : []

    return {
      event: latest,
      eventIds
    }
  }

  async publishBookmarks(eventIds: string[], relays: string[]): Promise<Event> {
    const unique = Array.from(new Set(eventIds.map((eventId) => eventId.trim()).filter(Boolean)))
    const tags = unique.map((eventId) => ['e', eventId])

    const draft: EventTemplate = {
      kind: 10003,
      created_at: eventNow(),
      tags,
      content: ''
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(relays, event)
    return event
  }

  addBookmark(input: BookmarkList, eventId: string): string[] {
    const unique = new Set(input.eventIds)
    unique.add(eventId)
    return Array.from(unique)
  }

  removeBookmark(input: BookmarkList, eventId: string): string[] {
    return input.eventIds.filter((id) => id !== eventId)
  }

  currentPubkey(): string {
    return this.getPubkey()
  }
}
