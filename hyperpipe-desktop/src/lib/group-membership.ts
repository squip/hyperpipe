import { deriveMembershipStatus, parseGroupMembersEvent, resolveGroupMembersFromSnapshotAndOps } from '@/lib/groups'
import { getBaseRelayUrl } from '@/lib/hyperpipe-group-events'
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

export type BuildGroupMembershipSourcePlanArgs = {
  discoveryOnly?: boolean
  knownPrivateGroup?: boolean
  canUseResolvedRelay?: boolean
  resolvedRelay?: string | null
  discoveryRelays?: string[]
  relayReadyForReq?: boolean
}

export type ResolveCanonicalGroupMembershipStateArgs = {
  groupId: string
  sources: GroupMembershipLiveSourceConfig[]
  fetchEvents: (relayUrls: string[], filter: Filter) => Promise<Event[]>
  fetchJoinRequests?: () => Promise<Event[]>
  currentPubkey?: string | null
  isCreator?: boolean
  protectedState?: TGroupMembershipState | null
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
  selectionDebug: {
    usedProtectedState: boolean
    skippedSuspiciousCandidateIds: string[]
    protectedStateSnapshotId: string | null
    candidates: Array<{
      id: string | null
      createdAt: number | null
      source: TGroupMembershipSnapshotSource
      authorPubkey: string | null
      memberCount: number
      authorityEligible: boolean
      suspiciousCreatorSelfOnly: boolean
      selected: boolean
      skippedReason: string | null
    }>
  }
}

const MEMBERSHIP_FETCH_TIMEOUT_LIKE_MS = 9000
const DEFAULT_OPS_PAGE_SIZE = 200
const DEFAULT_OPS_MAX_PER_SOURCE = 2000
const DEFAULT_SNAPSHOT_PAGE_SIZE = 10
export const DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE = '__discovery__'

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

export const getPersistedGroupMembershipRelayBase = (args: {
  relayBase?: string | null
  discoveryOnly?: boolean
}) =>
  args.discoveryOnly ? DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE : String(args.relayBase || '').trim()

export const isDiscoveryPersistedGroupMembershipRelayBase = (relayBase?: string | null) =>
  String(relayBase || '').trim() === DISCOVERY_GROUP_MEMBERSHIP_RELAY_BASE

export const buildGroupMembershipSourcePlan = (
  args: BuildGroupMembershipSourcePlanArgs
): GroupMembershipLiveSourceConfig[] => {
  const discoveryOnly = args.discoveryOnly === true
  const knownPrivateGroup = args.knownPrivateGroup === true
  const canUseResolvedRelay = args.canUseResolvedRelay === true
  const resolvedRelay = String(args.resolvedRelay || '').trim()
  const discoveryRelays = Array.from(
    new Set(
      (Array.isArray(args.discoveryRelays) ? args.discoveryRelays : [])
        .map((relayUrl) => String(relayUrl || '').trim())
        .filter(Boolean)
    )
  )

  const sources: GroupMembershipLiveSourceConfig[] = []
  if (discoveryOnly) {
    if (!knownPrivateGroup && discoveryRelays.length > 0) {
      sources.push({
        key: 'discovery',
        relayUrls: discoveryRelays,
        snapshotAuthorityEligible: true,
        allowSnapshots: true,
        allowOps: true
      })
    }
    return sources
  }

  if (knownPrivateGroup) {
    if (canUseResolvedRelay && resolvedRelay) {
      sources.push({
        key: 'resolved-relay',
        relayUrls: [resolvedRelay],
        snapshotAuthorityEligible: args.relayReadyForReq === true,
        allowSnapshots: true,
        allowOps: true
      })
    }
    return sources
  }

  if (canUseResolvedRelay && resolvedRelay) {
    sources.push({
      key: 'resolved-relay',
      relayUrls: [resolvedRelay],
      snapshotAuthorityEligible: args.relayReadyForReq === true,
      allowSnapshots: true,
      allowOps: true
    })
  }
  if (discoveryRelays.length > 0) {
    sources.push({
      key: 'discovery',
      relayUrls: discoveryRelays,
      snapshotAuthorityEligible: true,
      allowSnapshots: true,
      allowOps: true
    })
  }
  return sources
}

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

