import { deriveMembershipStatus, parseGroupMembersEvent, resolveGroupMembersFromSnapshotAndOps } from '@/lib/groups'
import { getBaseRelayUrl } from '@/lib/hypertuna-group-events'
import type {
  TGroupMembershipFetchSource,
  TGroupMembershipHydrationSource,
  TGroupMembershipQuality,
  TGroupMembershipSnapshotSource,
  TGroupMembershipState,
  TGroupMembershipStatus,
  TPersistedGroupMembershipRecord,
  TPersistedGroupMembershipSnapshot
} from '@/types/groups'
import type { Filter } from '@nostr/tools/filter'
import type { Event } from '@nostr/tools/wasm'

export type GroupMembershipLiveSourceKey = 'resolved-relay' | 'discovery'

export type GroupMembershipLiveSourceConfig = {
  key: GroupMembershipLiveSourceKey
  relayUrls: string[]
  snapshotAuthorityEligible: boolean
  allowSnapshots?: boolean
  allowOps?: boolean
}

export type ResolveCanonicalGroupMembershipStateArgs = {
  groupId: string
  sources: GroupMembershipLiveSourceConfig[]
  fetchEvents: (relayUrls: string[], filter: Filter) => Promise<Event[]>
  fetchJoinRequests?: () => Promise<Event[]>
  currentPubkey?: string | null
  expectCurrentPubkeyMember?: boolean
  relayReadyForReq?: boolean
  relayWritable?: boolean
  extraMembershipEvents?: Event[]
  extraMembershipEventsSource?: GroupMembershipLiveSourceKey
  opsPageSize?: number
  opsMaxPerSource?: number
}

export type ResolvedCanonicalGroupMembershipState = {
  state: TGroupMembershipState
  selectedSnapshotEvent: Event | null
  membershipEvents: Event[]
  joinRequestEvents: Event[]
}

const MEMBERSHIP_FETCH_TIMEOUT_LIKE_MS = 9000
const DEFAULT_OPS_PAGE_SIZE = 200
const DEFAULT_OPS_MAX_PER_SOURCE = 2000

const QUALITY_RANK: Record<TGroupMembershipQuality, number> = {
  partial: 1,
  warming: 2,
  complete: 3
}

const sourceToSnapshotSource = (
  value: GroupMembershipLiveSourceKey | TGroupMembershipSnapshotSource | null | undefined
): TGroupMembershipSnapshotSource => {
  if (value === 'resolved-relay' || value === 'discovery') return value
  if (value === 'op-only') return value
  if (value === 'persisted-last-complete') return value
  if (value === 'persisted-last-known') return value
  if (value === 'optimistic') return value
  return 'unknown'
}

const toLegacyFetchSource = (
  hydrationSource: TGroupMembershipHydrationSource,
  hasData: boolean
): TGroupMembershipFetchSource => {
  if (hydrationSource === 'persisted-last-complete') return 'persisted-last-complete'
  if (hydrationSource === 'persisted-last-known') return 'persisted-last-known'
  if (hydrationSource === 'optimistic') return 'optimistic'
  if (hydrationSource === 'live-discovery' || hydrationSource === 'live-op-reconstruction') {
    return 'fallback-discovery'
  }
  if (hydrationSource === 'live-resolved-relay') {
    return hasData ? 'group-relay' : 'group-relay-empty'
  }
  return hasData ? 'fallback-discovery' : 'group-relay-empty'
}

const dedupeEventsById = (events: Event[]) => {
  const seenIds = new Set<string>()
  const merged: Event[] = []
  for (const event of events) {
    const eventId = String(event?.id || '').trim()
    if (eventId && seenIds.has(eventId)) continue
    if (eventId) seenIds.add(eventId)
    merged.push(event)
  }
  return merged
}

export const normalizeMembershipPubkeys = (values?: Array<string | null | undefined>) =>
  Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ).sort()

export const areMembershipPubkeySetsEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export const toGroupMembershipCacheKey = (groupId: string, relay?: string | null) =>
  `${relay ? getBaseRelayUrl(relay) : ''}|${String(groupId || '').trim()}`

export const toPersistedGroupMembershipRecordKey = (
  accountPubkey: string,
  groupId: string,
  relayBase?: string | null
) =>
  `${String(accountPubkey || '').trim()}|${String(relayBase || '').trim()}|${String(groupId || '').trim()}`

