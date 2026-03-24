import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import GroupCreateDialog from '@/components/GroupCreateDialog'
import TitlebarInfoButton from '@/components/TitlebarInfoButton'
import Username from '@/components/Username'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { toGroup } from '@/lib/link'
import { usePrimaryPage, useSecondaryPage } from '@/PageManager'
import { useFetchProfile } from '@/hooks'
import {
  DISCOVER_GROUPS_PRESENCE_TTL_MS,
  MY_GROUPS_PRESENCE_TTL_MS,
  useGroupPresenceMap
} from '@/hooks/useGroupPresence'
import { compareGroupPresenceStates, createGroupPresenceState } from '@/lib/group-presence'
import { useGroups } from '@/providers/GroupsProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import type { TGroupInvite, TGroupMembershipState, TGroupPresenceState } from '@/types/groups'
import { TPageRef } from '@/types'
import dayjs from 'dayjs'
import { ArrowDown, ArrowUp, ArrowUpDown, Link2, Loader2, Users, X } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

type TTab = 'discover' | 'my' | 'invites'
type SortDirection = 'asc' | 'desc'
type GroupSortKey = 'name' | 'description' | 'open' | 'public' | 'admin' | 'createdAt' | 'members' | 'peers'
type InviteSortKey = GroupSortKey | 'inviteDate' | 'inviteAge' | 'invitedBy'

type GroupSortState = { key: GroupSortKey; direction: SortDirection }
type InviteSortState = { key: InviteSortKey; direction: SortDirection }

type GroupRow = {
  key: string
  groupId: string
  relay?: string
  name: string
  about: string
  picture?: string
  isOpen: boolean
  isPublic: boolean
  createdAt: number | null
  fallbackAdminPubkey: string | null
} & TJoinFlowHintFields

type InviteRow = {
  key: string
  invite: TGroupInvite
  groupId: string
  relay?: string
  name: string
  about: string
  picture?: string
  isOpen: boolean
  isPublic: boolean
  inviteDate: number
  invitedBy: string
} & TJoinFlowHintFields

type TJoinFlowHintFields = {
  discoveryTopic?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  writerLeaseEnvelope?: Record<string, unknown> | null
}

function toJoinFlowHintFields(value: unknown): TJoinFlowHintFields {
  if (!value || typeof value !== 'object') return {}
  return value as TJoinFlowHintFields
}

type GroupDetailCacheEntry = {
  adminPubkey: string | null
  members: string[]
  createdAt: number | null
  updatedAt: number
}

type HorizontalDragState = {
  pointerId: number
  startX: number
  startScrollLeft: number
  moved: boolean
}

type ActiveGroupTarget = {
  key: string
  groupId: string
  relay?: string
  fallbackAdminPubkey: string | null
  fallbackCreatedAt: number | null
}

type MemberPreviewTarget = {
  key: string
  groupId: string
  relay?: string
}

type GroupRowMembership = {
  state: TGroupMembershipState | null
  members: string[]
  memberCount: number
  unknown: boolean
}

const GROUP_DETAIL_CACHE_TTL_MS = 2 * 60 * 1000
const MEMBER_PREVIEW_REFRESH_TTL_MS = 90 * 1000
const GROUP_DETAIL_FETCH_CONCURRENCY = 3
const MEMBER_PREVIEW_FETCH_CONCURRENCY = 4

const makeGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

function compareNumbers(left: number, right: number, direction: SortDirection) {
  return direction === 'asc' ? left - right : right - left
}

function compareStrings(left: string, right: string, direction: SortDirection) {
  return direction === 'asc'
    ? left.localeCompare(right)
    : right.localeCompare(left)
}

