import {
  APP_WINDOW_GLOBAL,
  BIG_RELAY_URLS,
  DEFAULT_RELAY_LIST,
  ExtendedKind
} from '@/constants'
import {
  applyWarmHydrationCursorToRelayFilter,
  DEFAULT_WARM_HYDRATION_OVERLAP_SECONDS
} from '@/lib/feed-subrequests'
import { isValidPubkey } from '@/lib/pubkey'
import { tagNameEquals } from '@/lib/tag'
import { isLocalNetworkUrl, normalizeUrl } from '@/lib/url'
import { ISigner, TPublishOptions, TRelayList, TMutedList, TFeedSubRequest } from '@/types'
import dayjs from 'dayjs'
import debounce from 'debounce'
import FlexSearch from 'flexsearch'
import { EventTemplate, NostrEvent, validateEvent, VerifiedEvent } from '@nostr/tools/wasm'
import { Filter, matchFilters } from '@nostr/tools/filter'
import * as nip19 from '@nostr/tools/nip19'
import * as kinds from '@nostr/tools/kinds'
import { AbstractRelay } from '@nostr/tools/abstract-relay'
import { pool } from '@nostr/gadgets/global'
import indexedDb from './indexed-db.service'
import {
  loadNostrUser,
  NostrUser,
  nostrUserFromEvent,
  NostrUserRequest
} from '@nostr/gadgets/metadata'
import {
  loadRelayList,
  loadFollowsList,
  loadMuteList,
  loadFavoriteRelays
} from '@nostr/gadgets/lists'
import { loadRelaySets } from '@nostr/gadgets/sets'
import z from 'zod'
import { isHex32 } from '@nostr/gadgets/utils'
import { verifyEvent } from '@nostr/tools/wasm'
import { current, outbox, ready, store } from './outbox.service'
import { SubCloser } from '@nostr/tools/abstract-pool'
import { binarySearch } from '@nostr/tools/utils'
import { seenOn } from '@nostr/gadgets/store'
import { outboxFilterRelayBatch } from '@nostr/gadgets/outbox'

let timelineSubscriptionCounter = 0
const activeTimelineSubscriptionsByLabel = new Map<
  string,
  {
    subscriptionId: number
    close: (reason?: string) => void
  }
>()
const ENABLE_TIMELINE_DEBUG_LOGS = false
const FETCH_EVENTS_MAX_CONCURRENCY = 6
const FETCH_EVENTS_RELAY_COOLDOWN_MS = 8_000
const RATE_LIMIT_REASON_REGEX = /too many concurrent reqs|too many requests|rate[- ]limit|429/i

function debugTimeline(...args: unknown[]) {
  if (!ENABLE_TIMELINE_DEBUG_LOGS) return
  console.info(...args)
}

function sanitizeRelayTransportUrl(url: string): string | null {
  if (typeof url !== 'string') return null
  const normalized = normalizeUrl(url)
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
    if (!parsed.hostname) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function relayHasAuthToken(url: string): boolean {
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    return typeof token === 'string' && token.trim().length > 0
  } catch {
    return false
  }
}

function getRelayIdentity(url: string): string | null {
  const sanitized = sanitizeRelayTransportUrl(url)
  if (!sanitized) return null
  try {
    const parsed = new URL(sanitized)
    parsed.searchParams.delete('token')
    parsed.searchParams.sort()
    return parsed.toString().replace(/\?$/, '')
  } catch {
    return sanitized
  }
}

function preferRelayTransportUrl(current: string, next: string): string {
  const currentHasToken = relayHasAuthToken(current)
  const nextHasToken = relayHasAuthToken(next)
  if (!currentHasToken && nextHasToken) return next
  return current
}

function dedupeRelayUrlsByIdentity(relays: string[]): string[] {
  const byIdentity = new Map<string, string>()
  const orderedIdentities: string[] = []

  for (const relay of relays) {
    const sanitized = sanitizeRelayTransportUrl(relay)
    if (!sanitized) continue
    const identity = getRelayIdentity(sanitized)
    if (!identity) continue
    const existing = byIdentity.get(identity)
    if (!existing) {
      byIdentity.set(identity, sanitized)
      orderedIdentities.push(identity)
      continue
    }
    byIdentity.set(identity, preferRelayTransportUrl(existing, sanitized))
  }

  return orderedIdentities.map((identity) => byIdentity.get(identity) || '').filter(Boolean)
}

class ClientService extends EventTarget {
  static instance: ClientService

  signer?: ISigner
  pubkey?: string
  followings?: Set<string>
  private authCache = new Map<string, number>()
  private inFlightFetchEvents = new Map<string, Promise<NostrEvent[]>>()
  private fetchEventsActiveCount = 0
  private fetchEventsQueue: Array<() => void> = []
  private relayFetchCooldownUntil = new Map<string, number>()

  private trendingNotesCache: NostrEvent[] | null = null

  private userIndex = new FlexSearch.Index({
    tokenize: 'forward'
  })

  constructor() {
    super()
  }

  public static getInstance(): ClientService {
    if (!ClientService.instance) {
      ClientService.instance = new ClientService()
      ClientService.instance.init()
    }
    return ClientService.instance
  }

  async init() {
    try {
      ;(await indexedDb.getAllProfiles()).forEach((profile) => {
        this.addUsernameToIndex(profile)
      })
    } catch (err) {
      console.debug('no profiles to index?', err)
    }
  }