export const createGroupMembershipState = (
  args: Partial<TGroupMembershipState> & {
    members?: Array<string | null | undefined>
    membershipStatus?: TGroupMembershipStatus
    quality?: TGroupMembershipQuality
    hydrationSource?: TGroupMembershipHydrationSource
  } = {}
): TGroupMembershipState => {
  const members = normalizeMembershipPubkeys(args.members)
  const quality = args.quality || 'partial'
  const hydrationSource = args.hydrationSource || 'unknown'
  const selectedSnapshotSource = args.selectedSnapshotSource
    ? sourceToSnapshotSource(args.selectedSnapshotSource)
    : null
  const sourcesUsed = Array.from(
    new Set(
      (Array.isArray(args.sourcesUsed) ? args.sourcesUsed : [])
        .map((source) => sourceToSnapshotSource(source))
        .filter(Boolean)
    )
  )
  const authoritative =
    typeof args.authoritative === 'boolean' ? args.authoritative : quality === 'complete'
  const hasData = members.length > 0 || Number(args.membershipEventsCount || 0) > 0
  const source = sourceToSnapshotSource(args.source || selectedSnapshotSource || 'unknown')

  return {
    members,
    memberCount: members.length,
    membershipStatus: args.membershipStatus || 'not-member',
    quality,
    hydrationSource,
    updatedAt:
      typeof args.updatedAt === 'number' && Number.isFinite(args.updatedAt)
        ? args.updatedAt
        : Date.now(),
    selectedSnapshotId: args.selectedSnapshotId || null,
    selectedSnapshotCreatedAt:
      typeof args.selectedSnapshotCreatedAt === 'number' &&
      Number.isFinite(args.selectedSnapshotCreatedAt)
        ? args.selectedSnapshotCreatedAt
        : null,
    selectedSnapshotSource,
    sourcesUsed,
    relayReadyForReq: args.relayReadyForReq === true,
    relayWritable: args.relayWritable === true,
    opsOverflowed: args.opsOverflowed === true,
    authoritative,
    source,
    membershipAuthoritative:
      typeof args.membershipAuthoritative === 'boolean'
        ? args.membershipAuthoritative
        : authoritative,
    membershipEventsCount: Math.max(0, Number(args.membershipEventsCount || 0)),
    membersFromEventCount: Math.max(0, Number(args.membersFromEventCount || 0)),
    membersSnapshotCreatedAt:
      typeof args.membersSnapshotCreatedAt === 'number' &&
      Number.isFinite(args.membersSnapshotCreatedAt)
        ? args.membersSnapshotCreatedAt
        : null,
    membershipFetchTimedOutLike: args.membershipFetchTimedOutLike === true,
    membershipFetchSource: args.membershipFetchSource || toLegacyFetchSource(hydrationSource, hasData)
  }
}

export const toPersistedGroupMembershipSnapshot = (
  state: TGroupMembershipState
): TPersistedGroupMembershipSnapshot => ({
  ...createGroupMembershipState(state)
})

export const hydratePersistedGroupMembershipState = (
  snapshot: TPersistedGroupMembershipSnapshot | null | undefined,
  hydrationSource: 'persisted-last-complete' | 'persisted-last-known'
): TGroupMembershipState | null => {
  if (!snapshot) return null
  return createGroupMembershipState({
    ...snapshot,
    hydrationSource,
    membershipFetchSource:
      hydrationSource === 'persisted-last-complete'
        ? 'persisted-last-complete'
        : 'persisted-last-known',
    selectedSnapshotSource:
      snapshot.selectedSnapshotSource ||
      (hydrationSource === 'persisted-last-complete'
        ? 'persisted-last-complete'
        : 'persisted-last-known'),
    source:
      snapshot.source ||
      (hydrationSource === 'persisted-last-complete'
        ? 'persisted-last-complete'
        : 'persisted-last-known')
  })
}

