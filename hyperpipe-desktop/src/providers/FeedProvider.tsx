import { DEFAULT_FAVORITE_RELAYS } from '@/constants'
import { isWebsocketUrl, normalizeUrl } from '@/lib/url'
import storage from '@/services/local-storage.service'
import type { RelayEntry } from '@/services/electron-ipc.service'
import { TFeedInfo, TFeedType, TLocalGroupRelayFeedSelection } from '@/types'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useFavoriteRelays } from './FavoriteRelaysProvider'
import { useNostr } from './NostrProvider'
import { useWorkerBridge } from './WorkerBridgeProvider'

type TFeedContext = {
  feedInfo: TFeedInfo
  relayUrls: string[]
  isReady: boolean
  switchFeed: (
    feedType: TFeedType,
    options?: {
      activeRelaySetId?: string
      pubkey?: string
      relay?: string | null
      localGroupRelay?: TLocalGroupRelayFeedSelection | null
    }
  ) => Promise<void>
}

const FeedContext = createContext<TFeedContext | undefined>(undefined)

export const useFeed = () => {
  const context = useContext(FeedContext)
  if (!context) {
    throw new Error('useFeed must be used within a FeedProvider')
  }
  return context
}

function buildIdentifierCandidates(identifier?: string | null) {
  const trimmed = String(identifier || '').trim()
  if (!trimmed) return []
  const candidates = new Set<string>([trimmed])
  if (trimmed.includes(':')) {
    candidates.add(trimmed.replace(':', '/'))
  }
  if (trimmed.includes('/')) {
    candidates.add(trimmed.replace('/', ':'))
  }
  return Array.from(candidates)
}

function normalizeLocalGroupRelaySelection(
  selection?: TLocalGroupRelayFeedSelection | null
): TLocalGroupRelayFeedSelection | null {
  const groupId = String(selection?.groupId || '').trim()
  if (!groupId) return null
  const relayIdentity =
    typeof selection?.relayIdentity === 'string' && selection.relayIdentity.trim()
      ? selection.relayIdentity.trim()
      : null
  return relayIdentity ? { groupId, relayIdentity } : { groupId }
}

function areRelayUrlListsEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((url, index) => url === b[index])
}

function resolveLocalGroupRelayRuntime(
  selection: TLocalGroupRelayFeedSelection | null,
  workerRelays: RelayEntry[]
) {
  if (!selection?.groupId) return null
  const candidates = buildIdentifierCandidates(selection.groupId)
  const relayEntry =
    workerRelays.find(
      (relay) =>
        (relay.publicIdentifier && candidates.includes(relay.publicIdentifier))
        || (relay.relayKey && candidates.includes(relay.relayKey))
    ) || null
  const normalizedRelayUrl = relayEntry?.connectionUrl ? normalizeUrl(relayEntry.connectionUrl) : ''
  const relayUrl = normalizedRelayUrl && isWebsocketUrl(normalizedRelayUrl) ? normalizedRelayUrl : null
  return {
    selection,
    relayUrl,
    readyForReq: relayEntry?.readyForReq === true
  }
}