export const selectPreferredMembershipState = (
  candidates: Array<TGroupMembershipState | null | undefined>
) => {
  const orderedCandidates = candidates
    .filter((candidate): candidate is TGroupMembershipState => !!candidate)
    .sort((left, right) => {
      const updatedAtDiff = (left.updatedAt || 0) - (right.updatedAt || 0)
      if (updatedAtDiff !== 0) return updatedAtDiff
      const snapshotDiff =
        (left.selectedSnapshotCreatedAt || 0) - (right.selectedSnapshotCreatedAt || 0)
      if (snapshotDiff !== 0) return snapshotDiff
      return left.memberCount - right.memberCount
    })

  return orderedCandidates.reduce<TGroupMembershipState | null>(
    (best, candidate) => choosePreferredMembershipState(best, candidate),
    null
  )
}

export const isSuspiciousCreatorSelfMembershipDowngrade = (args: {
  currentState?: TGroupMembershipState | null
  incomingState?: TGroupMembershipState | null
  currentPubkey?: string | null
  isCreator?: boolean
}) => {
  const currentState = args.currentState || null
  const incomingState = args.incomingState || null
  const currentPubkey = String(args.currentPubkey || '').trim()
  if (!args.isCreator || !currentState || !incomingState || !currentPubkey) return false
  if (currentState.memberCount <= 1) return false
  if (incomingState.memberCount !== 1) return false
  if (!currentState.members.includes(currentPubkey)) return false
  if (incomingState.members[0] !== currentPubkey) return false
  const incomingFromResolvedRelay =
    incomingState.selectedSnapshotSource === 'resolved-relay' ||
    incomingState.membershipFetchSource === 'group-relay'
  if (!incomingFromResolvedRelay) return false
  if (incomingState.membershipEventsCount > 0) return false
  if (
    incomingState.membersFromEventCount > 0 &&
    incomingState.membersFromEventCount !== incomingState.memberCount
  ) {
    return false
  }
  return currentState.memberCount > incomingState.memberCount
}

type SnapshotCandidate = {
  source: GroupMembershipLiveSourceConfig
  event: Event
  members: string[]
}

const isSuspiciousCreatorSelfOnlySnapshotCandidate = (args: {
  candidate?: SnapshotCandidate | null
  currentPubkey?: string | null
  isCreator?: boolean
}) => {
  const candidate = args.candidate || null
  const currentPubkey = String(args.currentPubkey || '').trim()
  if (!args.isCreator || !candidate || !currentPubkey) return false
  if (candidate.source.key !== 'resolved-relay') return false
  if (!candidate.source.snapshotAuthorityEligible) return false
  if (String(candidate.event.pubkey || '').trim() !== currentPubkey) return false
  return candidate.members.length === 1 && candidate.members[0] === currentPubkey
}

const hasProtectiveMembershipBaseline = (args: {
  candidates: SnapshotCandidate[]
  currentPubkey?: string | null
  protectedState?: TGroupMembershipState | null
  skipCandidate?: SnapshotCandidate | null
}) => {
  const currentPubkey = String(args.currentPubkey || '').trim()
  const hasCandidateBaseline = args.candidates.some((candidate) => {
    if (!candidate || candidate === args.skipCandidate) return false
    if (candidate.members.length <= 1) return false
    if (currentPubkey && !candidate.members.includes(currentPubkey)) return false
    return true
  })
  if (hasCandidateBaseline) return true

  const protectedState = args.protectedState || null
  if (!protectedState) return false
  if (protectedState.quality !== 'complete') return false
  if (protectedState.memberCount <= 1) return false
  if (currentPubkey && !protectedState.members.includes(currentPubkey)) return false
  return true
}