export const updatePersistedGroupMembershipRecord = (
  currentRecord: TPersistedGroupMembershipRecord | null | undefined,
  args: {
    accountPubkey: string
    groupId: string
    relayBase?: string | null
    lastKnown?: TGroupMembershipState | null
    lastComplete?: TGroupMembershipState | null
  }
): TPersistedGroupMembershipRecord => {
  const key = toPersistedGroupMembershipRecordKey(args.accountPubkey, args.groupId, args.relayBase)
  const nextLastKnown =
    args.lastKnown === undefined
      ? currentRecord?.lastKnown || null
      : args.lastKnown
        ? toPersistedGroupMembershipSnapshot(args.lastKnown)
        : null
  const nextLastComplete =
    args.lastComplete === undefined
      ? currentRecord?.lastComplete || null
      : args.lastComplete
        ? toPersistedGroupMembershipSnapshot(args.lastComplete)
        : null

  return {
    key,
    accountPubkey: String(args.accountPubkey || '').trim(),
    groupId: String(args.groupId || '').trim(),
    relayBase: String(args.relayBase || '').trim(),
    lastKnown: nextLastKnown,
    lastComplete: nextLastComplete,
    persistedAt: Date.now()
  }
}

export const choosePreferredMembershipState = (
  currentState: TGroupMembershipState | null | undefined,
  incomingState: TGroupMembershipState | null | undefined
) => {
  if (!incomingState) return currentState || null
  if (!currentState) return incomingState

  const qualityDiff = QUALITY_RANK[incomingState.quality] - QUALITY_RANK[currentState.quality]
  if (qualityDiff !== 0) {
    return qualityDiff > 0 ? incomingState : currentState
  }

  const currentMembers = normalizeMembershipPubkeys(currentState.members)
  const incomingMembers = normalizeMembershipPubkeys(incomingState.members)
  const currentSnapshotTs = currentState.selectedSnapshotCreatedAt || 0
  const incomingSnapshotTs = incomingState.selectedSnapshotCreatedAt || 0

  if (areMembershipPubkeySetsEqual(currentMembers, incomingMembers)) {
    if (
      currentSnapshotTs === incomingSnapshotTs &&
      currentState.membershipEventsCount === incomingState.membershipEventsCount &&
      currentState.opsOverflowed === incomingState.opsOverflowed &&
      currentState.hydrationSource === incomingState.hydrationSource
    ) {
      return currentState
    }
  }

  if (incomingSnapshotTs !== currentSnapshotTs) {
    return incomingSnapshotTs > currentSnapshotTs ? incomingState : currentState
  }

  if (currentState.opsOverflowed !== incomingState.opsOverflowed) {
    return incomingState.opsOverflowed ? currentState : incomingState
  }

  if (incomingState.membershipEventsCount !== currentState.membershipEventsCount) {
    return incomingState.membershipEventsCount > currentState.membershipEventsCount
      ? incomingState
      : currentState
  }

  if (incomingState.memberCount < currentState.memberCount) {
    return currentState
  }

  return incomingState.updatedAt >= currentState.updatedAt ? incomingState : currentState
}

const fetchLatestSnapshotForSource = async (
  fetchEvents: ResolveCanonicalGroupMembershipStateArgs['fetchEvents'],
  groupId: string,
  source: GroupMembershipLiveSourceConfig
) => {
  if (!source.allowSnapshots || !source.relayUrls.length) return null

  const [dTagged, hTagged] = await Promise.all([
    fetchEvents(source.relayUrls, { kinds: [39002], '#d': [groupId], limit: 10 }),
    fetchEvents(source.relayUrls, { kinds: [39002], '#h': [groupId], limit: 10 })
  ])

  const latest =
    dedupeEventsById([...dTagged, ...hTagged]).sort((left, right) => {
      const createdAtDiff = (right.created_at || 0) - (left.created_at || 0)
      if (createdAtDiff !== 0) return createdAtDiff
      return String(right.id || '').localeCompare(String(left.id || ''))
    })[0] || null

  return latest
}