export function FeedProvider({ children }: { children: React.ReactNode }) {
  const { pubkey, isInitialized } = useNostr()
  const { relays: workerRelays } = useWorkerBridge()
  const { relaySets, urls: relayURLs } = useFavoriteRelays()
  const [relayUrls, setRelayUrls] = useState<string[]>([])
  const [isReady, setIsReady] = useState(false)
  const [feedInfo, setFeedInfo] = useState<TFeedInfo>({
    feedType: 'relay',
    id: DEFAULT_FAVORITE_RELAYS[0]
  })
  const feedInfoRef = useRef<TFeedInfo>(feedInfo)
  const activeLocalGroupRelaySelection = normalizeLocalGroupRelaySelection(
    feedInfo.feedType === 'relay' ? feedInfo.localGroupRelay || null : null
  )
  const activeLocalGroupRelayRuntime = resolveLocalGroupRelayRuntime(
    activeLocalGroupRelaySelection,
    workerRelays
  )

  useEffect(() => {
    const init = async () => {
      if (!isInitialized) {
        return
      }

      let feedInfo: TFeedInfo = {
        feedType: 'relay',
        id: relayURLs[0] ?? DEFAULT_FAVORITE_RELAYS[0]
      }

      if (pubkey) {
        const storedFeedInfo = storage.getFeedInfo(pubkey)
        if (storedFeedInfo) {
          feedInfo = storedFeedInfo
        }
      }

      if (feedInfo.feedType === 'relays') {
        return await switchFeed('relays', { activeRelaySetId: feedInfo.id })
      }

      if (feedInfo.feedType === 'relay') {
        return await switchFeed('relay', {
          relay: feedInfo.id,
          localGroupRelay: feedInfo.localGroupRelay || null
        })
      }

      // update following feed if pubkey changes
      if (feedInfo.feedType === 'following' && pubkey) {
        return await switchFeed('following', { pubkey })
      }
    }

    init()
  }, [pubkey, isInitialized])

  useEffect(() => {
    if (feedInfo.feedType !== 'relay' || !activeLocalGroupRelaySelection) return

    const nextRelayUrls =
      activeLocalGroupRelayRuntime?.readyForReq && activeLocalGroupRelayRuntime.relayUrl
        ? [activeLocalGroupRelayRuntime.relayUrl]
        : []
    setRelayUrls((prev) => (areRelayUrlListsEqual(prev, nextRelayUrls) ? prev : nextRelayUrls))

    const nextRuntimeId = activeLocalGroupRelayRuntime?.relayUrl || undefined
    setFeedInfo((prev) => {
      if (prev.feedType !== 'relay' || !normalizeLocalGroupRelaySelection(prev.localGroupRelay || null)) {
        return prev
      }
      const prevId = typeof prev.id === 'string' && prev.id.trim() ? prev.id.trim() : undefined
      if ((prevId || '') === (nextRuntimeId || '')) return prev

      const nextFeedInfo: TFeedInfo = nextRuntimeId
        ? {
            ...prev,
            id: nextRuntimeId
          }
        : (() => {
            const { id: _id, ...rest } = prev
            return rest as TFeedInfo
          })()
      feedInfoRef.current = nextFeedInfo
      return nextFeedInfo
    })
  }, [
    activeLocalGroupRelayRuntime?.readyForReq,
    activeLocalGroupRelayRuntime?.relayUrl,
    activeLocalGroupRelaySelection?.groupId,
    feedInfo.feedType
  ])

  const switchFeed = async (
    feedType: TFeedType,
    options: {
      activeRelaySetId?: string | null
      pubkey?: string | null
      relay?: string | null
      localGroupRelay?: TLocalGroupRelayFeedSelection | null
    } = {}
  ) => {
    setIsReady(false)

    if (feedType === 'relay') {
      const normalizedUrl = normalizeUrl(options.relay ?? '')
      const normalizedLocalGroupRelay = normalizeLocalGroupRelaySelection(options.localGroupRelay || null)
      if (!normalizedLocalGroupRelay && (!normalizedUrl || !isWebsocketUrl(normalizedUrl))) {
        setIsReady(true)
        return
      }

      const localGroupRelayRuntime = normalizedLocalGroupRelay
        ? resolveLocalGroupRelayRuntime(normalizedLocalGroupRelay, workerRelays)
        : null
      const runtimeRelayUrl = localGroupRelayRuntime?.relayUrl || null
      const newFeedInfo: TFeedInfo = {
        feedType,
        ...((normalizedLocalGroupRelay ? runtimeRelayUrl : normalizedUrl) &&
        isWebsocketUrl(normalizedLocalGroupRelay ? runtimeRelayUrl || '' : normalizedUrl)
          ? {
              id: normalizedLocalGroupRelay ? runtimeRelayUrl || undefined : normalizedUrl
            }
          : {}),
        ...(normalizedLocalGroupRelay
          ? {
              localGroupRelay: normalizedLocalGroupRelay
            }
          : {})
      }
      setFeedInfo(newFeedInfo)
      feedInfoRef.current = newFeedInfo
      setRelayUrls(
        normalizedLocalGroupRelay
          ? localGroupRelayRuntime?.readyForReq && runtimeRelayUrl
            ? [runtimeRelayUrl]
            : []
          : [normalizedUrl]
      )
      storage.setFeedInfo(newFeedInfo, pubkey)
      console.info('[FeedProvider] switched relay feed', {
        relay: normalizedLocalGroupRelay ? runtimeRelayUrl : normalizedUrl,
        localGroupRelay: newFeedInfo.localGroupRelay || null,
        readyForReq: normalizedLocalGroupRelay ? localGroupRelayRuntime?.readyForReq === true : true
      })
      setIsReady(true)
      return
    }

    if (feedType === 'relays') {
      const relaySetId = options.activeRelaySetId ?? (relaySets.length > 0 ? relaySets[0].id : null)
      if (!relaySetId || !pubkey) {
        setIsReady(true)
        return
      }

      const relaySet =
        relaySets.find((set) => set.id === relaySetId) ??
        (relaySets.length > 0 ? relaySets[0] : null)
      // TODO: here before there was some weird piece of code that reloaded the set from indexeddb
      // I don't think that makes any difference, we'll see
      if (relaySet) {
        const newFeedInfo: TFeedInfo = { feedType, id: relaySet.id }
        setFeedInfo(newFeedInfo)
        feedInfoRef.current = newFeedInfo
        setRelayUrls(relaySet.relayUrls)
        storage.setFeedInfo(newFeedInfo, pubkey)
        setIsReady(true)
      }
      setIsReady(true)
      return
    }

    if (feedType === 'following') {
      if (!options.pubkey) {
        setIsReady(true)
        return
      }
      const newFeedInfo = { feedType }
      setFeedInfo(newFeedInfo)
      feedInfoRef.current = newFeedInfo
      storage.setFeedInfo(newFeedInfo, pubkey)

      setRelayUrls([])
      setIsReady(true)
      return
    }
    setIsReady(true)
  }

  return (
    <FeedContext.Provider
      value={{
        feedInfo,
        relayUrls,
        isReady,
        switchFeed
      }}
    >
      {children}
    </FeedContext.Provider>
  )
}
