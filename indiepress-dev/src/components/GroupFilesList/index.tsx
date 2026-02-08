import FileMetadataNote from '@/components/Note/FileMetadata'
import Username from '@/components/Username'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  formatGroupFileMime,
  formatGroupFileSize,
  GroupFileRecord,
  GroupFileSortKey,
  parseGroupFileRecordFromEvent
} from '@/lib/group-files'
import { useNostr } from '@/providers/NostrProvider'
import client from '@/services/client.service'
import { TFeedSubRequest } from '@/types'
import { Event as NostrEvent } from '@nostr/tools/wasm'
import { ArrowDown, ArrowUp, ArrowUpDown, AudioLines, Copy, File, Film, Link2 } from 'lucide-react'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

const ENABLE_GROUP_FILES_DEBUG_LOGS = false
const GROUP_FILES_LIMIT = 2000

type SortDirection = 'asc' | 'desc'

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

function getSortValue(record: GroupFileRecord, key: GroupFileSortKey) {
  switch (key) {
    case 'fileName':
      return record.fileName.toLowerCase()
    case 'uploadedBy':
      return record.uploadedBy.toLowerCase()
    case 'mime':
      return (record.mime || '').toLowerCase()
    case 'size':
      return record.size
    case 'uploadedAt':
    default:
      return record.uploadedAt
  }
}

function compareNullableNumbers(left: number | null, right: number | null, direction: SortDirection) {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return direction === 'asc' ? left - right : right - left
}

function compareRecords(left: GroupFileRecord, right: GroupFileRecord, key: GroupFileSortKey, direction: SortDirection) {
  if (key === 'size') {
    return compareNullableNumbers(left.size, right.size, direction)
  }

  if (key === 'uploadedAt') {
    return direction === 'asc'
      ? left.uploadedAt - right.uploadedAt
      : right.uploadedAt - left.uploadedAt
  }

  const leftValue = String(getSortValue(left, key))
  const rightValue = String(getSortValue(right, key))
  return direction === 'asc'
    ? leftValue.localeCompare(rightValue)
    : rightValue.localeCompare(leftValue)
}

function getSortDirectionIcon(isActive: boolean, direction: SortDirection) {
  if (!isActive) return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
  return direction === 'asc' ? (
    <ArrowUp className="h-3.5 w-3.5 text-foreground" />
  ) : (
    <ArrowDown className="h-3.5 w-3.5 text-foreground" />
  )
}

function getThumbnail(record: GroupFileRecord) {
  const mime = (record.mime || '').toLowerCase()
  if (mime.startsWith('image/')) {
    return (
      <img
        src={record.url}
        alt={record.alt || record.fileName}
        className="h-10 w-10 rounded-md object-cover bg-muted/50"
        loading="lazy"
      />
    )
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="relative h-10 w-10 overflow-hidden rounded-md bg-muted/50">
        <video src={record.url} muted preload="metadata" className="h-full w-full object-cover" />
        <Film className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded bg-background/80 p-0.5" />
      </div>
    )
  }
  if (mime.startsWith('audio/')) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/50">
        <AudioLines className="h-4 w-4 text-muted-foreground" />
      </div>
    )
  }
  if (mime) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/50">
        <File className="h-4 w-4 text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/50">
      <File className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

