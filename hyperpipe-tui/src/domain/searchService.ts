import type { Event } from 'nostr-tools'
import type { SearchResult, SearchService as ISearchService } from './types.js'
import { NostrClient } from './nostrClient.js'

function includesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase())
}

function eventHasQuery(event: Event, query: string): boolean {
  if (includesQuery(event.content || '', query)) return true
  for (const tag of event.tags) {
    if (tag.some((part) => includesQuery(String(part || ''), query))) {
      return true
    }
  }
  return false
}

function mapResults(mode: SearchResult['mode'], events: Event[], query: string): SearchResult[] {
  const filtered = query
    ? events.filter((event) => eventHasQuery(event, query))
    : events

  return filtered.map((event) => ({
    mode,
    event
  }))
}

export class SearchService implements ISearchService {
  private client: NostrClient

  constructor(client: NostrClient) {
    this.client = client
  }

  async searchNotes(relays: string[], query: string, limit = 200): Promise<SearchResult[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [1],
        limit
      },
      5_000
    )
    return mapResults('notes', events, query).slice(0, limit)
  }

  async searchProfiles(relays: string[], query: string, limit = 200): Promise<SearchResult[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [0],
        limit
      },
      5_000
    )
    return mapResults('profiles', events, query).slice(0, limit)
  }

  async searchGroups(relays: string[], query: string, limit = 200): Promise<SearchResult[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [39000, 9007, 9009],
        limit
      },
      5_000
    )
    return mapResults('groups', events, query).slice(0, limit)
  }

  async searchLists(relays: string[], query: string, limit = 200): Promise<SearchResult[]> {
    const events = await this.client.query(
      relays,
      {
        kinds: [39089, 10009],
        limit
      },
      5_000
    )
    return mapResults('lists', events, query).slice(0, limit)
  }
}
