import {
  GroupFileRecord,
  parseGroupFileRecordFromEvent,
  withGroupFileRecordContext
} from '@/lib/group-files'
import { useNostr } from '@/providers/NostrProvider'
import client from '@/services/client.service'
import localStorageService from '@/services/local-storage.service'
import { TFeedSubRequest } from '@/types'
import { Event as NostrEvent } from '@jsr/nostr__tools/wasm'
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { useGroups } from './GroupsProvider'

const ENABLE_GROUP_FILES_PROVIDER_DEBUG_LOGS = false
const GROUP_FILES_LIMIT = 4000
const GROUP_FILES_TIMELINE_LABEL = 'f-fetch-events-global-group-files'

type GroupFilesContextValue = {
  records: GroupFileRecord[]
  count: number
  isLoading: boolean
  lastUpdated: number | null
  refresh: () => Promise<void>
}

const GroupFilesContext = createContext<GroupFilesContextValue | undefined>(undefined)
const globalGroupFileRecordCache = new Map<string, Map<string, GroupFileRecord>>()

function debugGroupFilesProvider(message: string, data?: Record<string, unknown>) {
  if (!ENABLE_GROUP_FILES_PROVIDER_DEBUG_LOGS) return
  if (data) {
    console.info(`[GroupFilesProvider] ${message}`, data)
    return
  }
  console.info(`[GroupFilesProvider] ${message}`)
}

function mergeRecordMaps(
  existing: Map<string, GroupFileRecord>,
  incoming: GroupFileRecord[]
) {
  const next = new Map(existing)
  for (const record of incoming) {
    next.set(record.eventId, record)
  }
  return next
}

function buildFilterSignature(filter: Record<string, unknown>) {
  return JSON.stringify(filter)
}

function extendWithLocalSubRequests(subRequests: TFeedSubRequest[]) {
  const localBySignature = new Map<string, Extract<TFeedSubRequest, { source: 'local' }>>()
  const relayRequests: Extract<TFeedSubRequest, { source: 'relays' }>[] = []

  for (const request of subRequests) {
    if (request.source === 'local') {
      localBySignature.set(buildFilterSignature(request.filter), request)
      continue
    }
    relayRequests.push(request)
  }

  for (const request of relayRequests) {
    const signature = buildFilterSignature(request.filter)
    if (localBySignature.has(signature)) continue
    localBySignature.set(signature, {
      source: 'local',
      filter: request.filter
    })
  }

  return [...localBySignature.values(), ...relayRequests]
}

function isRelayUrl(value: string | null | undefined) {
  if (!value || typeof value !== 'string') return false
  return /^wss?:\/\//.test(value)
}

function buildCacheKey(entries: Array<{ groupId: string; relayUrl: string | null }>) {
  if (entries.length === 0) return 'empty'
  return entries
    .map((entry) => `${entry.relayUrl || 'local'}|${entry.groupId}`)
    .sort()
    .join('||')
}

export function useGroupFiles() {
  const context = useContext(GroupFilesContext)
  if (!context) {
    throw new Error('useGroupFiles must be used within GroupFilesProvider')
  }
  return context
}

