import type { FeedService as IFeedService } from './types.js'
import { NostrClient } from './nostrClient.js'
import type { Filter } from 'nostr-tools'

export class FeedService implements IFeedService {
  private client: NostrClient

  constructor(client: NostrClient) {
    this.client = client
  }

  async fetchFeed(relays: string[], filter: Filter, maxWaitMs = 4_000) {
    const events = await this.client.query(relays, filter, maxWaitMs)

    const seen = new Set<string>()
    const deduped = []
    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      deduped.push(event)
    }

    deduped.sort((left, right) => {
      if (left.created_at !== right.created_at) return right.created_at - left.created_at
      return left.id.localeCompare(right.id)
    })

    return deduped
  }
}