  private async withFetchEventsSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.fetchEventsActiveCount >= FETCH_EVENTS_MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        this.fetchEventsQueue.push(resolve)
      })
    }

    this.fetchEventsActiveCount++
    try {
      return await task()
    } finally {
      this.fetchEventsActiveCount = Math.max(0, this.fetchEventsActiveCount - 1)
      const next = this.fetchEventsQueue.shift()
      if (next) {
        next()
      }
    }
  }

  private markRelayFetchCooldown(relay: string, durationMs = FETCH_EVENTS_RELAY_COOLDOWN_MS) {
    const normalizedRelay = sanitizeRelayTransportUrl(relay)
    if (!normalizedRelay) return
    const relayKey = getRelayIdentity(normalizedRelay) || normalizedRelay
    const until = Date.now() + durationMs
    const current = this.relayFetchCooldownUntil.get(relayKey) || 0
    if (until > current) {
      this.relayFetchCooldownUntil.set(relayKey, until)
    }
  }

  private pruneRelayFetchCooldowns(now = Date.now()) {
    for (const [relay, until] of this.relayFetchCooldownUntil.entries()) {
      if (until <= now) {
        this.relayFetchCooldownUntil.delete(relay)
      }
    }
  }

  private resolveFetchRelayUrls(urls: string[]): string[] {
    const normalized = dedupeRelayUrlsByIdentity(urls)
    if (!normalized.length) return []
    this.pruneRelayFetchCooldowns()
    const now = Date.now()
    return normalized.filter((relay) => {
      const relayKey = getRelayIdentity(relay) || relay
      return (this.relayFetchCooldownUntil.get(relayKey) || 0) <= now
    })
  }

  private applyFetchCloseReasons(relays: string[], reasons: string[] = []) {
    if (!Array.isArray(reasons) || reasons.length === 0 || relays.length === 0) return
    let cooled = false

    for (let i = 0; i < reasons.length; i++) {
      const reason = String(reasons[i] || '')
      if (!reason || !RATE_LIMIT_REASON_REGEX.test(reason)) continue
      const directRelay = relays[i]
      if (directRelay) {
        this.markRelayFetchCooldown(directRelay)
        cooled = true
        continue
      }
      for (const relay of relays) {
        if (reason.includes(relay)) {
          this.markRelayFetchCooldown(relay)
          cooled = true
        }
      }
    }

    if (!cooled && RATE_LIMIT_REASON_REGEX.test(reasons.join(' | '))) {
      relays.forEach((relay) => this.markRelayFetchCooldown(relay))
      cooled = true
    }

    if (cooled) {
      debugTimeline('[fetchEvents] relay cooldown applied', {
        relayCount: relays.length,
        reasons
      })
    }
  }

  async determineTargetRelays(
    event: NostrEvent,
    { specifiedRelayUrls, additionalRelayUrls }: TPublishOptions = {}
  ) {
    if (event.kind === kinds.Report) {
      const targetEventId = event.tags.find(tagNameEquals('e'))?.[1]
      if (targetEventId) {
        const seenRelays = dedupeRelayUrlsByIdentity(this.getSeenEventRelayUrls(targetEventId))
        if (seenRelays.length > 0) {
          return seenRelays
        }
      }
    }

    let relays: string[]
    if (specifiedRelayUrls?.length) {
      relays = specifiedRelayUrls
    } else {
      const _additionalRelayUrls: string[] = additionalRelayUrls ?? []
      if (
        !specifiedRelayUrls?.length &&
        event.kind !== kinds.Contacts &&
        event.kind !== kinds.Mutelist
      ) {
        const mentions: string[] = []
        event.tags.forEach(([tagName, tagValue]) => {
          if (
            ['p', 'P'].includes(tagName) &&
            !!tagValue &&
            isValidPubkey(tagValue) &&
            !mentions.includes(tagValue)
          ) {
            mentions.push(tagValue)
          }
        })
        if (mentions.length > 0) {
          const relayLists = await this.fetchRelayLists(mentions)
          relayLists.forEach((relayList) => {
            _additionalRelayUrls.push(...relayList.read.slice(0, 4))
          })
        }
      }
      if (
        [
          kinds.RelayList,
          kinds.Contacts,
          ExtendedKind.FAVORITE_RELAYS,
          ExtendedKind.BLOSSOM_SERVER_LIST,
          ExtendedKind.RELAY_REVIEW
        ].includes(event.kind)
      ) {
        _additionalRelayUrls.push(...BIG_RELAY_URLS)
      }

      const relayList = await this.fetchRelayList(event.pubkey)
      relays = (relayList?.write.slice(0, 10) ?? []).concat(
        Array.from(new Set(_additionalRelayUrls)) ?? []
      )
    }

    if (!relays.length) {
      relays.push(...BIG_RELAY_URLS)
    }

    const sanitizedRelays = dedupeRelayUrlsByIdentity(relays)
    if (sanitizedRelays.length > 0) {
      return sanitizedRelays
    }
    return dedupeRelayUrlsByIdentity(BIG_RELAY_URLS)
  }

  private async ensureAuth(url: string) {
    if (!this.signer) {
      throw new Error("<not logged in, can't auth to relay>")
    }
    const relay = await pool.ensureRelay(url)
    const evt = await relay.auth((authEvt: EventTemplate) => this.signer!.signEvent(authEvt))
    this.authCache.set(url, Date.now())
    return evt
  }

  async publishEvent(relayUrls: string[], event: NostrEvent) {
    const uniqueRelayUrls = Array.from(new Set(relayUrls))
    const publishId = event.id || 'unknown'
    console.info('[Publish] request', {
      eventId: publishId,
      kind: event.kind,
      relayCount: uniqueRelayUrls.length,
      relays: uniqueRelayUrls.slice(0, 5)
    })
    await new Promise<void>((resolve, reject) => {
      let successCount = 0
      let finishedCount = 0
      const errors: { url: string; error: any }[] = []
      Promise.allSettled(
        uniqueRelayUrls.map(async (url) => {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const that = this
          const relay = await pool.ensureRelay(url)
          relay.publishTimeout = 10_000 // 10s
          const publishOnce = async () => {
            const result = await relay.publish(event)
            const ok =
              typeof result === 'boolean'
                ? result
                : typeof result === 'object' && result !== null && 'ok' in result
                ? (result as { ok?: boolean }).ok !== false
                : true
            if (!ok) {
              const reason =
                typeof result === 'object' && result !== null && 'reason' in result
                  ? (result as { reason?: string }).reason
                  : 'publish rejected'
              throw new Error(reason || 'publish rejected')
            }
            console.info('[Publish] ok', {
              eventId: publishId,
              relay: url,
              ok: true,
              reason:
                typeof result === 'object' && result !== null && 'reason' in result
                  ? (result as { reason?: string }).reason ?? null
                  : null
            })
            this.trackEventSeenOn(event.id, relay)
            successCount++
          }

          return publishOnce()
            .catch(async (error) => {
              const msg = error instanceof Error ? error.message : String(error)
              console.warn('[Publish] error', { eventId: publishId, relay: url, error: msg })
              if (msg.startsWith('auth-required') && that.signer) {
                try {
                  await that.ensureAuth(url)
                  return publishOnce()
                } catch (err) {
                  errors.push({ url, error: err })
                  return
                }
              }
              errors.push({ url, error })
            })
            .finally(() => {
              // If one third of the relays have accepted the event, consider it a success
              const isSuccess = successCount >= uniqueRelayUrls.length / 3
              if (isSuccess) {
                this.emitNewEvent(event)
                resolve()
              }
              if (++finishedCount >= uniqueRelayUrls.length) {
                reject(
                  new AggregateError(
                    errors.map(
                      ({ url, error }) =>
                        new Error(
                          `${url}: ${error instanceof Error ? error.message : String(error)}`
                        )
                    )
                  )
                )
              }
            })
        })
      )
    })
  }

  emitNewEvent(event: NostrEvent) {
    this.dispatchEvent(new CustomEvent('newEvent', { detail: event }))
    this.addEventToCache(event)
  }

  async signHttpAuth(url: string, method: string, description = '') {
    if (!this.signer) {
      throw new Error('Please login first to sign the event')
    }
    const event = await this.signer?.signEvent({
      content: description,
      kind: kinds.HTTPAuth,
      created_at: dayjs().unix(),
      tags: [
        ['u', url],
        ['method', method]
      ]
    })
    return 'Nostr ' + btoa(JSON.stringify(event))
  }

  /** =========== Timeline =========== */

  subscribeTimeline(
    subRequests: TFeedSubRequest[],
    filterModification: Filter,
    {
      onEvents,
      onNew,
      onClose
    }: {
      onEvents: (events: NostrEvent[], isFinal: boolean) => void
      onNew: (evt: NostrEvent) => void
      onClose?: (url: string, reason: string) => void
    },
    {
      startLogin,
      timelineLabel
    }: {
      startLogin?: () => void
      timelineLabel?: string
    } = {}
  ): SubCloser {
    let subc: SubCloser
    const abort = new AbortController()
    const subscriptionId = ++timelineSubscriptionCounter
    const explicitTimelineLabel = timelineLabel?.trim()
    const hasExplicitTimelineLabel = Boolean(explicitTimelineLabel)
    const resolvedTimelineLabel = hasExplicitTimelineLabel
      ? (explicitTimelineLabel as string)
      : 'f-timeline'
    let preliminarySub: SubCloser | undefined
    let removeLocalPublishListener: (() => void) | undefined
    let closed = false
    const unregisterLabelSubscription = () => {
      if (!hasExplicitTimelineLabel) return
      const active = activeTimelineSubscriptionsByLabel.get(resolvedTimelineLabel)
      if (active?.subscriptionId === subscriptionId) {
        activeTimelineSubscriptionsByLabel.delete(resolvedTimelineLabel)
      }
    }
    const closeSubscription = (reason?: string) => {
      if (closed) return
      closed = true
      onClose = undefined
      unregisterLabelSubscription()
      abort.abort(reason ?? '<subc>')
      subc?.close?.(reason)
      preliminarySub?.close?.(reason)
      removeLocalPublishListener?.()
      removeLocalPublishListener = undefined
    }
    const closeReasonForReplacement = `[subscribeTimeline] replaced by ${subscriptionId}`
    if (hasExplicitTimelineLabel) {
      const active = activeTimelineSubscriptionsByLabel.get(resolvedTimelineLabel)
      if (active && active.subscriptionId !== subscriptionId) {
        debugTimeline('[subscribeTimeline] replacing active subscription', {
          timelineLabel: resolvedTimelineLabel,
          previousSubscriptionId: active.subscriptionId,
          replacementSubscriptionId: subscriptionId
        })
        active.close(closeReasonForReplacement)
      }
      activeTimelineSubscriptionsByLabel.set(resolvedTimelineLabel, {
        subscriptionId,
        close: closeSubscription
      })
    }

    const localFilters = subRequests
      .filter((req): req is Extract<TFeedSubRequest, { source: 'local' }> => req.source === 'local')
      .map(({ filter }) => ({
        ...filter,
        ...filterModification
      }))

    const relayRequests = subRequests
      .filter(
        (req): req is Extract<TFeedSubRequest, { source: 'relays' }> => req.source === 'relays'
      )
      .map(({ urls, filter, warmHydrateFromLocalCache, relaySinceOverlapSeconds }) => ({
        urls: this.resolveFetchRelayUrls(urls),
        filter: {
          ...filter,
          ...filterModification
        },
        warmHydrateFromLocalCache: warmHydrateFromLocalCache === true,
        relaySinceOverlapSeconds:
          typeof relaySinceOverlapSeconds === 'number' ? relaySinceOverlapSeconds : undefined
      }))
      .filter(({ urls }) => urls.length > 0)
    const relayUrls = Array.from(
      new Set(relayRequests.flatMap(({ urls }) => urls))
    )
    const subscribedFilters: Filter[] = [
      ...localFilters,
      ...relayRequests.map(({ filter }) => filter)
    ]

    if (subscribedFilters.length > 0) {
      const handleLocalPublish = (customEvent: Event) => {
        const publishedEvent = (customEvent as CustomEvent<NostrEvent>).detail
        if (!publishedEvent || !validateEvent(publishedEvent)) return
        if (!matchFilters(subscribedFilters, publishedEvent)) return
        onNew(publishedEvent)
      }
      this.addEventListener('newEvent', handleLocalPublish as EventListener)
      removeLocalPublishListener = () => {
        this.removeEventListener('newEvent', handleLocalPublish as EventListener)
      }
    }

    debugTimeline('[subscribeTimeline] start', {
      subscriptionId,
      timelineLabel: resolvedTimelineLabel,
      subRequests: subRequests.length,
      localRequests: localFilters.length,
      relayRequests: relayRequests.length,
      relayUrls,
      signer: Boolean(this.signer)
    })

    // do local db requests
    const local: Promise<[NostrEvent[], NostrEvent | undefined, string[]]> =
      localFilters.length === 0
        ? Promise.resolve([[], undefined, []])
        : (async () => {
            let newestEvent: NostrEvent | undefined

            // query from local db
            const events: NostrEvent[] = new Array(200)
            let f = 0
            for (let i = 0; i < localFilters.length; i++) {
              const iter = store.queryEvents(localFilters[i], 5_000)
              const first = await iter.next()

              if (first.value) {
                events[f] = first.value
                f++

                if (!newestEvent || newestEvent.created_at < first.value.created_at) {
                  newestEvent = first.value
                }

                if (!first.done) {
                  for await (const event of iter) {
                    events[f] = event
                    f++
                  }
                }
              }
            }
            events.length = f

            // a background sync may be happening and we may be interested in it, handle when it ends
            current.onsync = debounce(async () => {
              for (let i = 0; i < localFilters.length; i++) {
                const filter = localFilters[i]
                for await (const event of store.queryEvents(filter, 5_000)) {
                  // check if this isn't already in the sorted array of events
                  const [_, exists] = binarySearch(events, (b) => {
                    if (event.id === b.id) return 0
                    if (event.created_at === b.created_at) return -1
                    return b.created_at - event.created_at
                  })
                  if (!exists) {
                    onNew(event)
                  }
                }
              }
            }, 2200)

            // we'll use this for the live query
            const allAuthors = (
              await Promise.all(
                localFilters.map(async (f) => {
                  if (f.authors) return f.authors
                  if (f.followedBy) return (await loadFollowsList(f.followedBy)).items
                  return []
                })
              )
            ).flat()

            // listen for live updates to local db
            ready().then(() => {
              outbox.live(allAuthors, {
                signal: abort.signal
              })

              current.onnew = (event: NostrEvent) => {
                if (matchFilters(localFilters, event)) onNew(event)
              }
            })

            return [events, newestEvent, allAuthors]
          })()

    // do relay requests
    const network =
      relayRequests.length === 0
        ? Promise.resolve([])
        : new Promise<NostrEvent[]>((resolve) => {
            let eosed = false

            const startNetworkSubscription = async () => {
              let effectiveRelayRequests = relayRequests.map(
                ({ urls, filter }) => ({ urls, filter })
              )

              if (
                localFilters.length > 0 &&
                relayRequests.some((request) => request.warmHydrateFromLocalCache)
              ) {
                const [, newestLocalEvent] = await local.catch(() => [[], undefined, []] as const)
                if (abort.signal.aborted) {
                  resolve([])
                  return
                }
                if (newestLocalEvent) {
                  effectiveRelayRequests = relayRequests.map(
                    ({ urls, filter, warmHydrateFromLocalCache, relaySinceOverlapSeconds }) => ({
                      urls,
                      filter: warmHydrateFromLocalCache
                        ? applyWarmHydrationCursorToRelayFilter(
                            filter,
                            newestLocalEvent.created_at,
                            relaySinceOverlapSeconds ?? DEFAULT_WARM_HYDRATION_OVERLAP_SECONDS
                          )
                        : filter
                    })
                  )
                }
              }

              const closeUrls: string[] = []
              let events: NostrEvent[] = []

              subc = pool.subscribeMap(
                effectiveRelayRequests.flatMap(({ urls: requestUrls, filter }) =>
                  requestUrls.flatMap((url) => {
                    if (!closeUrls.includes(url)) closeUrls.push(url)
                    return { url, filter }
                  })
                ),
                {
                  label: resolvedTimelineLabel,
                  onevent: (evt) => {
                    if (!eosed) {
                      events.push(evt)
                    } else {
                      onNew(evt)
                    }

                    // Always persist relay timeline events locally.
                    // Group relays are often relay-only subscriptions, so gating this on localFilters
                    // causes click-through fetches (NotePage, replies, etc.) to miss cached events.
                    this.addEventToCache(evt)
                  },
                  oneose() {
                    eosed = true
                    resolve(events)
                    events = []
                  },
                  onauth: (async (authEvt) => {
                    // already logged in
                    if (this.signer) {
                      const evt = await this.signer!.signEvent(authEvt)
                      if (!evt) {
                        throw new Error('sign event failed')
                      }
                      return evt as VerifiedEvent
                    }

                    // open login dialog
                    if (startLogin) {
                      startLogin()
                    }

                    throw new Error(
                      "<not logged in, can't auth to relay during this.subscribeTimeline>"
                    )
                  }) as (event: EventTemplate) => Promise<VerifiedEvent>,
                  onclose: (reasons) => {
                    this.applyFetchCloseReasons(closeUrls.length ? closeUrls : relayUrls, reasons)
                    const closeReport = reasons.map((reason, index) => ({
                      url: closeUrls[index] || relayUrls[index],
                      reason
                    }))
                    debugTimeline('[subscribeTimeline] onclose', {
                      label: resolvedTimelineLabel,
                      subscriptionId,
                      reasons: closeReport
                    })
                    if (onClose) {
                      for (let i = 0; i < reasons.length; i++) {
                        const reason = reasons[i]
                        const url = closeUrls[i] || relayUrls[i]
                        if (!url) continue
                        onClose(url, reason)
                      }
                    }
                    resolve(events)
                  }
                }
              )
            }

            void startNetworkSubscription()
          })

    if (localFilters.length > 0 && relayRequests.length > 0) {
      // if both exist, assume localFilters will load much faster and handle they first
      local.then(([eventsL]) => {
        if (localFilters.length > 1) eventsL.sort((a, b) => b.created_at - a.created_at)
        onEvents(eventsL, false) // not final: will be called again with all the events later
      })
    }

    if (
      relayRequests.length === 0 &&
      localFilters.length === 1 &&
      (localFilters[0].followedBy || localFilters[0].authors?.length === 1)
    ) {
      // edge case: used mainly on the first time the app is used
      // in case we're fetching a _following feed_ or _profile feed_ solely from the local db but we have nothing
      // (or only very old events) do a temporary fallback relay query here while the sync completes
      local.then(async ([_, newestEvent, allAuthors]) => {
        if (!newestEvent || newestEvent.created_at < Date.now() / 1000 - 60 * 60 * 24 * 7) {
          const events: NostrEvent[] = []
          const temporaryFilter = { ...localFilters[0], limit: 10 }
          if (temporaryFilter.followedBy) {
            temporaryFilter.authors = (await loadFollowsList(temporaryFilter.followedBy)).items
            if (!temporaryFilter.authors.includes(temporaryFilter.followedBy))
              temporaryFilter.authors.push(temporaryFilter.followedBy)
            delete temporaryFilter.followedBy
          }
          preliminarySub = pool.subscribeMap(
            await outboxFilterRelayBatch(allAuthors, temporaryFilter),
            {
              label: `f-temporary`,
              onevent(event) {
                events.push(event)
              },
              oneose() {
                preliminarySub!.close('preliminary req closed automatically on eose')
                events.sort((a, b) => b.created_at - a.created_at)
                onEvents(events, false) // not final. it will be final when the sync completes
              }
            }
          )

          // now the sync is complete, do the query again
          ready().then(async () => {
            const events: NostrEvent[] = new Array(200)
            let f = 0
            for (let i = 0; i < localFilters.length; i++) {
              for await (const event of store.queryEvents(localFilters[i], 5_000)) {
                events[f] = event
                f++
              }
            }
            events.length = f
            events.sort((a, b) => b.created_at - a.created_at)
            onEvents(events, true)
          })
        }
      })
    }

    Promise.all([local, network]).then(([[eventsL], eventsN]) => {
      if (eventsL.length > 0 && eventsN.length > 0) {
        eventsL.push(...eventsN)
        eventsL.sort((a, b) => b.created_at - a.created_at)
        onEvents(
          eventsL.filter((item, i) => i === 0 || item.id !== eventsL[i - 1].id),
          true
        )
      } else if (eventsL.length) {
        if (localFilters.length > 1) eventsL.sort((a, b) => b.created_at - a.created_at)
        onEvents(eventsL, true)
      } else if (eventsN.length) {
        if (relayRequests.length > 1 || relayRequests[0].urls.length > 1)
          eventsN.sort((a, b) => b.created_at - a.created_at)
        onEvents(eventsN, true)
      } else {
        // No events found, but still need to signal completion
        onEvents([], true)
      }
    })

    return {
      close(reason?: string) {
        closeSubscription(reason)
      }
    }
  }

  async loadMoreTimeline(
    subRequests: TFeedSubRequest[],
    filterModification: Filter,
    {
      startLogin
    }: {
      startLogin?: () => void
    } = {}
  ): Promise<NostrEvent[]> {
    const localFilters = subRequests
      .filter((req): req is Extract<TFeedSubRequest, { source: 'local' }> => req.source === 'local')
      .map(({ filter }) => ({
        ...filter,
        ...filterModification
      }))

    const relayRequests = subRequests
      .filter(
        (req): req is Extract<TFeedSubRequest, { source: 'relays' }> => req.source === 'relays'
      )
      .map(({ urls, filter, warmHydrateFromLocalCache, relaySinceOverlapSeconds }) => ({
        urls: this.resolveFetchRelayUrls(urls),
        filter: {
          ...filter,
          ...filterModification
        },
        warmHydrateFromLocalCache: warmHydrateFromLocalCache === true,
        relaySinceOverlapSeconds:
          typeof relaySinceOverlapSeconds === 'number' ? relaySinceOverlapSeconds : undefined
      }))
      .filter(({ urls }) => urls.length > 0)

    // do local requests
    const local =
      localFilters.length === 0
        ? Promise.resolve({ events: [] as NostrEvent[], newestEvent: undefined as NostrEvent | undefined })
        : (async () => {
            const events: NostrEvent[] = new Array(200)
            let f = 0
            let newestEvent: NostrEvent | undefined
            for (let i = 0; i < localFilters.length; i++) {
              const filter = localFilters[i]
              for await (const event of store.queryEvents(filter, 5_000)) {
                events[f] = event
                f++
                if (!newestEvent || newestEvent.created_at < event.created_at) {
                  newestEvent = event
                }
              }
            }
            events.length = f
            return { events, newestEvent }
          })()

    const shouldApplyWarmHydrationCursor =
      typeof filterModification.until !== 'number' &&
      localFilters.length > 0 &&
      relayRequests.some((request) => request.warmHydrateFromLocalCache)

    // do relay requests
    const network =
      relayRequests.length === 0
        ? Promise.resolve([])
        : await new Promise<NostrEvent[]>(async (resolve) => {
            const localNewestEvent = shouldApplyWarmHydrationCursor
              ? (await local.catch(() => ({
                  events: [] as NostrEvent[],
                  newestEvent: undefined as NostrEvent | undefined
                }))).newestEvent
              : undefined
            const effectiveRelayRequests = relayRequests.map(
              ({ urls, filter, warmHydrateFromLocalCache, relaySinceOverlapSeconds }) => ({
                urls,
                filter:
                  warmHydrateFromLocalCache && localNewestEvent
                    ? applyWarmHydrationCursorToRelayFilter(
                        filter,
                        localNewestEvent.created_at,
                        relaySinceOverlapSeconds ?? DEFAULT_WARM_HYDRATION_OVERLAP_SECONDS
                      )
                    : filter
              })
            )
            const relayUrls = Array.from(
              new Set(effectiveRelayRequests.flatMap(({ urls }) => urls))
            )
            if (relayUrls.length === 0) {
              resolve([])
              return
            }

            const events: NostrEvent[] = []
            const subc = pool.subscribeMap(
              effectiveRelayRequests.flatMap(({ urls, filter }) =>
                urls.flatMap((url) => ({ url, filter }))
              ),
              {
                label: 'f-more',
                onevent: (evt) => {
                  events.push(evt)
                  this.addEventToCache(evt)
                },
                oneose() {
                  subc.close()
                  resolve(events)
                },
                onclose: (reasons) => {
                  this.applyFetchCloseReasons(relayUrls, reasons)
                  const closeReport = reasons.map((reason, index) => ({
                    url: relayUrls[index],
                    reason
                  }))
                  debugTimeline('[loadMoreTimeline] onclose', {
                    label: 'f-more',
                    reasons: closeReport
                  })
                  resolve(events)
                },
                onauth: (async (authEvt) => {
                  // already logged in
                  if (this.signer) {
                    const evt = await this.signer!.signEvent(authEvt)
                    if (!evt) {
                      throw new Error('sign event failed')
                    }
                    return evt as VerifiedEvent
                  }

                  // open login dialog
                  if (startLogin) {
                    startLogin()
                    return
                  }

                  throw new Error(
                    "<not logged in, can't auth to relay during this.loadMoreTimeline>"
                  )
                }) as (event: EventTemplate) => Promise<VerifiedEvent>
              }
            )
          })

    return Promise.all([local, network]).then(([localResult, eventsN]) => {
      const eventsL = localResult.events
      if (eventsL.length > 0 && eventsN.length > 0) {
        eventsL.push(...eventsN)
        eventsL.sort((a, b) => b.created_at - a.created_at)
        return eventsL
      } else if (eventsL.length) {
        if (localFilters.length > 1) eventsL.sort((a, b) => b.created_at - a.created_at)
        return eventsL
      } else if (eventsN.length) {
        if (relayRequests.length > 1 || relayRequests[0]?.urls.length > 1)
          eventsN.sort((a, b) => b.created_at - a.created_at)
        return eventsN
      } else {
        return []
      }
    })
  }

  /** =========== Event =========== */

  getSeenEventRelays(eventId: string) {
    return Array.from(pool.seenOn.get(eventId)?.values() || [])
  }

  getSeenEventRelayUrls(eventId: string, event?: NostrEvent) {
    const poolUrls = this.getSeenEventRelays(eventId).map((relay) => relay.url)

    // events loaded from the store may have a special list of "seenOn" relays attached
    const relays = event ? seenOn(event) : []
    const combined = new Set([...poolUrls, ...relays])

    return Array.from(combined)
  }

  getEventHints(eventId: string, event?: NostrEvent) {
    return this.getSeenEventRelayUrls(eventId, event).filter((url) => !isLocalNetworkUrl(url))
  }

  getEventHint(eventId: string, event?: NostrEvent) {
    return this.getSeenEventRelayUrls(eventId, event).find((url) => !isLocalNetworkUrl(url)) ?? ''
  }

  trackEventSeenOn(eventId: string, relay: AbstractRelay) {
    let set = pool.seenOn.get(eventId)
    if (!set) {
      set = new Set()
      pool.seenOn.set(eventId, set)
    }
    set.add(relay)
  }

  private buildFetchEventsRequestKey(urls: string[], filter: Filter, cache: boolean) {
    const normalizeValue = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        const normalized = value.map((entry) =>
          typeof entry === 'string' ? entry.trim() : normalizeValue(entry)
        )
        const areScalars = normalized.every((entry) =>
          ['string', 'number', 'boolean'].includes(typeof entry)
        )
        if (areScalars) {
          return (normalized as Array<string | number | boolean>)
            .slice()
            .sort((left, right) => String(left).localeCompare(String(right)))
        }
        return normalized
      }
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        Object.keys(value as Record<string, unknown>)
          .sort()
          .forEach((key) => {
            out[key] = normalizeValue((value as Record<string, unknown>)[key])
          })
        return out
      }
      return value
    }

    const normalizedUrls = Array.from(
      new Set(
        urls
          .map((url) => getRelayIdentity(url) || sanitizeRelayTransportUrl(url) || '')
          .filter(Boolean)
      )
    ).sort()
    const normalizedFilter = normalizeValue(filter || {})
    return JSON.stringify({
      urls: normalizedUrls,
      filter: normalizedFilter,
      cache
    })
  }

  async fetchEvents(
    urls: string[],
    filter: Filter,
    {
      cache = false
    }: {
      onevent?: (evt: NostrEvent) => void
      cache?: boolean
    } = {}
  ) {
    const relays = this.resolveFetchRelayUrls(urls)
    if (!relays.length) {
      return []
    }
    const requestKey = this.buildFetchEventsRequestKey(relays, filter, cache)
    const existingRequest = this.inFlightFetchEvents.get(requestKey)
    if (existingRequest) {
      return existingRequest
    }

    const request = this.withFetchEventsSlot(async () => {
      const events: NostrEvent[] = []

      await new Promise<void>((resolve) => {
        pool.subscribeEose(relays, filter, {
          label: 'f-fetch-events',
          maxWait: 10_000,
          onauth: (async (authEvt) => {
            if (this.signer) {
              const evt = await this.signer!.signEvent(authEvt)
              if (!evt) {
                throw new Error('sign event failed')
              }
              return evt as VerifiedEvent
            }

            throw new Error("<not logged in, can't auth to relay during this.subscribeTimeline>")
          }) as (event: EventTemplate) => Promise<VerifiedEvent>,
          onevent: (event: NostrEvent) => {
            events.push(event)
            if (cache) {
              this.addEventToCache(event)
            }
          },
          onclose: (reasons: string[]) => {
            this.applyFetchCloseReasons(relays, reasons)
            resolve()
          }
        })
      })

      return events
    })

    this.inFlightFetchEvents.set(requestKey, request)
    request.finally(() => {
      if (this.inFlightFetchEvents.get(requestKey) === request) {
        this.inFlightFetchEvents.delete(requestKey)
      }
    })
    return request
  }

  async fetchTrendingNotes() {
    if (this.trendingNotesCache) {
      return this.trendingNotesCache
    }

    try {
      const response = await fetch('https://api.nostr.band/v0/trending/notes')
      const data = await response.json()
      const events: NostrEvent[] = []
      for (const note of data.notes ?? []) {
        if (validateEvent(note.event)) {
          events.push(note.event)
          this.addEventToCache(note.event)
          if (note.relays?.length) {
            note.relays.map((r: string) => {
              try {
                const relay = new AbstractRelay(r, {
                  verifyEvent: verifyEvent
                })
                this.trackEventSeenOn(note.event.id, relay)
              } catch {
                return null
              }
            })
          }
        }
      }
      this.trendingNotesCache = events
      return this.trendingNotesCache
    } catch (error) {
      console.error('fetchTrendingNotes error', error)
      return []
    }
  }

  addEventToCache(event: NostrEvent) {
    store.saveEvent(event, {
      seenOn: Array.from(pool.seenOn.get(event.id) || []).map((relay) => relay.url),
      followedBy:
        this.pubkey && (this.pubkey === event.pubkey || this.followings?.has(event.pubkey))
          ? [this.pubkey]
          : undefined
    })
  }

  async fetchEvent(idOrCode: string): Promise<NostrEvent | undefined> {
    let filter: Filter | undefined
    let relayHints: string[] = []
    let authorHint: string | undefined
    if (isHex32(idOrCode)) {
      filter = { ids: [idOrCode] }
    } else {
      const { type, data } = nip19.decode(idOrCode)
      switch (type) {
        case 'note':
          filter = { ids: [data] }
          break
        case 'nevent':
          filter = { ids: [data.id] }
          if (data.relays) relayHints = data.relays
          if (data.author) authorHint = data.author
          break
        case 'naddr':
          filter = {
            authors: [data.pubkey],
            kinds: [data.kind],
            limit: 1
          }
          authorHint = data.pubkey
          if (data.identifier) {
            filter['#d'] = [data.identifier]
          }
          if (data.relays) relayHints = data.relays
      }
    }

    if (!filter) {
      throw new Error(`can't fetch ${idOrCode}`)
    }

    // Preserve any relay context we already observed for this event in the current session.
    // This is important for local/group relay events where the bech32 payload may not carry hints.
    if (Array.isArray(filter.ids) && filter.ids.length === 1) {
      const seenRelayHints = this.getSeenEventRelayUrls(filter.ids[0])
      if (seenRelayHints.length > 0) {
        relayHints = Array.from(new Set([...relayHints, ...seenRelayHints]))
      }
    }

    // before we try any network fetch try to load this from our local database
    for await (const event of store.queryEvents(filter, 1)) {
      // if we get anything we just return it
      return event
    }

    // start fetching this here so it's finished later when we need it
    const authorRelays = authorHint && loadRelayList(authorHint)

    // try the relay hints first
    if (relayHints.length) {
      relayHints = dedupeRelayUrlsByIdentity(relayHints)
      const event = await pool.get(relayHints, filter, { label: 'f-specific-event-1' })
      if (event) {
        this.addEventToCache(event)
        return event
      }
    }

    // at this point we may already have our author hints so let's try those
    let authorRelaysUrls: string[] = []
    if (authorRelays) {
      authorRelaysUrls = (await authorRelays).items
        .filter((r) => r.write && !relayHints.includes(r.url))
        .map((r) => r.url)
      authorRelaysUrls = dedupeRelayUrlsByIdentity(authorRelaysUrls)
      if (authorRelaysUrls.length) {
        const event = await pool.get(authorRelaysUrls, filter, { label: 'f-specific-event-2' })
        if (event) {
          this.addEventToCache(event)
          return event
        }
      }
    }

    // if we got nothing or there were no hints, try the big relays (except the ones we've already tried)
    const bigRelayHints = dedupeRelayUrlsByIdentity(
      BIG_RELAY_URLS.filter((br) => !(relayHints.includes(br) || authorRelaysUrls.includes(br)))
        .concat(['wss://cache2.primal.net/v1'])
    )
    if (bigRelayHints.length) {
      const event = await pool.get(bigRelayHints, filter, { label: 'f-specific-event-3' })
      if (event) {
        this.addEventToCache(event)
        return event
      }
    }
  }

  /** =========== Followings =========== */

  async initUserIndexFromFollowings(pubkey: string) {
    ;(await loadFollowsList(pubkey)).items.forEach((pubkey) => this.fetchProfile(pubkey))
  }

  /** =========== Profile =========== */

  async searchProfiles(relayUrls: string[], filter: Filter): Promise<NostrUser[]> {
    const events = await pool.querySync(
      relayUrls,
      {
        ...filter,
        kinds: [kinds.Metadata]
      },
      { label: 'f-search-profiles', maxWait: 5_000 }
    )

    const profiles = events.map(nostrUserFromEvent)
    await Promise.allSettled(profiles.map((profile) => this.addUsernameToIndex(profile)))
    return profiles
  }

  async searchPubKeysFromLocal(query: string, limit: number = 100): Promise<string[]> {
    return this.userIndex.searchAsync(query, { limit }) as Promise<string[]>
  }

  async searchProfilesFromLocal(query: string, limit: number = 100): Promise<NostrUser[]> {
    const pubkeys = await this.searchPubKeysFromLocal(query, limit)
    const profiles = await Promise.all(pubkeys.map((pubkey) => this.fetchProfile(pubkey)))
    return profiles.filter((profile) => !!profile)
  }

  private async addUsernameToIndex(profile: NostrUser) {
    const nip05 = typeof profile.metadata.nip05 === 'string' ? profile.metadata.nip05 : ''
    const text = [
      profile.metadata.display_name?.trim() ?? '',
      profile.metadata.name?.trim() ?? '',
      nip05
        .split('@')
        .map((s: string) => s.trim())
        .join(' ') ?? ''
    ].join(' ')
    if (!text) return

    await this.userIndex.addAsync(profile.pubkey, text)
  }

  async fetchProfile(input: string, forceUpdate: boolean | NostrEvent = false): Promise<NostrUser> {
    let req: NostrUserRequest | undefined

    if (isValidPubkey(input)) {
      req = { pubkey: input }
    } else {
      try {
        const { type, data } = nip19.decode(input)
        if (type === 'npub') {
          req = { pubkey: data }
        } else if (type === 'nprofile') {
          req = data
        } else {
          throw new Error('not a profile reference')
        }
      } catch (error) {
        throw new Error('Error decoding user ref input: ' + input + ', error: ' + error)
      }
    }

    if (forceUpdate) {
      req!.refreshStyle = true
    }
    const profile = await loadNostrUser(req!)
    // Emit event for profile updates
    this.dispatchEvent(new CustomEvent('profileFetched:' + profile.pubkey, { detail: profile }))
    return profile
  }

  /** =========== Relay list =========== */
  async fetchRelayLists(pubkeys: string[], forceUpdate = false): Promise<TRelayList[]> {
    return Promise.all(pubkeys.map((pk) => this.fetchRelayList(pk, forceUpdate)))
  }

  async fetchRelayList(
    pubkey: string,
    forceUpdate: boolean | NostrEvent = false
  ): Promise<TRelayList> {
    return loadRelayList(pubkey, [], forceUpdate).then((r) => {
      if (!r.event) {
        const defaults = structuredClone(DEFAULT_RELAY_LIST)
        return {
          ...defaults,
          read: dedupeRelayUrlsByIdentity(defaults.read || []),
          write: dedupeRelayUrlsByIdentity(defaults.write || [])
        }
      } else {
        const readRelays = dedupeRelayUrlsByIdentity(
          r.items.filter((item) => item.read).map((item) => item.url)
        )
        const writeRelays = dedupeRelayUrlsByIdentity(
          r.items.filter((item) => item.write).map((item) => item.url)
        )
        const originalRelays = r.items
          .map(({ url, read, write }) => {
            const normalizedUrl = sanitizeRelayTransportUrl(url)
            if (!normalizedUrl) return null
            return {
              url: normalizedUrl,
              scope: read && write ? 'both' : read ? 'read' : 'write'
            } as const
          })
          .filter((relay): relay is { url: string; scope: 'read' | 'write' | 'both' } => !!relay)

        return {
          write: writeRelays,
          read: readRelays,
          originalRelays
        }
      }
    })
  }

  async fetchMuteList(
    pubkey: string,
    nip04Decrypt: undefined | ((pubkey: string, content: string) => Promise<string>),
    forceUpdate: boolean | NostrEvent = false
  ): Promise<TMutedList> {
    const muteList: TMutedList = {
      public: [],
      private: []
    }

    const result = await loadMuteList(pubkey, [], forceUpdate)

    muteList.public = result.items
      .filter((item) => item.label === 'pubkey')
      .map((item) => item.value)

    if (result.event && nip04Decrypt) {
      try {
        const plainText = await nip04Decrypt(pubkey, result.event.content)
        const privateTags = z.array(z.array(z.string())).parse(JSON.parse(plainText))

        for (let i = 0; i < privateTags.length; i++) {
          const tag = privateTags[i]
          if (tag[0] === 'p' && tag.length >= 2 && isHex32(tag[1])) {
            muteList.private.push(tag[1])
          }
        }
      } catch (_) {
        /***/
      }
    }

    return muteList
  }

  async fetchStarterPackEvents(pubkey: string, extraRelayUrls: string[] = []) {
    const relayList = await this.fetchRelayList(pubkey)
    const relayUrls = dedupeRelayUrlsByIdentity(
      relayList.read.concat(relayList.write).concat(extraRelayUrls).concat(BIG_RELAY_URLS)
    )
    if (!relayUrls.length) {
      return []
    }

    const events = await this.fetchEvents(
      relayUrls,
      {
        kinds: [ExtendedKind.STARTER_PACK],
        authors: [pubkey]
      },
      { cache: true }
    )

    const latestByCoordinate = new Map<string, NostrEvent>()
    for (const event of events) {
      const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1]
      if (!dTag) continue
      const coordinate = `${event.pubkey}:${dTag}`
      const current = latestByCoordinate.get(coordinate)
      if (!current || current.created_at < event.created_at) {
        latestByCoordinate.set(coordinate, event)
      }
    }

    return Array.from(latestByCoordinate.values()).sort((a, b) => b.created_at - a.created_at)
  }

  async fetchStarterPackEvent(pubkey: string, dTag: string, extraRelayUrls: string[] = []) {
    const relayList = await this.fetchRelayList(pubkey)
    const relayUrls = dedupeRelayUrlsByIdentity(
      relayList.read.concat(relayList.write).concat(extraRelayUrls).concat(BIG_RELAY_URLS)
    )
    if (!relayUrls.length) {
      return undefined
    }

    return await pool.get(
      relayUrls,
      {
        kinds: [ExtendedKind.STARTER_PACK],
        authors: [pubkey],
        '#d': [dTag],
        limit: 1
      },
      { label: 'f-starter-pack-single' }
    )
  }

  /** =========== Following favorite relays =========== */

  async fetchFollowingFavoriteRelays(pubkey: string): Promise<[string, Set<string>][]> {
    const waitgroup: Promise<void>[] = []
    const urls = new Map<string, Set<string>>()

    const followings = await loadFollowsList(pubkey)
    followings.items.forEach((pubkey) => {
      let r1: () => void
      const p1 = new Promise<void>((resolve) => {
        r1 = resolve
      })
      waitgroup.push(p1)

      loadFavoriteRelays(pubkey).then((fav) => {
        fav.items.forEach((url) => {
          if (typeof url !== 'string') return // TODO: load these too
          url = sanitizeRelayTransportUrl(url) || ''
          if (!url) return
          const thisurl = urls.get(url) || new Set()
          thisurl.add(pubkey)
          urls.set(url, thisurl)
        })
        r1()
      })

      let r2: () => void
      const p2 = new Promise<void>((resolve) => {
        r2 = resolve
      })
      waitgroup.push(p2)

      loadRelaySets(pubkey).then((favsets) => {
        Object.values(favsets).forEach((favset) => {
          favset.items.forEach((url) => {
            url = sanitizeRelayTransportUrl(url) || ''
            if (!url) return
            const thisurl = urls.get(url) || new Set()
            thisurl.add(pubkey)
            urls.set(url, thisurl)
          })
        })
        r2()
      })
    })

    await Promise.all(waitgroup)
    return Array.from(urls.entries()).sort(
      ([_urlA, usersA], [_urlB, usersB]) => usersB.size - usersA.size
    )
  }
}

const instance = ClientService.getInstance()

;(window as any)[APP_WINDOW_GLOBAL] = (window as any)[APP_WINDOW_GLOBAL] || {}
;(window as any)[APP_WINDOW_GLOBAL].client = instance

export default instance
