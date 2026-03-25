import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools'
import { NostrClient } from '../src/domain/nostrClient.js'

function profileEvent(): Event {
  return {
    id: 'e'.repeat(64),
    pubkey: '1'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 0,
    tags: [],
    content: '{"name":"test"}',
    sig: 'f'.repeat(128)
  }
}

describe('NostrClient.publish', () => {
  it('throws when all relay publishes fail', async () => {
    const client = new NostrClient()
    ;(client as unknown as {
      pool: {
        publish: () => Promise<unknown>[]
      }
    }).pool = {
      publish: () => [
        Promise.reject(new Error('relay a failed')),
        Promise.reject(new Error('relay b failed'))
      ]
    }

    await expect(
      client.publish(['wss://relay-a.example', 'wss://relay-b.example'], profileEvent())
    ).rejects.toThrow(/Failed to publish event to all relay targets/i)
  })

  it('succeeds when at least one relay publish succeeds', async () => {
    const client = new NostrClient()
    ;(client as unknown as {
      pool: {
        publish: () => Promise<unknown>[]
      }
    }).pool = {
      publish: () => [
        Promise.reject(new Error('relay a failed')),
        Promise.resolve(undefined)
      ]
    }

    await expect(
      client.publish(['wss://relay-a.example', 'wss://relay-b.example'], profileEvent())
    ).resolves.toBeUndefined()
  })
})