const fetchSnapshotCandidatesForSource = async (
  fetchEvents: ResolveCanonicalGroupMembershipStateArgs['fetchEvents'],
  groupId: string,
  source: GroupMembershipLiveSourceConfig
) => {
  if (!source.allowSnapshots || !source.relayUrls.length) return null

  const [dTagged, hTagged] = await Promise.all([
    fetchEvents(source.relayUrls, { kinds: [39002], '#d': [groupId], limit: DEFAULT_SNAPSHOT_PAGE_SIZE }),
    fetchEvents(source.relayUrls, { kinds: [39002], '#h': [groupId], limit: DEFAULT_SNAPSHOT_PAGE_SIZE })
  ])

  return dedupeEventsById([...dTagged, ...hTagged]).sort((left, right) => {
      const createdAtDiff = (right.created_at || 0) - (left.created_at || 0)
      if (createdAtDiff !== 0) return createdAtDiff
      return String(right.id || '').localeCompare(String(left.id || ''))
    })
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
  isCreator,
  protectedState,
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
      const events = await fetchSnapshotCandidatesForSource(fetchEvents, groupId, source).catch(() => [])
      return { source, events: Array.isArray(events) ? events : [] }
    })
  )

  const sortedSnapshotCandidates = snapshotResults
    .flatMap((result) =>
      result.events.map((event) => ({
        source: result.source,
        event,
        members: normalizeMembershipPubkeys(parseGroupMembersEvent(event))
      }))
    )
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

  const skippedSuspiciousCandidateIds: string[] = []
  const selectionDiagnostics = sortedSnapshotCandidates.map((candidate) => {
    const suspiciousCreatorSelfOnly = isSuspiciousCreatorSelfOnlySnapshotCandidate({
      candidate,
      currentPubkey,
      isCreator
    })
    const hasProtection = suspiciousCreatorSelfOnly
      ? hasProtectiveMembershipBaseline({
          candidates: sortedSnapshotCandidates,
          currentPubkey,
          protectedState,
          skipCandidate: candidate
        })
      : false
    return {
      candidate,
      suspiciousCreatorSelfOnly,
      skippedReason: suspiciousCreatorSelfOnly && hasProtection ? 'creator-self-only-poisoned-snapshot' : null
    }
  })

  const viableSelectionDiagnostics = selectionDiagnostics.filter((entry) => {
    if (entry.skippedReason) {
      if (entry.candidate.event.id) {
        skippedSuspiciousCandidateIds.push(entry.candidate.event.id)
      }
      return false
    }
    return true
  })

  let selectedSnapshotCandidate =
    viableSelectionDiagnostics.find((entry) => entry.candidate.source.snapshotAuthorityEligible)?.candidate ||
    viableSelectionDiagnostics[0]?.candidate ||
    null

  const usedProtectedState =
    !selectedSnapshotCandidate &&
    hasProtectiveMembershipBaseline({
      candidates: sortedSnapshotCandidates,
      currentPubkey,
      protectedState
    })

  if (usedProtectedState && protectedState) {
    const state = createGroupMembershipState({
      ...protectedState,
      updatedAt: Date.now(),
      membershipFetchTimedOutLike: Date.now() - startedAt >= MEMBERSHIP_FETCH_TIMEOUT_LIKE_MS
    })

    return {
      state,
      selectedSnapshotEvent: null,
      membershipEvents: [],
      joinRequestEvents: [],
      selectionDebug: {
        usedProtectedState: true,
        skippedSuspiciousCandidateIds,
        protectedStateSnapshotId: protectedState.selectedSnapshotId || null,
        candidates: selectionDiagnostics.map((entry) => ({
          id: entry.candidate.event.id || null,
          createdAt: entry.candidate.event.created_at ?? null,
          source: sourceToSnapshotSource(entry.candidate.source.key),
          authorPubkey: String(entry.candidate.event.pubkey || '').trim() || null,
          memberCount: entry.candidate.members.length,
          authorityEligible: entry.candidate.source.snapshotAuthorityEligible,
          suspiciousCreatorSelfOnly: entry.suspiciousCreatorSelfOnly,
          selected: false,
          skippedReason: entry.skippedReason
        }))
      }
    }
  }
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
    joinRequestEvents,
    selectionDebug: {
      usedProtectedState: false,
      skippedSuspiciousCandidateIds,
      protectedStateSnapshotId: protectedState?.selectedSnapshotId || null,
      candidates: selectionDiagnostics.map((entry) => ({
        id: entry.candidate.event.id || null,
        createdAt: entry.candidate.event.created_at ?? null,
        source: sourceToSnapshotSource(entry.candidate.source.key),
        authorPubkey: String(entry.candidate.event.pubkey || '').trim() || null,
        memberCount: entry.candidate.members.length,
        authorityEligible: entry.candidate.source.snapshotAuthorityEligible,
        suspiciousCreatorSelfOnly: entry.suspiciousCreatorSelfOnly,
        selected: entry.candidate === selectedSnapshotCandidate,
        skippedReason: entry.skippedReason
      }))
    }
  }
}
