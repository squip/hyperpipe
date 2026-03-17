import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Event, Filter } from 'nostr-tools'
import { TuiController, type RuntimeOptions } from '../src/domain/controller.js'

type ProfileRelayStore = Map<string, Event[]>

type NostrStub = {
  query: (relays: string[], filter: Filter, maxWaitMs?: number) => Promise<Event[]>
  publish: (relays: string[], event: Event, maxWaitMs?: number) => Promise<void>
  destroy: () => void
}

function attachNostrStub(controller: TuiController, stub: NostrStub): void {
  ;(controller as unknown as { nostrClient: NostrStub }).nostrClient = stub
}

function createProfileRelayStub(store: ProfileRelayStore): NostrStub {
  return {
    async query(_relays: string[], filter: Filter): Promise<Event[]> {
      const kinds = Array.isArray(filter.kinds) ? filter.kinds : []
      if (kinds.length > 0 && !kinds.includes(0)) return []

      const authors = Array.isArray(filter.authors)
        ? filter.authors.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : []

      const collected: Event[] = authors.length === 0
        ? Array.from(store.values()).flatMap((events) => events)
        : authors.flatMap((pubkey) => store.get(pubkey) || [])

      const sorted = [...collected].sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
      const limit = Number(filter.limit || 0)
      if (Number.isFinite(limit) && limit > 0) {
        return sorted.slice(0, limit)
      }
      return sorted
    },
    async publish(_relays: string[], event: Event): Promise<void> {
      if (event.kind !== 0 || !event.pubkey) return
      const pubkey = String(event.pubkey || '').trim().toLowerCase()
      if (!pubkey) return
      const existing = store.get(pubkey) || []
      store.set(pubkey, [...existing, event])
    },
    destroy(): void {
      // no-op for tests
    }
  }
}

describe('TuiController profile persistence', () => {
  it('reloads dashboard profile metadata after restart + unlock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypertuna-tui-profile-persist-'))
    const options: RuntimeOptions = {
      cwd: root,
      storageDir: root,
      noAnimations: true,
      logLevel: 'error'
    }
    const relayStore: ProfileRelayStore = new Map()

    const first = new TuiController(options)
    attachNostrStub(first, createProfileRelayStub(relayStore))
    await first.initialize()
    const generated = await first.generateNsecAccount('persist-profile')
    await first.unlockCurrentAccount()
    await first.publishProfileMetadata({
      name: 'Persistent Name',
      about: 'Persistent Bio',
      relays: ['wss://relay.damus.io/']
    })
    expect(first.getState().adminProfileByPubkey[generated.pubkey]?.name).toBe('Persistent Name')
    await first.shutdown()

    const second = new TuiController(options)
    attachNostrStub(second, createProfileRelayStub(relayStore))
    await second.initialize()
    expect(second.getState().currentAccountPubkey).toBe(generated.pubkey)
    await second.unlockCurrentAccount()

    const profile = second.getState().adminProfileByPubkey[generated.pubkey]
    expect(profile?.name).toBe('Persistent Name')
    expect(profile?.bio).toBe('Persistent Bio')

    await second.shutdown()
  })
})
