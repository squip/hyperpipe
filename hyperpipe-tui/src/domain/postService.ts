import type { Event, EventTemplate } from 'nostr-tools'
import type { PostService as IPostService } from './types.js'
import { NostrClient } from './nostrClient.js'
import {
  buildReactionTags,
  buildReplyTags,
  eventNow,
  signDraftEvent
} from '../lib/nostr.js'

export class PostService implements IPostService {
  private client: NostrClient
  private getNsecHex: () => string

  constructor(client: NostrClient, getNsecHex: () => string) {
    this.client = client
    this.getNsecHex = getNsecHex
  }

  async publishTextNote(content: string, relays: string[]): Promise<Event> {
    const draft: EventTemplate = {
      kind: 1,
      created_at: eventNow(),
      tags: [],
      content
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(relays, event)
    return event
  }

  async publishReply(
    content: string,
    replyToEventId: string,
    replyToPubkey: string,
    relays: string[]
  ): Promise<Event> {
    const draft: EventTemplate = {
      kind: 1,
      created_at: eventNow(),
      tags: buildReplyTags(replyToEventId, replyToPubkey),
      content
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(relays, event)
    return event
  }

  async publishReaction(
    eventId: string,
    eventPubkey: string,
    reaction: string,
    relays: string[]
  ): Promise<Event> {
    const draft: EventTemplate = {
      kind: 7,
      created_at: eventNow(),
      tags: buildReactionTags(eventId, eventPubkey),
      content: reaction
    }

    const event = signDraftEvent(this.getNsecHex(), draft)
    await this.client.publish(relays, event)
    return event
  }
}
