import { SimplePool, type Event, type Filter } from 'nostr-tools'
import WebSocket from 'ws'
import { uniqueRelayUrls } from '../lib/nostr.js'

export type LiveSubscription = {
  close: () => void
}

export class NostrClient {
  private pool: SimplePool
  private querySequence = 0

  constructor() {
    // Node 20 and earlier may not expose a global WebSocket constructor.
    // nostr-tools expects one to exist in non-browser environments.
    if (typeof globalThis.WebSocket === 'undefined') {
      ;(globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
    }

    this.pool = new SimplePool({
      enableReconnect: true
    })
  }

  private nextQueryId(): string {
    this.querySequence = (this.querySequence + 1) % 1_000_000
    return `f-fetch-events-${Date.now().toString(36)}-${this.querySequence.toString(36)}`
  }

  async query(relays: string[], filter: Filter, maxWaitMs = 4_000): Promise<Event[]> {
    const targets = uniqueRelayUrls(relays)
    if (!targets.length) return []

    return this.pool.querySync(targets, filter, {
      maxWait: maxWaitMs,
      id: this.nextQueryId(),
      label: 'hypertuna-tui-query'
    })
  }

  async publish(relays: string[], event: Event, maxWaitMs = 8_000): Promise<void> {
    const targets = uniqueRelayUrls(relays)
    if (!targets.length) {
      throw new Error('No relay targets provided')
    }

    const writes = this.pool.publish(targets, event, { maxWait: maxWaitMs })
    await Promise.allSettled(writes)
  }

  subscribe(
    relays: string[],
    filter: Filter,
    handlers: {
      onevent: (event: Event) => void
      oneose?: () => void
      onclose?: (reasons: string[]) => void
    }
  ): LiveSubscription {
    const targets = uniqueRelayUrls(relays)
    if (!targets.length) {
      return {
        close: () => {
          // no-op
        }
      }
    }

    const sub = this.pool.subscribeMany(targets, filter, {
      onevent: handlers.onevent,
      oneose: handlers.oneose,
      onclose: handlers.onclose
    })

    return {
      close: () => sub.close('manual-close')
    }
  }

  destroy(): void {
    this.pool.destroy()
  }
}
