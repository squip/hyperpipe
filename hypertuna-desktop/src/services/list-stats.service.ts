import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import { getZapInfoFromEvent } from '@/lib/event-metadata'
import { dedupeRelayUrlsByIdentity } from '@/lib/relay-targets'
import client from '@/services/client.service'
import dayjs from 'dayjs'
import { Event } from '@nostr/tools/wasm'
import { Filter } from '@nostr/tools/filter'
import * as kinds from '@nostr/tools/kinds'

export type TListStats = {
  zapPrSet: Set<string>
  zaps: { pr: string; pubkey: string; amount: number; created_at: number; comment?: string }[]
  updatedAt?: number
}

class ListStatsService {
  static instance: ListStatsService
  private listStatsMap: Map<string, Partial<TListStats>> = new Map()
  private inFlightFetchMap: Map<string, Promise<Partial<TListStats>>> = new Map()
  private activeFetchCount = 0
  private fetchQueue: Array<() => void> = []
  private readonly refreshCooldownSeconds = 60
  private readonly maxConcurrentFetches = 3

  constructor() {
    if (!ListStatsService.instance) {
      ListStatsService.instance = this
    }
    return ListStatsService.instance
  }

  private getListKey(authorPubkey: string, dTag: string): string {
    return `${authorPubkey}:${dTag}`
  }

  private async runWithFetchLimit<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeFetchCount >= this.maxConcurrentFetches) {
      await new Promise<void>((resolve) => {
        this.fetchQueue.push(resolve)
      })
    }

    this.activeFetchCount++
    try {
      return await task()
    } finally {
      this.activeFetchCount = Math.max(0, this.activeFetchCount - 1)
      const next = this.fetchQueue.shift()
      if (next) next()
    }
  }

  async fetchListStats(authorPubkey: string, dTag: string, pubkey?: string | null) {
    const listKey = this.getListKey(authorPubkey, dTag)
    const requestKey = `${listKey}:${pubkey || ''}`
    const now = dayjs().unix()
    const oldStats = this.listStatsMap.get(listKey)

    if (oldStats?.updatedAt && now - oldStats.updatedAt < this.refreshCooldownSeconds) {
      return oldStats
    }

    const existingRequest = this.inFlightFetchMap.get(requestKey)
    if (existingRequest) {
      return existingRequest
    }

    const request = this.runWithFetchLimit(async () => {
      const currentStats = this.listStatsMap.get(listKey)
      let since: number | undefined
      if (currentStats?.updatedAt) {
        since = currentStats.updatedAt
      }

      const [authorProfile, authorRelayList] = await Promise.all([
        client.fetchProfile(authorPubkey),
        client.fetchRelayList(authorPubkey)
      ])

      const coordinate = `${ExtendedKind.STARTER_PACK}:${authorPubkey}:${dTag}`
      const filters: Filter[] = []

      const lightningAddress =
        authorProfile?.metadata?.lud16 ||
        authorProfile?.metadata?.lud06 ||
        (authorProfile as any)?.lightningAddress

      if (lightningAddress) {
        filters.push({
          '#a': [coordinate],
          kinds: [kinds.Zap],
          limit: 500
        })

        if (pubkey) {
          filters.push({
            '#a': [coordinate],
            '#P': [pubkey],
            kinds: [kinds.Zap]
          })
        }
      }

      if (since) {
        filters.forEach((filter) => {
          filter.since = since
        })
      }

      if (!filters.length) {
        const next = {
          ...(currentStats ?? {}),
          updatedAt: dayjs().unix()
        }
        this.listStatsMap.set(listKey, next)
        return next
      }

      const events: Event[] = []
      const relays = dedupeRelayUrlsByIdentity(authorRelayList.read.concat(BIG_RELAY_URLS)).slice(0, 5)

      for (const filter of filters) {
        try {
          const fetched = await client.fetchEvents(relays, filter)
          events.push(...(fetched as Event[]))
        } catch (error) {
          console.error('Failed to fetch list stats', error)
        }
      }

      this.updateListStatsByEvents(authorPubkey, dTag, events)
      const next = {
        ...(this.listStatsMap.get(listKey) ?? {}),
        updatedAt: dayjs().unix()
      }
      this.listStatsMap.set(listKey, next)
      return next
    })

    this.inFlightFetchMap.set(requestKey, request)
    request.finally(() => {
      if (this.inFlightFetchMap.get(requestKey) === request) {
        this.inFlightFetchMap.delete(requestKey)
      }
    })
    return request
  }

  private getListStats(authorPubkey: string, dTag: string): Partial<TListStats> | undefined {
    const listKey = this.getListKey(authorPubkey, dTag)
    return this.listStatsMap.get(listKey)
  }

  private addZap(
    authorPubkey: string,
    dTag: string,
    zapperPubkey: string,
    pr: string,
    amount: number,
    comment?: string,
    created_at: number = dayjs().unix()
  ) {
    const listKey = this.getListKey(authorPubkey, dTag)
    const old = this.listStatsMap.get(listKey) || {}
    const zapPrSet = old.zapPrSet || new Set()
    const zaps = old.zaps || []
    if (zapPrSet.has(pr)) return

    zapPrSet.add(pr)
    zaps.push({ pr, pubkey: zapperPubkey, amount, comment, created_at })
    this.listStatsMap.set(listKey, { ...old, zapPrSet, zaps })
  }

  private addZapByEvent(authorPubkey: string, dTag: string, evt: Event) {
    const info = getZapInfoFromEvent(evt)
    if (!info) return
    const { senderPubkey, invoice, amount, comment } = info
    if (!senderPubkey) return

    this.addZap(authorPubkey, dTag, senderPubkey, invoice, amount, comment, evt.created_at)
  }

  updateListStatsByEvents(authorPubkey: string, dTag: string, events: Event[]) {
    events.forEach((evt) => {
      if (evt.kind === kinds.Zap) {
        this.addZapByEvent(authorPubkey, dTag, evt)
      }
    })
  }

  getTotalZapAmount(authorPubkey: string, dTag: string): number {
    const stats = this.getListStats(authorPubkey, dTag)
    if (!stats?.zaps) return 0
    return stats.zaps.reduce((acc, zap) => acc + zap.amount, 0)
  }
}

const instance = new ListStatsService()
export default instance
