import GroupFilesTable from '@/components/GroupFilesTable'
import { extendFeedSubRequestsWithLocal } from '@/lib/feed-subrequests'
import { GroupFileRecord, parseGroupFileRecordFromEvent } from '@/lib/group-files'
import { useNostr } from '@/providers/NostrProvider'
import client from '@/services/client.service'
import { TFeedSubRequest } from '@/types'
import { Event as NostrEvent } from '@nostr/tools/wasm'
import { useEffect, useMemo, useState } from 'react'

const ENABLE_GROUP_FILES_DEBUG_LOGS = false
const GROUP_FILES_LIMIT = 2000

const groupFileRecordCache = new Map<string, Map<string, GroupFileRecord>>()

function debugGroupFiles(message: string, data?: Record<string, unknown>) {
  if (!ENABLE_GROUP_FILES_DEBUG_LOGS) return
  if (data) {
    console.info(`[GroupFilesList] ${message}`, data)
    return
  }
  console.info(`[GroupFilesList] ${message}`)
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

function buildCacheKey(groupId: string, subRequests: TFeedSubRequest[]) {
  const relayUrls = Array.from(
    new Set(
      subRequests
        .filter((request): request is Extract<TFeedSubRequest, { source: 'relays' }> => request.source === 'relays')
        .flatMap((request) => request.urls)
    )
  )
    .sort()
    .join('|')
  return `${groupId}|${relayUrls || 'local'}`
}

export default function GroupFilesList({
  groupId,
  subRequests,
  timelineLabel,
  onCountChange
}: {
  groupId?: string
  subRequests: TFeedSubRequest[]
  timelineLabel: string
  onCountChange?: (count: number) => void
}) {
  const { startLogin } = useNostr()
  const [loading, setLoading] = useState(false)

  const scopedSubRequests = useMemo(
    () => extendFeedSubRequestsWithLocal(subRequests),
    [subRequests]
  )

  const cacheKey = useMemo(
    () => buildCacheKey(groupId || 'unknown', scopedSubRequests),
    [groupId, scopedSubRequests]
  )

  const [recordMap, setRecordMap] = useState<Map<string, GroupFileRecord>>(() => {
    const cached = groupFileRecordCache.get(cacheKey)
    return cached ? new Map(cached) : new Map()
  })

  useEffect(() => {
    const cached = groupFileRecordCache.get(cacheKey)
    setRecordMap(cached ? new Map(cached) : new Map())
  }, [cacheKey])

  useEffect(() => {
    onCountChange?.(recordMap.size)
  }, [recordMap.size, onCountChange])

  useEffect(() => {
    if (!groupId || scopedSubRequests.length === 0) {
      setLoading(false)
      setRecordMap(new Map())
      return () => {}
    }

    const cached = groupFileRecordCache.get(cacheKey)
    setLoading(!cached || cached.size === 0)

    debugGroupFiles('subscribe start', {
      groupId,
      timelineLabel,
      subRequests: scopedSubRequests.length,
      cacheSize: cached?.size ?? 0
    })

    const mergeRecords = (events: NostrEvent[], source: 'initial' | 'live') => {
      const incoming = events
        .map(parseGroupFileRecordFromEvent)
        .filter((record): record is GroupFileRecord => Boolean(record))
        .map((record) => (record.groupId === 'unknown' ? { ...record, groupId } : record))

      if (incoming.length === 0) return

      setRecordMap((current) => {
        const next = mergeRecordMaps(current, incoming)
        groupFileRecordCache.set(cacheKey, new Map(next))
        debugGroupFiles('records merged', {
          groupId,
          source,
          incoming: incoming.length,
          total: next.size
        })
        return next
      })
    }

    const subc = client.subscribeTimeline(
      scopedSubRequests,
      {
        kinds: [1063],
        limit: GROUP_FILES_LIMIT
      },
      {
        onEvents: (events, isFinal) => {
          mergeRecords(events, 'initial')
          if (isFinal) {
            setLoading(false)
            debugGroupFiles('initial load complete', {
              groupId,
              count: events.length
            })
          }
        },
        onNew: (event) => {
          mergeRecords([event], 'live')
        }
      },
      {
        startLogin,
        timelineLabel
      }
    )

    return () => {
      debugGroupFiles('subscribe cleanup', {
        groupId,
        timelineLabel
      })
      subc.close('GroupFilesList cleanup')
    }
  }, [cacheKey, groupId, scopedSubRequests, startLogin, timelineLabel])

  if (!groupId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Group not found
      </div>
    )
  }

  return (
    <GroupFilesTable
      records={Array.from(recordMap.values())}
      loading={loading}
      emptyLabel="No files uploaded yet"
      defaultSortKey="uploadedAt"
      defaultSortDirection="desc"
    />
  )
}