const fetchMembershipOpsForSource = async (
  fetchEvents: ResolveCanonicalGroupMembershipStateArgs['fetchEvents'],
  groupId: string,
  source: GroupMembershipLiveSourceConfig,
  snapshotCreatedAt: number | null,
  pageSize: number,
  maxPerSource: number
) => {
  if (!source.allowOps || !source.relayUrls.length) {
    return { events: [] as Event[], overflowed: false }
  }

  const deduped = new Map<string, Event>()
  let overflowed = false
  let until: number | undefined

  while (deduped.size < maxPerSource) {
    const filter: Filter = {
      kinds: [9000, 9001, 9022],
      '#h': [groupId],
      limit: pageSize
    }
    if (typeof snapshotCreatedAt === 'number' && Number.isFinite(snapshotCreatedAt)) {
      filter.since = snapshotCreatedAt + 1
    }
    if (typeof until === 'number' && Number.isFinite(until)) {
      filter.until = until
    }

    const batch = await fetchEvents(source.relayUrls, filter)
    if (!batch.length) break

    const orderedBatch = dedupeEventsById(batch).sort((left, right) => {
      const createdAtDiff = (right.created_at || 0) - (left.created_at || 0)
      if (createdAtDiff !== 0) return createdAtDiff
      return String(right.id || '').localeCompare(String(left.id || ''))
    })

    for (const event of orderedBatch) {
      const eventId = String(event.id || '').trim()
      if (eventId && !deduped.has(eventId)) {
        deduped.set(eventId, event)
      }
      if (!eventId) {
        deduped.set(`${event.kind}:${event.created_at}:${deduped.size}`, event)
      }
      if (deduped.size >= maxPerSource) {
        overflowed = true
        break
      }
    }

    if (overflowed || orderedBatch.length < pageSize) {
      break
    }

    const oldestCreatedAt = orderedBatch.reduce((lowest, event) => {
      const createdAt = Number.isFinite(event.created_at) ? event.created_at : lowest
      return Math.min(lowest, createdAt)
    }, Number.MAX_SAFE_INTEGER)

    if (!Number.isFinite(oldestCreatedAt) || oldestCreatedAt <= 0) {
      break
    }
    until = oldestCreatedAt - 1
  }

  return {
    events: Array.from(deduped.values()).sort((left, right) => {
      const createdAtDiff = (right.created_at || 0) - (left.created_at || 0)
      if (createdAtDiff !== 0) return createdAtDiff
      return String(right.id || '').localeCompare(String(left.id || ''))
    }),
    overflowed
  }
}