function normalizeSearch(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

function isLikelyRelayUrl(value?: string | null) {
  if (!value) return false
  return /^wss?:\/\//i.test(value) || /^https?:\/\//i.test(value)
}

function hasRelayToken(value: string) {
  try {
    return new URL(value).searchParams.has('token')
  } catch (_err) {
    return /[?&]token=/.test(value)
  }
}

function isDragScrollBlockedTarget(target: EventTarget | null) {
  return target instanceof Element
    && !!target.closest('button, a, input, textarea, select, label, [role="button"], [data-no-drag-scroll="true"]')
}

function SortHeaderButton({
  label,
  active,
  direction,
  onClick,
  className
}: {
  label: string
  active: boolean
  direction: SortDirection
  onClick: () => void
  className?: string
}) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-1 text-left ${className || ''}`}>
      <span>{label}</span>
      {!active ? (
        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      ) : direction === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5 text-foreground" />
      ) : (
        <ArrowDown className="h-3.5 w-3.5 text-foreground" />
      )}
    </button>
  )
}

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  )
}

function MembersCell({
  members,
  count,
  unknown
}: {
  members: string[]
  count?: number
  unknown?: boolean
}) {
  const compact = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: 'compact' }),
    []
  )
  const resolvedCount = typeof count === 'number' && Number.isFinite(count) ? count : members.length

  if (unknown) {
    return <span className="text-xs text-muted-foreground">-</span>
  }

  if (!resolvedCount) {
    return <span className="text-xs text-muted-foreground">0</span>
  }

  const preview = members.slice(0, 3)
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
      {preview.length ? (
        <div className="flex -space-x-2">
          {preview.map((pubkey) => (
            <div key={pubkey} className="h-5 w-5 overflow-hidden rounded-full bg-muted ring-2 ring-background">
              <SimpleUserAvatar userId={pubkey} size="small" className="h-full w-full rounded-full" />
            </div>
          ))}
        </div>
      ) : null}
      <span className="text-xs font-medium">{compact.format(resolvedCount)}</span>
    </div>
  )
}

function PeersCell({ state }: { state: TGroupPresenceState }) {
  const compact = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: 'compact' }),
    []
  )

  if (state.status === 'scanning') {
    return <span className="text-xs text-muted-foreground">Scanning…</span>
  }

  if (state.status === 'ready' && Number.isFinite(state.count)) {
    return <span className="text-xs text-muted-foreground">{compact.format(Number(state.count || 0))}</span>
  }

  return <span className="text-xs text-muted-foreground">-</span>
}

function InviteSenderLabel({ userId }: { userId: string }) {
  const { profile } = useFetchProfile(userId)
  const fallback = `${userId.slice(0, 8)}...${userId.slice(-4)}`
  const label = profile?.shortName || profile?.metadata?.name || fallback
  return <span className="truncate text-xs font-medium max-w-[220px]">{label}</span>
}

const GroupsPage = forwardRef<
  TPageRef,
  { initialTab?: TTab; tabRequestId?: string | number }
>(({ initialTab, tabRequestId }, ref) => {
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current!)
  const { t } = useTranslation()
  const {
    discoveryGroups,
    invites,
    pendingInviteCount,
    myGroupList,
    getProvisionalGroupMetadata,
    refreshDiscovery,
    refreshInvites,
    dismissInvite,
    markInviteAccepted,
    isLoadingDiscovery,
    discoveryError,
    invitesError,
    resolveRelayUrl,
    fetchGroupDetail,
    getGroupMemberPreview,
    refreshGroupMemberPreview,
    groupMemberPreviewVersion
  } = useGroups()
  const { startJoinFlow, sendToWorker } = useWorkerBridge()
  const { pubkey } = useNostr()
  const { current: currentPrimaryPage, display: primaryDisplay } = usePrimaryPage()
  const isGroupsPageActive = currentPrimaryPage === 'groups' && primaryDisplay
  const [tab, setTab] = useState<TTab>(initialTab || 'discover')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [joiningInviteId, setJoiningInviteId] = useState<string | null>(null)
  const [discoverSort, setDiscoverSort] = useState<GroupSortState>({ key: 'members', direction: 'desc' })
  const [mySort, setMySort] = useState<GroupSortState>({ key: 'createdAt', direction: 'desc' })
  const [inviteSort, setInviteSort] = useState<InviteSortState>({ key: 'inviteDate', direction: 'desc' })
  const [groupDetailCache, setGroupDetailCache] = useState<Record<string, GroupDetailCacheEntry>>({})
  const detailInFlightRef = useRef<Set<string>>(new Set())
  const detailGenerationRef = useRef(0)
  const horizontalDragStateRef = useRef<HorizontalDragState | null>(null)
  const { push } = useSecondaryPage()

  const inviteGroupIds = useMemo(() => new Set(invites.map((inv) => inv.groupId)), [invites])

  useEffect(() => {
    if (!initialTab) return
    setTab(initialTab)
  }, [initialTab, tabRequestId])

  const resolveGroupMeta = useCallback(
    (groupId: string, relay?: string) => {
      const exact = discoveryGroups.find(
        (group) => group.id === groupId && (relay ? group.relay === relay : true)
      )
      if (exact) return exact
      const provisional = getProvisionalGroupMetadata(groupId, relay)
      if (provisional) return provisional
      return discoveryGroups.find((group) => group.id === groupId) || null
    },
    [discoveryGroups, getProvisionalGroupMetadata]
  )

  const discoverRows = useMemo<GroupRow[]>(() => {
    return discoveryGroups
      .filter((group) => {
        const isMember = myGroupList.some((entry) => entry.groupId === group.id)
        const invited = inviteGroupIds.has(group.id)
        if (group.isPublic === false && !isMember && !invited) return false
        return true
      })
      .map((group) => ({
        key: makeGroupKey(group.id, group.relay),
        groupId: group.id,
        relay: group.relay,
        name: group.name || group.id,
        about: group.about || '',
        picture: group.picture,
        isOpen: group.isOpen !== false,
        isPublic: group.isPublic !== false,
        createdAt: group.event?.created_at || null,
        fallbackAdminPubkey: group.event?.pubkey || null,
        discoveryTopic: group.discoveryTopic || null,
        gatewayId: group.gatewayId || null,
        gatewayOrigin: group.gatewayOrigin || null,
        directJoinOnly: group.directJoinOnly === true,
        hostPeerKeys: group.hostPeerKeys || [],
        leaseReplicaPeerKeys: group.leaseReplicaPeerKeys || []
      }))
  }, [discoveryGroups, inviteGroupIds, myGroupList])

  const myRows = useMemo<GroupRow[]>(() => {
    return myGroupList.map((entry) => {
      const meta = resolveGroupMeta(entry.groupId, entry.relay)
      return {
        key: makeGroupKey(entry.groupId, entry.relay),
        groupId: entry.groupId,
        relay: entry.relay,
        name: meta?.name || entry.groupId,
        about: meta?.about || '',
        picture: meta?.picture,
        isOpen: meta?.isOpen !== false,
        isPublic: meta?.isPublic !== false,
        createdAt: meta?.event?.created_at || null,
        fallbackAdminPubkey: meta?.event?.pubkey || null,
        discoveryTopic: meta?.discoveryTopic || null,
        gatewayId: meta?.gatewayId || null,
        gatewayOrigin: meta?.gatewayOrigin || null,
        directJoinOnly: meta?.directJoinOnly === true,
        hostPeerKeys: meta?.hostPeerKeys || [],
        leaseReplicaPeerKeys: meta?.leaseReplicaPeerKeys || []
      }
    })
  }, [myGroupList, resolveGroupMeta])

  const myGroupKeys = useMemo(() => new Set(myRows.map((row) => row.key)), [myRows])

  const inviteRows = useMemo<InviteRow[]>(() => {
    return invites.map((invite) => {
      const relay = invite.relayUrl ?? (invite.relay ? resolveRelayUrl(invite.relay) : undefined) ?? invite.relay
      return {
        key: invite.event.id,
        invite,
        groupId: invite.groupId,
        relay,
        name: invite.groupName || invite.name || invite.groupId,
        about: invite.about || '',
        picture: invite.groupPicture,
        isOpen: invite.fileSharing !== false,
        isPublic: invite.isPublic !== false,
        inviteDate: invite.event.created_at,
        invitedBy: invite.event.pubkey,
        discoveryTopic: invite.discoveryTopic || null,
        gatewayId: invite.gatewayId || null,
        gatewayOrigin: invite.gatewayOrigin || null,
        directJoinOnly: invite.directJoinOnly === true,
        hostPeerKeys: invite.hostPeerKeys || [],
        leaseReplicaPeerKeys: invite.leaseReplicaPeerKeys || []
      }
    })
  }, [invites, resolveRelayUrl])

  const enrichmentTargets = useMemo(() => {
    const targetMap = new Map<string, ActiveGroupTarget>()
    const sourceRows: ActiveGroupTarget[] = myRows.map((row) => ({
      key: row.key,
      groupId: row.groupId,
      relay: row.relay,
      fallbackAdminPubkey: row.fallbackAdminPubkey,
      fallbackCreatedAt: row.createdAt
    }))

    for (const row of sourceRows) {
      const key = row.key
      if (targetMap.has(key)) continue
      targetMap.set(key, {
        key,
        groupId: row.groupId,
        relay: row.relay,
        fallbackAdminPubkey: row.fallbackAdminPubkey,
        fallbackCreatedAt: row.fallbackCreatedAt
      })
    }
    return Array.from(targetMap.values())
  }, [myRows])

  const memberPreviewTargets = useMemo(() => {
    const targetMap = new Map<string, MemberPreviewTarget>()
    const sourceRows: MemberPreviewTarget[] = myRows.map((row) => ({
      key: row.key,
      groupId: row.groupId,
      relay: row.relay
    }))

    if (tab === 'discover') {
      sourceRows.push(
        ...discoverRows.map((row) => ({
          key: row.key,
          groupId: row.groupId,
          relay: row.relay
        }))
      )
    }

    for (const row of sourceRows) {
      if (targetMap.has(row.key)) continue
      targetMap.set(row.key, row)
    }
    return Array.from(targetMap.values())
  }, [discoverRows, myRows, tab])

  useEffect(() => {
    if (!isGroupsPageActive || enrichmentTargets.length === 0) return
    const generation = Date.now()
    detailGenerationRef.current = generation
    let cancelled = false
    const now = Date.now()
    const queue = enrichmentTargets.filter((target) => {
      if (detailInFlightRef.current.has(target.key)) return false
      const cached = groupDetailCache[target.key]
      if (!cached) return true
      return now - cached.updatedAt > GROUP_DETAIL_CACHE_TTL_MS
    })
    if (!queue.length) return

    let cursor = 0
    const workers = Array.from({ length: Math.min(GROUP_DETAIL_FETCH_CONCURRENCY, queue.length) }, async () => {
      while (true) {
        const current = queue[cursor]
        cursor += 1
        if (!current) return
        if (cancelled) return
        if (detailInFlightRef.current.has(current.key)) continue
        detailInFlightRef.current.add(current.key)
        try {
          const preferRelay = myGroupKeys.has(current.key)
          const detail = await fetchGroupDetail(current.groupId, current.relay, preferRelay
            ? { preferRelay: true }
            : { discoveryOnly: true }
          )
          if (cancelled || detailGenerationRef.current !== generation) continue
          const nextEntry: GroupDetailCacheEntry = {
            adminPubkey:
              detail?.admins?.[0]?.pubkey ||
              detail?.metadata?.event?.pubkey ||
              current.fallbackAdminPubkey,
            members: Array.isArray(detail?.members) ? detail.members : [],
            createdAt: detail?.metadata?.event?.created_at || current.fallbackCreatedAt || null,
            updatedAt: Date.now()
          }
          setGroupDetailCache((prev) => {
            const existing = prev[current.key]
            const same =
              !!existing &&
              existing.adminPubkey === nextEntry.adminPubkey &&
              existing.createdAt === nextEntry.createdAt &&
              existing.members.length === nextEntry.members.length &&
              existing.members.every((value, index) => value === nextEntry.members[index])
            if (same) return prev
            return {
              ...prev,
              [current.key]: nextEntry
            }
          })
        } catch (error) {
          if (cancelled || detailGenerationRef.current !== generation) continue
          setGroupDetailCache((prev) => {
            if (prev[current.key]) return prev
            return {
              ...prev,
              [current.key]: {
                adminPubkey: current.fallbackAdminPubkey,
                members: [],
                createdAt: current.fallbackCreatedAt,
                updatedAt: Date.now()
              }
            }
          })
          console.warn('[GroupsPage] group detail enrichment failed', {
            groupId: current.groupId,
            relay: current.relay || null,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          detailInFlightRef.current.delete(current.key)
        }
      }
    })

    Promise.all(workers).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [enrichmentTargets, fetchGroupDetail, groupDetailCache, isGroupsPageActive, myGroupKeys])

  useEffect(() => {
    if (!isGroupsPageActive || memberPreviewTargets.length === 0) return
    let cancelled = false
    const now = Date.now()
    const queue = memberPreviewTargets.filter((target) => {
      const cached = getGroupMemberPreview(target.groupId, target.relay)
      if (!cached) return true
      return now - cached.updatedAt > MEMBER_PREVIEW_REFRESH_TTL_MS
    })
    if (!queue.length) return

    let cursor = 0
    const workers = Array.from({ length: Math.min(MEMBER_PREVIEW_FETCH_CONCURRENCY, queue.length) }, async () => {
      while (true) {
        const current = queue[cursor]
        cursor += 1
        if (!current) return
        if (cancelled) return
        try {
          await refreshGroupMemberPreview(current.groupId, current.relay, {
            force: false,
            reason: 'groups-page-row-list'
          })
        } catch (_err) {
          // best effort
        }
      }
    })

    Promise.all(workers).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [
    memberPreviewTargets,
    getGroupMemberPreview,
    groupMemberPreviewVersion,
    isGroupsPageActive,
    refreshGroupMemberPreview
  ])

  const resolveRowMembership = useCallback(
    ({
      groupId,
      relay,
      fallbackMembers = []
    }: {
      groupId: string
      relay?: string
      fallbackMembers?: string[]
    }): GroupRowMembership => {
      const preview = getGroupMemberPreview(groupId, relay)
      const normalizedFallbackMembers = Array.isArray(fallbackMembers) ? fallbackMembers : []
      const previewLooksUnknown =
        !!preview &&
        preview.memberCount === 0 &&
        preview.quality === 'partial' &&
        !preview.selectedSnapshotId &&
        preview.membershipEventsCount === 0

      if (preview && !(previewLooksUnknown && normalizedFallbackMembers.length > 0)) {
        return {
          state: preview,
          members: preview.members,
          memberCount: preview.memberCount,
          unknown: previewLooksUnknown
        }
      }

      return {
        state: null,
        members: normalizedFallbackMembers,
        memberCount: normalizedFallbackMembers.length,
        unknown: normalizedFallbackMembers.length === 0
      }
    },
    [getGroupMemberPreview]
  )

  const resolveRowAdmin = useCallback(
    ({ groupId, relay, fallbackAdminPubkey }: { groupId: string; relay?: string; fallbackAdminPubkey: string | null }) => {
      const detailEntry = groupDetailCache[makeGroupKey(groupId, relay)]
      return detailEntry?.adminPubkey || fallbackAdminPubkey
    },
    [groupDetailCache]
  )

  const resolveRowCreatedAt = useCallback(
    ({ groupId, relay, fallbackCreatedAt }: { groupId: string; relay?: string; fallbackCreatedAt: number | null }) => {
      const detailEntry = groupDetailCache[makeGroupKey(groupId, relay)]
      return detailEntry?.createdAt || fallbackCreatedAt
    },
    [groupDetailCache]
  )

  const myPresenceInputs = useMemo(
    () =>
      myRows.map((row) => ({
        groupId: row.groupId,
        relay: row.relay,
        gatewayId: row.gatewayId || null,
        gatewayOrigin: row.gatewayOrigin || null,
        directJoinOnly: row.directJoinOnly === true,
        discoveryTopic: row.discoveryTopic || null,
        hostPeerKeys: row.hostPeerKeys || [],
        leaseReplicaPeerKeys: row.leaseReplicaPeerKeys || []
      })),
    [myRows]
  )

  const discoverPresenceInputs = useMemo(
    () =>
      discoverRows.map((row) => ({
        groupId: row.groupId,
        relay: row.relay,
        gatewayId: row.gatewayId || null,
        gatewayOrigin: row.gatewayOrigin || null,
        directJoinOnly: row.directJoinOnly === true,
        discoveryTopic: row.discoveryTopic || null,
        hostPeerKeys: row.hostPeerKeys || [],
        leaseReplicaPeerKeys: row.leaseReplicaPeerKeys || []
      })),
    [discoverRows]
  )

  const invitePresenceInputs = useMemo(
    () =>
      inviteRows.map((row) => ({
        groupId: row.groupId,
        relay: row.relay,
        gatewayId: row.gatewayId || null,
        gatewayOrigin: row.gatewayOrigin || null,
        directJoinOnly: row.directJoinOnly === true,
        discoveryTopic: row.discoveryTopic || null,
        hostPeerKeys: row.hostPeerKeys || [],
        leaseReplicaPeerKeys: row.leaseReplicaPeerKeys || []
      })),
    [inviteRows]
  )

  const myPresenceMap = useGroupPresenceMap(myPresenceInputs, {
    enabled: isGroupsPageActive && tab === 'my',
    ttlMs: MY_GROUPS_PRESENCE_TTL_MS,
    priority: 1
  })
  const discoverPresenceMap = useGroupPresenceMap(discoverPresenceInputs, {
    enabled: isGroupsPageActive && tab === 'discover',
    ttlMs: DISCOVER_GROUPS_PRESENCE_TTL_MS,
    priority: 0
  })
  const invitePresenceMap = useGroupPresenceMap(invitePresenceInputs, {
    enabled: isGroupsPageActive && tab === 'invites',
    ttlMs: DISCOVER_GROUPS_PRESENCE_TTL_MS,
    priority: 0
  })

  const resolvePeerPresence = useCallback(
    ({
      groupId,
      scope
    }: {
      groupId: string
      scope: 'my' | 'discover' | 'invites'
    }) => {
      const map =
        scope === 'my'
          ? myPresenceMap
          : scope === 'discover'
            ? discoverPresenceMap
            : invitePresenceMap
      return map.get(groupId) || createGroupPresenceState({ status: 'unknown', unknown: true })
    },
    [discoverPresenceMap, invitePresenceMap, myPresenceMap]
  )

  const filteredDiscoverRows = useMemo(() => {
    const query = normalizeSearch(search)
    if (!query) return discoverRows
    return discoverRows.filter((row) => {
      const admin = resolveRowAdmin({
        groupId: row.groupId,
        relay: row.relay,
        fallbackAdminPubkey: row.fallbackAdminPubkey
      })
      const values = [row.name, row.about, row.groupId, admin]
      return values.some((value) => normalizeSearch(value).includes(query))
    })
  }, [discoverRows, resolveRowAdmin, search])

  const filteredMyRows = useMemo(() => {
    const query = normalizeSearch(search)
    if (!query) return myRows
    return myRows.filter((row) => {
      const admin = resolveRowAdmin({
        groupId: row.groupId,
        relay: row.relay,
        fallbackAdminPubkey: row.fallbackAdminPubkey
      })
      const values = [row.name, row.about, row.groupId, admin]
      return values.some((value) => normalizeSearch(value).includes(query))
    })
  }, [myRows, resolveRowAdmin, search])

  const filteredInviteRows = useMemo(() => {
    const query = normalizeSearch(search)
    if (!query) return inviteRows
    return inviteRows.filter((row) => {
      const admin = resolveRowAdmin({
        groupId: row.groupId,
        relay: row.relay,
        fallbackAdminPubkey: row.invitedBy
      })
      const values = [row.name, row.about, row.groupId, row.invitedBy, admin]
      return values.some((value) => normalizeSearch(value).includes(query))
    })
  }, [inviteRows, resolveRowAdmin, search])

  const sortedDiscoverRows = useMemo(() => {
    return [...filteredDiscoverRows].sort((left, right) => {
      const leftMembers = resolveRowMembership({ groupId: left.groupId, relay: left.relay }).memberCount
      const rightMembers = resolveRowMembership({ groupId: right.groupId, relay: right.relay }).memberCount
      const leftPeers = resolvePeerPresence({ groupId: left.groupId, scope: 'discover' })
      const rightPeers = resolvePeerPresence({ groupId: right.groupId, scope: 'discover' })
      const leftAdmin = resolveRowAdmin({
        groupId: left.groupId,
        relay: left.relay,
        fallbackAdminPubkey: left.fallbackAdminPubkey
      }) || ''
      const rightAdmin = resolveRowAdmin({
        groupId: right.groupId,
        relay: right.relay,
        fallbackAdminPubkey: right.fallbackAdminPubkey
      }) || ''
      const leftCreatedAt = resolveRowCreatedAt({
        groupId: left.groupId,
        relay: left.relay,
        fallbackCreatedAt: left.createdAt
      }) || 0
      const rightCreatedAt = resolveRowCreatedAt({
        groupId: right.groupId,
        relay: right.relay,
        fallbackCreatedAt: right.createdAt
      }) || 0

      switch (discoverSort.key) {
        case 'name':
          return compareStrings(left.name.toLowerCase(), right.name.toLowerCase(), discoverSort.direction)
        case 'description':
          return compareStrings(left.about.toLowerCase(), right.about.toLowerCase(), discoverSort.direction)
        case 'open':
          return compareNumbers(left.isOpen ? 1 : 0, right.isOpen ? 1 : 0, discoverSort.direction)
        case 'public':
          return compareNumbers(left.isPublic ? 1 : 0, right.isPublic ? 1 : 0, discoverSort.direction)
        case 'admin':
          return compareStrings(leftAdmin.toLowerCase(), rightAdmin.toLowerCase(), discoverSort.direction)
        case 'createdAt':
          return compareNumbers(leftCreatedAt, rightCreatedAt, discoverSort.direction)
        case 'peers':
          return compareGroupPresenceStates(leftPeers, rightPeers, discoverSort.direction)
        case 'members':
        default:
          return compareNumbers(leftMembers, rightMembers, discoverSort.direction)
      }
    })
  }, [discoverSort, filteredDiscoverRows, resolvePeerPresence, resolveRowAdmin, resolveRowCreatedAt, resolveRowMembership])

  const sortedMyRows = useMemo(() => {
    return [...filteredMyRows].sort((left, right) => {
      const leftMembers = resolveRowMembership({ groupId: left.groupId, relay: left.relay }).memberCount
      const rightMembers = resolveRowMembership({ groupId: right.groupId, relay: right.relay }).memberCount
      const leftPeers = resolvePeerPresence({ groupId: left.groupId, scope: 'my' })
      const rightPeers = resolvePeerPresence({ groupId: right.groupId, scope: 'my' })
      const leftAdmin = resolveRowAdmin({
        groupId: left.groupId,
        relay: left.relay,
        fallbackAdminPubkey: left.fallbackAdminPubkey
      }) || ''
      const rightAdmin = resolveRowAdmin({
        groupId: right.groupId,
        relay: right.relay,
        fallbackAdminPubkey: right.fallbackAdminPubkey
      }) || ''
      const leftCreatedAt = resolveRowCreatedAt({
        groupId: left.groupId,
        relay: left.relay,
        fallbackCreatedAt: left.createdAt
      }) || 0
      const rightCreatedAt = resolveRowCreatedAt({
        groupId: right.groupId,
        relay: right.relay,
        fallbackCreatedAt: right.createdAt
      }) || 0

      switch (mySort.key) {
        case 'name':
          return compareStrings(left.name.toLowerCase(), right.name.toLowerCase(), mySort.direction)
        case 'description':
          return compareStrings(left.about.toLowerCase(), right.about.toLowerCase(), mySort.direction)
        case 'open':
          return compareNumbers(left.isOpen ? 1 : 0, right.isOpen ? 1 : 0, mySort.direction)
        case 'public':
          return compareNumbers(left.isPublic ? 1 : 0, right.isPublic ? 1 : 0, mySort.direction)
        case 'admin':
          return compareStrings(leftAdmin.toLowerCase(), rightAdmin.toLowerCase(), mySort.direction)
        case 'members':
          return compareNumbers(leftMembers, rightMembers, mySort.direction)
        case 'peers':
          return compareGroupPresenceStates(leftPeers, rightPeers, mySort.direction)
        case 'createdAt':
        default:
          return compareNumbers(leftCreatedAt, rightCreatedAt, mySort.direction)
      }
    })
  }, [filteredMyRows, mySort, resolvePeerPresence, resolveRowAdmin, resolveRowCreatedAt, resolveRowMembership])

  const sortedInviteRows = useMemo(() => {
    return [...filteredInviteRows].sort((left, right) => {
      const leftMembers = resolveRowMembership({
        groupId: left.groupId,
        relay: left.relay,
        fallbackMembers: left.invite.authorizedMemberPubkeys || []
      }).memberCount
      const rightMembers = resolveRowMembership({
        groupId: right.groupId,
        relay: right.relay,
        fallbackMembers: right.invite.authorizedMemberPubkeys || []
      }).memberCount
      const leftPeers = resolvePeerPresence({ groupId: left.groupId, scope: 'invites' })
      const rightPeers = resolvePeerPresence({ groupId: right.groupId, scope: 'invites' })
      const leftAdmin = resolveRowAdmin({
        groupId: left.groupId,
        relay: left.relay,
        fallbackAdminPubkey: left.invitedBy
      }) || ''
      const rightAdmin = resolveRowAdmin({
        groupId: right.groupId,
        relay: right.relay,
        fallbackAdminPubkey: right.invitedBy
      }) || ''
      const now = dayjs().unix()

      switch (inviteSort.key) {
        case 'name':
          return compareStrings(left.name.toLowerCase(), right.name.toLowerCase(), inviteSort.direction)
        case 'description':
          return compareStrings(left.about.toLowerCase(), right.about.toLowerCase(), inviteSort.direction)
        case 'open':
          return compareNumbers(left.isOpen ? 1 : 0, right.isOpen ? 1 : 0, inviteSort.direction)
        case 'public':
          return compareNumbers(left.isPublic ? 1 : 0, right.isPublic ? 1 : 0, inviteSort.direction)
        case 'admin':
          return compareStrings(leftAdmin.toLowerCase(), rightAdmin.toLowerCase(), inviteSort.direction)
        case 'members':
          return compareNumbers(leftMembers, rightMembers, inviteSort.direction)
        case 'peers':
          return compareGroupPresenceStates(leftPeers, rightPeers, inviteSort.direction)
        case 'invitedBy':
          return compareStrings(left.invitedBy.toLowerCase(), right.invitedBy.toLowerCase(), inviteSort.direction)
        case 'inviteAge': {
          const leftAge = now - left.inviteDate
          const rightAge = now - right.inviteDate
          return compareNumbers(leftAge, rightAge, inviteSort.direction)
        }
        case 'inviteDate':
        default:
          return compareNumbers(left.inviteDate, right.inviteDate, inviteSort.direction)
      }
    })
  }, [filteredInviteRows, inviteSort, resolvePeerPresence, resolveRowAdmin, resolveRowMembership])

  const handleUseInvite = async (inv: TGroupInvite) => {
    if (!inv) return
    if (joiningInviteId) return
    const inviteHints = toJoinFlowHintFields(inv)
    const relayUrl = inv.relayUrl ?? (inv.relay ? resolveRelayUrl(inv.relay) : null) ?? inv.relay ?? null
    const relayKey = inv.relayKey ?? null
    const openJoin = !inv.token && inv.fileSharing !== false
    setJoiningInviteId(inv.event.id)
    try {
      if (sendToWorker && pubkey && inv.token) {
        sendToWorker({
          type: 'update-auth-data',
          data: {
            relayKey,
            publicIdentifier: inv.groupId,
            pubkey,
            token: inv.token
          }
        }).catch(() => {})
      }

      await startJoinFlow(inv.groupId, {
        fileSharing: inv.fileSharing !== false,
        openJoin,
        token: inv.token,
        relayKey,
        relayUrl,
        gatewayId: inviteHints.gatewayId || inv.gatewayId || undefined,
        gatewayOrigin: inviteHints.gatewayOrigin || inv.gatewayOrigin || undefined,
        directJoinOnly:
          inviteHints.directJoinOnly === true
          || inv.directJoinOnly === true
          || undefined,
        discoveryTopic: inviteHints.discoveryTopic || undefined,
        hostPeerKeys: inviteHints.hostPeerKeys || undefined,
        leaseReplicaPeerKeys: inviteHints.leaseReplicaPeerKeys || undefined,
        writerIssuerPubkey: inviteHints.writerIssuerPubkey || undefined,
        writerLeaseEnvelope: inviteHints.writerLeaseEnvelope || undefined,
        gatewayAccess: inv.gatewayAccess || undefined,
        blindPeer: inv.blindPeer,
        cores: inv.cores,
        writerCore: inv.writerCore,
        writerCoreHex: inv.writerCoreHex,
        autobaseLocal: inv.autobaseLocal,
        writerSecret: inv.writerSecret,
        fastForward: inv.fastForward || undefined
      })

      markInviteAccepted(inv.event.id, inv.groupId)
      push(toGroup(inv.groupId, relayUrl || inv.relay))
    } catch (err) {
      console.error('Failed to start join flow from invite', err)
      toast.error(t('Failed to start join flow'))
    } finally {
      setJoiningInviteId(null)
    }
  }

  const handleDismissInvite = (inv: TGroupInvite) => {
    if (!inv?.event?.id) return
    dismissInvite(inv.event.id)
  }

  const toggleGroupSort = (key: GroupSortKey, current: GroupSortState, setter: (next: GroupSortState) => void) => {
    if (current.key === key) {
      setter({ key, direction: current.direction === 'asc' ? 'desc' : 'asc' })
      return
    }
    const defaultDirection: SortDirection = key === 'createdAt' || key === 'members' || key === 'peers' ? 'desc' : 'asc'
    setter({ key, direction: defaultDirection })
  }

  const toggleInviteSort = (key: InviteSortKey) => {
    if (inviteSort.key === key) {
      setInviteSort({ key, direction: inviteSort.direction === 'asc' ? 'desc' : 'asc' })
      return
    }
    const defaultDirection: SortDirection = key === 'inviteDate' || key === 'inviteAge' || key === 'members' || key === 'peers'
      ? 'desc'
      : 'asc'
    setInviteSort({ key, direction: defaultDirection })
  }

  const getCopyableGroupRelayUrl = useCallback(
    ({ groupId, relay }: { groupId: string; relay?: string }) => {
      const candidates = [
        relay ? resolveRelayUrl(relay) : null,
        resolveRelayUrl(groupId),
        relay
      ]
      const normalized = candidates.filter((value): value is string => typeof value === 'string' && isLikelyRelayUrl(value))
      if (!normalized.length) return null
      return normalized.find((value) => hasRelayToken(value)) || normalized[0]
    },
    [resolveRelayUrl]
  )

  const handleCopyGroupRelayUrl = useCallback(
    async (args: { groupId: string; relay?: string }) => {
      const relayUrl = getCopyableGroupRelayUrl(args)
      if (!relayUrl) {
        toast.error(t('Relay URL unavailable'))
        return
      }
      try {
        await navigator.clipboard.writeText(relayUrl)
        toast.success(t('Relay URL copied'))
      } catch (_error) {
        toast.error(t('Failed to copy relay URL'))
      }
    },
    [getCopyableGroupRelayUrl, t]
  )

  const handleTablePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (isDragScrollBlockedTarget(event.target)) return
    if (!(event.target instanceof Element)) return
    // Restrict drag-scroll initiation to header cells so body row clicks remain reliable.
    if (!event.target.closest('thead')) return
    const element = event.currentTarget
    if (element.scrollWidth <= element.clientWidth) return
    horizontalDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
      moved: false
    }
    element.setPointerCapture(event.pointerId)
  }, [])

  const handleTablePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = horizontalDragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.startX
    if (Math.abs(deltaX) > 3) {
      drag.moved = true
    }
    event.currentTarget.scrollLeft = drag.startScrollLeft - deltaX
    if (drag.moved) {
      event.preventDefault()
    }
  }, [])

  const handleTablePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = horizontalDragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    horizontalDragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const tableScrollHandlers = {
    onPointerDown: handleTablePointerDown,
    onPointerMove: handleTablePointerMove,
    onPointerUp: handleTablePointerEnd,
    onPointerCancel: handleTablePointerEnd
  }

  const renderGroupRows = (rows: GroupRow[], mode: 'discover' | 'my') => {
    if (!rows.length) {
      return (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          {t('No groups found')}
        </div>
      )
    }

    const sortState = mode === 'discover' ? discoverSort : mySort
    const setSortState = mode === 'discover' ? setDiscoverSort : setMySort
    const showVisibilityColumn = mode !== 'discover'
    const tableMinWidth = showVisibilityColumn ? 'min-w-[960px]' : 'min-w-[860px]'

    return (
      <div
        className="overflow-x-auto scrollbar-hide rounded-lg border cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'pan-y' }}
        {...tableScrollHandlers}
      >
        <table className={`w-full ${tableMinWidth} table-fixed`}>
          <thead className="bg-muted/40 text-xs font-medium text-muted-foreground">
            <tr>
              <th className="w-14 px-3 py-2 text-left"><span className="sr-only">{t('Thumbnail')}</span></th>
              <th className="w-[220px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Group')}
                  active={sortState.key === 'name'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('name', sortState, setSortState)}
                />
              </th>
              <th className="w-[220px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Description')}
                  active={sortState.key === 'description'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('description', sortState, setSortState)}
                />
              </th>
              <th className="w-[100px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Open/Closed')}
                  active={sortState.key === 'open'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('open', sortState, setSortState)}
                />
              </th>
              {showVisibilityColumn ? (
                <th className="w-[110px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Public/Private')}
                    active={sortState.key === 'public'}
                    direction={sortState.direction}
                    onClick={() => toggleGroupSort('public', sortState, setSortState)}
                  />
                </th>
              ) : null}
              <th className="w-[220px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Admin')}
                  active={sortState.key === 'admin'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('admin', sortState, setSortState)}
                />
              </th>
              <th className="w-[150px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Members')}
                  active={sortState.key === 'members'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('members', sortState, setSortState)}
                />
              </th>
              <th className="w-[120px] px-3 py-2 text-left">
                <SortHeaderButton
                  label={t('Peers')}
                  active={sortState.key === 'peers'}
                  direction={sortState.direction}
                  onClick={() => toggleGroupSort('peers', sortState, setSortState)}
                />
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {rows.map((row) => {
              const adminPubkey = resolveRowAdmin({
                groupId: row.groupId,
                relay: row.relay,
                fallbackAdminPubkey: row.fallbackAdminPubkey
              })
              const membership = resolveRowMembership({
                groupId: row.groupId,
                relay: row.relay
              })
              const members = membership.members
              const peers = resolvePeerPresence({ groupId: row.groupId, scope: mode === 'my' ? 'my' : 'discover' })
              const initials = (row.name || 'GR').slice(0, 2).toUpperCase()
              return (
                <tr
                  key={row.key}
                  className="cursor-pointer border-t transition-colors hover:bg-accent/30"
                  onClick={() => push(toGroup(row.groupId, row.relay))}
                >
                  <td className="px-3 py-3 align-top">
                    <Avatar className="h-10 w-10 shrink-0">
                      {row.picture ? <AvatarImage src={row.picture} alt={row.name} /> : null}
                      <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                    </Avatar>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex items-start gap-2 min-w-0">
                      <div className="truncate font-semibold">{row.name}</div>
                      {mode === 'my' ? (
                        <button
                          type="button"
                          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          data-no-drag-scroll="true"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleCopyGroupRelayUrl({ groupId: row.groupId, relay: row.relay })
                          }}
                          title={t('Copy relay URL') as string}
                          aria-label={t('Copy relay URL') as string}
                        >
                          <Link2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top text-muted-foreground">
                    <div className="line-clamp-3 max-w-[220px] whitespace-pre-wrap break-words">{row.about || '-'}</div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <StatusBadge label={row.isOpen ? t('Open') : t('Closed')} />
                  </td>
                  {showVisibilityColumn ? (
                    <td className="px-3 py-3 align-top">
                      <StatusBadge label={row.isPublic ? t('Public') : t('Private')} />
                    </td>
                  ) : null}
                  <td className="px-3 py-3 align-top">
                    {adminPubkey ? (
                      <div className="flex items-center gap-2 min-w-0">
                        <SimpleUserAvatar userId={adminPubkey} size="small" className="h-6 w-6 rounded-full" />
                        <Username userId={adminPubkey} className="truncate text-sm" />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <MembersCell members={members} count={membership.memberCount} unknown={membership.unknown} />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <PeersCell state={peers} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const renderInvites = () => {
    if (!sortedInviteRows.length) {
      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">{t('No invites')}</div>
            <Button variant="ghost" size="sm" onClick={() => refreshInvites()}>
              <Loader2 className="w-4 h-4 mr-2" />
              {t('Refresh')}
            </Button>
          </div>
          {invitesError ? <div className="text-sm text-red-500">{invitesError}</div> : null}
        </div>
      )
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">{t('Invites')}</div>
          <Button variant="ghost" size="sm" onClick={() => refreshInvites()}>
            <Loader2 className="w-4 h-4 mr-2" />
            {t('Refresh')}
          </Button>
        </div>
        {invitesError ? <div className="text-sm text-red-500">{invitesError}</div> : null}

        <div
          className="overflow-x-auto scrollbar-hide rounded-lg border cursor-grab active:cursor-grabbing"
          style={{ touchAction: 'pan-y' }}
          {...tableScrollHandlers}
        >
          <table className="w-full min-w-[1220px] table-fixed">
            <thead className="bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                <th className="w-[220px] px-3 py-2 text-left">{t('Actions')}</th>
                <th className="w-14 px-3 py-2 text-left"><span className="sr-only">{t('Thumbnail')}</span></th>
                <th className="w-[200px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Group')}
                    active={inviteSort.key === 'name'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('name')}
                  />
                </th>
                <th className="w-[210px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Description')}
                    active={inviteSort.key === 'description'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('description')}
                  />
                </th>
                <th className="w-[100px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Open/Closed')}
                    active={inviteSort.key === 'open'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('open')}
                  />
                </th>
                <th className="w-[110px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Public/Private')}
                    active={inviteSort.key === 'public'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('public')}
                  />
                </th>
                <th className="w-[200px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Admin')}
                    active={inviteSort.key === 'admin'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('admin')}
                  />
                </th>
                <th className="w-[150px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Members')}
                    active={inviteSort.key === 'members'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('members')}
                  />
                </th>
                <th className="w-[110px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Peers')}
                    active={inviteSort.key === 'peers'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('peers')}
                  />
                </th>
                <th className="w-[140px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Invite age')}
                    active={inviteSort.key === 'inviteAge'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('inviteAge')}
                  />
                </th>
                <th className="w-[220px] px-3 py-2 text-left">
                  <SortHeaderButton
                    label={t('Invited by')}
                    active={inviteSort.key === 'invitedBy'}
                    direction={inviteSort.direction}
                    onClick={() => toggleInviteSort('invitedBy')}
                  />
                </th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {sortedInviteRows.map((row) => {
                const adminPubkey = resolveRowAdmin({
                  groupId: row.groupId,
                  relay: row.relay,
                  fallbackAdminPubkey: row.invitedBy
                })
                const membership = resolveRowMembership({
                  groupId: row.groupId,
                  relay: row.relay,
                  fallbackMembers: row.invite.authorizedMemberPubkeys || []
                })
                const members = membership.members
                const peers = resolvePeerPresence({ groupId: row.groupId, scope: 'invites' })
                const initials = (row.name || 'GR').slice(0, 2).toUpperCase()
                return (
                  <tr key={row.key} className="border-t transition-colors hover:bg-accent/30">
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleDismissInvite(row.invite)}>
                          <X className="w-4 h-4 mr-1" />
                          {t('Dismiss')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={joiningInviteId === row.invite.event.id}
                          onClick={() => handleUseInvite(row.invite)}
                        >
                          {joiningInviteId === row.invite.event.id ? t('Joining…') : t('Use invite')}
                        </Button>
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <Avatar className="h-10 w-10 shrink-0">
                        {row.picture ? <AvatarImage src={row.picture} alt={row.name} /> : null}
                        <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                      </Avatar>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-start gap-2 min-w-0">
                        <div className="truncate font-semibold">{row.name}</div>
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-muted-foreground">
                      <div className="line-clamp-3 max-w-[210px] whitespace-pre-wrap break-words">{row.about || '-'}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusBadge label={row.isOpen ? t('Open') : t('Closed')} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusBadge label={row.isPublic ? t('Public') : t('Private')} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      {adminPubkey ? (
                        <div className="flex items-center gap-2 min-w-0">
                          <SimpleUserAvatar userId={adminPubkey} size="small" className="h-6 w-6 rounded-full" />
                          <Username userId={adminPubkey} className="truncate text-sm" />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <MembersCell
                        members={members}
                        count={membership.memberCount}
                        unknown={membership.unknown}
                      />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <PeersCell state={peers} />
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                      <FormattedTimestamp timestamp={row.inviteDate} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center gap-2 min-w-0">
                        <SimpleUserAvatar userId={row.invitedBy} size="small" className="h-6 w-6 rounded-full" />
                        <InviteSenderLabel userId={row.invitedBy} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const invitesTabLabel =
    pendingInviteCount > 0 ? `${t('Invites')} (${pendingInviteCount})` : t('Invites')

  return (
    <PrimaryPageLayout
      pageName="groups"
      ref={layoutRef}
      titlebar={<GroupsPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('Search groups...') as string}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="flex-1"
          />
          <Button variant="ghost" size="icon" onClick={() => refreshDiscovery()}>
            <Loader2 className="w-4 h-4" />
          </Button>
          <Button onClick={() => setShowCreate(true)}>{t('Create')}</Button>
        </div>

        <Tabs value={tab} onValueChange={(value) => setTab(value as TTab)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="discover">{t('Discover')}</TabsTrigger>
            <TabsTrigger value="my">{t('My Groups')}</TabsTrigger>
            <TabsTrigger value="invites">{invitesTabLabel}</TabsTrigger>
          </TabsList>

          <TabsContent value="discover" className="mt-4">
            {isLoadingDiscovery ? (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <div>{t('Loading...')}</div>
              </div>
            ) : discoveryError ? (
              <div className="text-sm text-red-500">
                {t('Failed to load groups')}: {discoveryError}
              </div>
            ) : renderGroupRows(sortedDiscoverRows, 'discover')}
          </TabsContent>

          <TabsContent value="my" className="mt-4">
            {myGroupList.length === 0 ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">{t('No groups yet')}</div>
            ) : renderGroupRows(sortedMyRows, 'my')}
          </TabsContent>

          <TabsContent value="invites" className="mt-4">
            {renderInvites()}
          </TabsContent>
        </Tabs>
      </div>
      <GroupCreateDialog open={showCreate} onOpenChange={setShowCreate} />
    </PrimaryPageLayout>
  )
})

GroupsPage.displayName = 'GroupsPage'

export default GroupsPage

function GroupsPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-between h-full pl-3 pr-2">
      <div className="flex gap-2 items-center [&_svg]:text-muted-foreground">
        <Users />
        <div className="text-lg font-semibold" style={{ fontSize: 'var(--title-font-size, 18px)' }}>
          {t('Groups')}
        </div>
      </div>
      <TitlebarInfoButton
        label="Groups info"
        content="P2P nostr communities built on Hyperpipe relays."
      />
    </div>
  )
}