function formatUploadedDate(timestamp: number) {
  return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
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
  const [sortKey, setSortKey] = useState<GroupFileSortKey>('uploadedAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const scopedSubRequests = useMemo(
    () => extendWithLocalSubRequests(subRequests),
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
    setExpandedEventId(null)
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

  const sortedRecords = useMemo(() => {
    return Array.from(recordMap.values()).sort((left, right) =>
      compareRecords(left, right, sortKey, sortDirection)
    )
  }, [recordMap, sortDirection, sortKey])

  const handleSort = (nextKey: GroupFileSortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === nextKey) {
        setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
        debugGroupFiles('sort toggled', {
          sortKey: nextKey
        })
        return currentKey
      }

      setSortDirection(nextKey === 'uploadedAt' ? 'desc' : 'asc')
      debugGroupFiles('sort changed', {
        sortKey: nextKey
      })
      return nextKey
    })
  }

  const openExternalUrl = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('File URL copied')
    } catch (error) {
      toast.error('Failed to copy file URL')
      console.warn('[GroupFilesList] copy URL failed', error)
    }
  }

  if (!groupId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Group not found
      </div>
    )
  }

  if (loading && sortedRecords.length === 0) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (!loading && sortedRecords.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No files uploaded yet
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="hidden items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[48px_minmax(0,2fr)_minmax(140px,1fr)_minmax(140px,1fr)_110px_140px]">
        <span>Preview</span>
        <button type="button" className="flex items-center gap-1 text-left" onClick={() => handleSort('fileName')}>
          <span>Name</span>
          {getSortDirectionIcon(sortKey === 'fileName', sortDirection)}
        </button>
        <button type="button" className="flex items-center gap-1 text-left" onClick={() => handleSort('uploadedAt')}>
          <span>Uploaded</span>
          {getSortDirectionIcon(sortKey === 'uploadedAt', sortDirection)}
        </button>
        <button type="button" className="flex items-center gap-1 text-left" onClick={() => handleSort('uploadedBy')}>
          <span>Uploaded by</span>
          {getSortDirectionIcon(sortKey === 'uploadedBy', sortDirection)}
        </button>
        <button type="button" className="flex items-center gap-1 text-left" onClick={() => handleSort('size')}>
          <span>Size</span>
          {getSortDirectionIcon(sortKey === 'size', sortDirection)}
        </button>
        <button type="button" className="flex items-center gap-1 text-left" onClick={() => handleSort('mime')}>
          <span>Type</span>
          {getSortDirectionIcon(sortKey === 'mime', sortDirection)}
        </button>
      </div>

      <div className="divide-y">
        {sortedRecords.map((record) => {
          const isExpanded = expandedEventId === record.eventId
          const uploadedDate = formatUploadedDate(record.uploadedAt)
          const sizeLabel = formatGroupFileSize(record.size)
          const mimeLabel = formatGroupFileMime(record.mime)
          return (
            <div key={record.eventId} className="w-full">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => {
                  setExpandedEventId((current) => (current === record.eventId ? null : record.eventId))
                  debugGroupFiles('row toggled', {
                    eventId: record.eventId,
                    expanded: !isExpanded
                  })
                }}
                aria-expanded={isExpanded}
              >
                <div className="hidden items-center gap-3 px-3 py-2 md:grid md:grid-cols-[48px_minmax(0,2fr)_minmax(140px,1fr)_minmax(140px,1fr)_110px_140px]">
                  <div>{getThumbnail(record)}</div>
                  <div className="truncate text-sm font-medium">{record.fileName}</div>
                  <div className="text-xs text-muted-foreground">{uploadedDate}</div>
                  <div className="min-w-0">
                    <Username userId={record.uploadedBy} className="truncate text-sm" />
                  </div>
                  <div className="text-xs text-muted-foreground">{sizeLabel}</div>
                  <div className="truncate text-xs text-muted-foreground">{mimeLabel}</div>
                </div>

                <div className="flex items-start gap-3 px-3 py-3 md:hidden">
                  <div className="pt-0.5">{getThumbnail(record)}</div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="truncate text-sm font-medium">{record.fileName}</div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{uploadedDate}</span>
                      <span>{sizeLabel}</span>
                      <span className="truncate">{mimeLabel}</span>
                    </div>
                    <div className="min-w-0">
                      <Username userId={record.uploadedBy} className="truncate text-xs text-muted-foreground" />
                    </div>
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t bg-muted/10 px-3 py-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => openExternalUrl(record.url)}>
                      <Link2 className="mr-1.5 h-3.5 w-3.5" />
                      Open
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => copyUrl(record.url)}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy URL
                    </Button>
                  </div>
                  <FileMetadataNote event={record.event} className="mt-0 border-0 bg-transparent p-0" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