export const resolveCanonicalGroupMembershipState = async ({
  groupId,
  sources,
  fetchEvents,
  fetchJoinRequests,
  currentPubkey,
  expectCurrentPubkeyMember,
  relayReadyForReq,
  relayWritable,
  extraMembershipEvents = [],
  extraMembershipEventsSource,
  opsPageSize = DEFAULT_OPS_PAGE_SIZE,
  opsMaxPerSource = DEFAULT_OPS_MAX_PER_SOURCE
}: ResolveCanonicalGroupMembershipStateArgs): Promise<ResolvedCanonicalGroupMembershipState> => {
  const startedAt = Date.now()
  const normalizedSources = sources
    .map((source) => ({
      ...source,
      relayUrls: Array.from(
        new Set(
          (Array.isArray(source.relayUrls) ? source.relayUrls : [])
            .map((relayUrl) => String(relayUrl || '').trim())
            .filter(Boolean)
        )
      )
    }))
    .filter((source) => source.relayUrls.length > 0)

  const snapshotResults = await Promise.all(
    normalizedSources.map(async (source) => {
      const event = await fetchLatestSnapshotForSource(fetchEvents, groupId, source).catch(() => null)
      return { source, event }
    })
  )

  const sortedSnapshotCandidates = snapshotResults
    .filter((result): result is { source: GroupMembershipLiveSourceConfig; event: Event } => !!result.event)
    .sort((left, right) => {
      const createdAtDiff = (right.event.created_at || 0) - (left.event.created_at || 0)
      if (createdAtDiff !== 0) return createdAtDiff
      if (left.source.snapshotAuthorityEligible !== right.source.snapshotAuthorityEligible) {
        return left.source.snapshotAuthorityEligible ? -1 : 1
      }
      if (left.source.key !== right.source.key) {
        return left.source.key === 'resolved-relay' ? -1 : 1
      }
      return String(right.event.id || '').localeCompare(String(left.event.id || ''))
    })

  const authoritativeSnapshotCandidate =
    sortedSnapshotCandidates.find((candidate) => candidate.source.snapshotAuthorityEligible) || null
  const selectedSnapshotCandidate = authoritativeSnapshotCandidate || sortedSnapshotCandidates[0] || null
  const selectedSnapshotEvent = selectedSnapshotCandidate?.event || null

  const opsResults = await Promise.all(
    normalizedSources.map(async (source) => {
      const result = await fetchMembershipOpsForSource(
        fetchEvents,
        groupId,
        source,
        selectedSnapshotEvent?.created_at ?? null,
        opsPageSize,
        opsMaxPerSource
      ).catch(() => ({ events: [] as Event[], overflowed: false }))
      return { source, ...result }
    })
  )

  const effectiveMembershipEvents = dedupeEventsById([
    ...opsResults.flatMap((result) => result.events),
    ...extraMembershipEvents
  ]).sort((left, right) => {
    const createdAtDiff = (right.created_at || 0) - (left.created_at || 0)
    if (createdAtDiff !== 0) return createdAtDiff
    return String(right.id || '').localeCompare(String(left.id || ''))
  })

  const joinRequestEvents = fetchJoinRequests ? await fetchJoinRequests().catch(() => []) : []
  const membersFromEvent = selectedSnapshotEvent ? parseGroupMembersEvent(selectedSnapshotEvent) : []
  const resolvedMembers = normalizeMembershipPubkeys(
    resolveGroupMembersFromSnapshotAndOps({
      snapshotMembers: membersFromEvent,
      snapshotCreatedAt: selectedSnapshotEvent?.created_at,
      membershipEvents: effectiveMembershipEvents
    })
  )

  const overflowed = opsResults.some((result) => result.overflowed)
  const selectedSnapshotSource = selectedSnapshotCandidate
    ? sourceToSnapshotSource(selectedSnapshotCandidate.source.key)
    : null

  const hasData =
    !!selectedSnapshotEvent || membersFromEvent.length > 0 || effectiveMembershipEvents.length > 0
  let hydrationSource: TGroupMembershipHydrationSource = 'unknown'
  if (selectedSnapshotSource === 'resolved-relay') hydrationSource = 'live-resolved-relay'
  else if (selectedSnapshotSource === 'discovery') hydrationSource = 'live-discovery'
  else if (effectiveMembershipEvents.length > 0) hydrationSource = 'live-op-reconstruction'

  let quality: TGroupMembershipQuality = 'partial'
  if (selectedSnapshotCandidate?.source.snapshotAuthorityEligible && !overflowed) {
    quality = 'complete'
  } else if (selectedSnapshotEvent) {
    quality = 'warming'
  } else if (overflowed) {
    quality = 'partial'
  }

  let membershipStatus = currentPubkey
    ? deriveMembershipStatus(currentPubkey, effectiveMembershipEvents, joinRequestEvents)
    : 'not-member'

  const members = [...resolvedMembers]
  if (currentPubkey && expectCurrentPubkeyMember && !members.includes(currentPubkey)) {
    members.push(currentPubkey)
    membershipStatus = membershipStatus === 'removed' ? membershipStatus : 'member'
  }

  const sourcesUsed = Array.from(
    new Set(
      [
        selectedSnapshotSource,
        ...opsResults
          .filter((result) => result.events.length > 0)
          .map((result) => sourceToSnapshotSource(result.source.key)),
        extraMembershipEvents.length > 0 && extraMembershipEventsSource
          ? sourceToSnapshotSource(extraMembershipEventsSource)
          : null
      ].filter(Boolean)
    )
  ) as TGroupMembershipSnapshotSource[]

  const state = createGroupMembershipState({
    members,
    membershipStatus,
    quality,
    hydrationSource,
    selectedSnapshotId: selectedSnapshotEvent?.id || null,
    selectedSnapshotCreatedAt: selectedSnapshotEvent?.created_at ?? null,
    selectedSnapshotSource,
    sourcesUsed,
    relayReadyForReq: relayReadyForReq === true,
    relayWritable: relayWritable === true,
    opsOverflowed: overflowed,
    authoritative: quality === 'complete',
    source: selectedSnapshotSource || (effectiveMembershipEvents.length > 0 ? 'op-only' : 'unknown'),
    membershipAuthoritative: quality === 'complete',
    membershipEventsCount: effectiveMembershipEvents.length,
    membersFromEventCount: membersFromEvent.length,
    membersSnapshotCreatedAt: selectedSnapshotEvent?.created_at ?? null,
    membershipFetchTimedOutLike: Date.now() - startedAt >= MEMBERSHIP_FETCH_TIMEOUT_LIKE_MS,
    membershipFetchSource: toLegacyFetchSource(hydrationSource, hasData)
  })

  return {
    state,
    selectedSnapshotEvent,
    membershipEvents: effectiveMembershipEvents,
    joinRequestEvents
  }
}