export function GroupFilesProvider({ children }: { children: ReactNode }) {
  const { startLogin, pubkey } = useNostr()
  const {
    myGroupList,
    resolveRelayUrl,
    getProvisionalGroupMetadata,
    discoveryGroups
  } = useGroups()
  const [isLoading, setIsLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  const archivedGroupEntries = useMemo(
    () => localStorageService.getArchivedGroupFiles(pubkey),
    [myGroupList, pubkey]
  )

  const normalizedGroupEntries = useMemo(() => {
    const byGroupKey = new Map<
      string,
      { groupId: string; relayUrl: string | null; isArchived: boolean }
    >()

    for (const entry of myGroupList) {
      const groupId = String(entry.groupId || '').trim()
      if (!groupId) continue

      const provisional = getProvisionalGroupMetadata(groupId, entry.relay)
      const discovery = discoveryGroups.find((group) => group.id === groupId)
      const relayCandidates = [
        entry.relay,
        provisional?.relay,
        discovery?.relay,
        groupId
      ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)

      let relayUrl: string | null = null
      for (const candidate of relayCandidates) {
        const resolved = resolveRelayUrl(candidate) || candidate
        if (isRelayUrl(resolved)) {
          relayUrl = resolved
          break
        }
      }

      byGroupKey.set(`${relayUrl || 'local'}|${groupId}`, {
        groupId,
        relayUrl,
        isArchived: false
      })
    }

    for (const entry of archivedGroupEntries) {
      const groupId = String(entry.groupId || '').trim()
      if (!groupId) continue
      const relayUrl = entry.relay ? resolveRelayUrl(entry.relay) || entry.relay : null
      const key = `${relayUrl || 'local'}|${groupId}`
      if (byGroupKey.has(key)) continue
      byGroupKey.set(key, {
        groupId,
        relayUrl,
        isArchived: true
      })
    }

    return Array.from(byGroupKey.values())
  }, [
    archivedGroupEntries,
    discoveryGroups,
    getProvisionalGroupMetadata,
    myGroupList,
    resolveRelayUrl
  ])

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of normalizedGroupEntries) {
      const provisional =
        getProvisionalGroupMetadata(entry.groupId, entry.relayUrl || undefined) ||
        getProvisionalGroupMetadata(entry.groupId)
      const discovery = discoveryGroups.find((group) => group.id === entry.groupId)
      const name = provisional?.name || discovery?.name || entry.groupId
      map.set(entry.groupId, name)
    }
    return map
  }, [discoveryGroups, getProvisionalGroupMetadata, normalizedGroupEntries])

  const groupRelayById = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of normalizedGroupEntries) {
      if (!entry.relayUrl || map.has(entry.groupId)) continue
      map.set(entry.groupId, entry.relayUrl)
    }
    return map
  }, [normalizedGroupEntries])

  const scopedSubRequests = useMemo<TFeedSubRequest[]>(() => {
    const relayGroups = new Map<string, Set<string>>()
    for (const entry of normalizedGroupEntries) {
      if (entry.isArchived) continue
      if (!entry.relayUrl) continue
      const groups = relayGroups.get(entry.relayUrl) || new Set<string>()
      groups.add(entry.groupId)
      relayGroups.set(entry.relayUrl, groups)
    }

    const requests: TFeedSubRequest[] = []

    const allGroupIds = Array.from(new Set(normalizedGroupEntries.map((entry) => entry.groupId)))
    if (allGroupIds.length > 0) {
      requests.push({
        source: 'local',
        filter: {
          '#h': allGroupIds,
          kinds: [1063]
        }
      })
    }

    for (const [relayUrl, groupIds] of relayGroups.entries()) {
      requests.push({
        source: 'relays',
        urls: [relayUrl],
        filter: {
          '#h': Array.from(groupIds),
          kinds: [1063]
        }
      })
    }

    return extendWithLocalSubRequests(requests)
  }, [normalizedGroupEntries])

  const cacheKey = useMemo(
    () => buildCacheKey(normalizedGroupEntries),
    [normalizedGroupEntries]
  )

  const [recordMap, setRecordMap] = useState<Map<string, GroupFileRecord>>(() => {
    const cached = globalGroupFileRecordCache.get(cacheKey)
    return cached ? new Map(cached) : new Map()
  })

  useEffect(() => {
    const cached = globalGroupFileRecordCache.get(cacheKey)
    setRecordMap(cached ? new Map(cached) : new Map())
  }, [cacheKey])

  const mergeEvents = useCallback(
    (events: NostrEvent[], source: 'initial' | 'live' | 'refresh') => {
      const incoming = events
        .map(parseGroupFileRecordFromEvent)
        .filter((record): record is GroupFileRecord => Boolean(record))
        .map((record) =>
          withGroupFileRecordContext(record, {
            groupNameById,
            groupRelayById
          })
        )

      if (incoming.length === 0) return

      setRecordMap((current) => {
        const next = mergeRecordMaps(current, incoming)
        globalGroupFileRecordCache.set(cacheKey, new Map(next))
        debugGroupFilesProvider('records merged', {
          source,
          incoming: incoming.length,
          total: next.size
        })
        return next
      })
      setLastUpdated(Date.now())
    },
    [cacheKey, groupNameById, groupRelayById]
  )

  useEffect(() => {
    if (normalizedGroupEntries.length === 0 || scopedSubRequests.length === 0) {
      setIsLoading(false)
      setRecordMap(new Map())
      return () => {}
    }

    const cached = globalGroupFileRecordCache.get(cacheKey)
    setIsLoading(!cached || cached.size === 0)
    debugGroupFilesProvider('subscribe start', {
      cacheKey,
      groups: normalizedGroupEntries.length,
      subRequests: scopedSubRequests.length,
      cacheSize: cached?.size ?? 0
    })

    const subc = client.subscribeTimeline(
      scopedSubRequests,
      {
        kinds: [1063],
        limit: GROUP_FILES_LIMIT
      },
      {
        onEvents: (events, isFinal) => {
          mergeEvents(events, 'initial')
          if (isFinal) {
            setIsLoading(false)
          }
        },
        onNew: (event) => {
          mergeEvents([event], 'live')
        }
      },
      {
        startLogin,
        timelineLabel: GROUP_FILES_TIMELINE_LABEL
      }
    )

    return () => {
      debugGroupFilesProvider('subscribe cleanup', {
        cacheKey
      })
      subc.close('GroupFilesProvider cleanup')
    }
  }, [cacheKey, mergeEvents, normalizedGroupEntries.length, scopedSubRequests, startLogin])

  const refresh = useCallback(async () => {
    if (scopedSubRequests.length === 0 || normalizedGroupEntries.length === 0) {
      return
    }
    const events = await client.loadMoreTimeline(scopedSubRequests, {
      kinds: [1063],
      limit: GROUP_FILES_LIMIT
    })
    mergeEvents(events, 'refresh')
  }, [mergeEvents, normalizedGroupEntries.length, scopedSubRequests])

  const records = useMemo(
    () => Array.from(recordMap.values()),
    [recordMap]
  )

  const value = useMemo<GroupFilesContextValue>(
    () => ({
      records,
      count: records.length,
      isLoading,
      lastUpdated,
      refresh
    }),
    [isLoading, lastUpdated, records, refresh]
  )

  return (
    <GroupFilesContext.Provider value={value}>
      {children}
    </GroupFilesContext.Provider>
  )
}
