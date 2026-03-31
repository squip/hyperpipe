import type {
  TGroupPresenceInput,
  TGroupPresenceProbeResult,
  TGroupPresenceState
} from '@/types/groups'

export const GROUP_PAGE_PRESENCE_TTL_MS = 15_000
export const MY_GROUPS_PRESENCE_TTL_MS = 20_000
export const DISCOVER_GROUPS_PRESENCE_TTL_MS = 30_000
export const MAX_CONCURRENT_GROUP_PRESENCE_REQUESTS = 3
const GROUP_PRESENCE_GATEWAY_FALLBACK_GRACE_MS = 60_000
const GROUP_PRESENCE_GATEWAY_FALLBACK_RETRY_MS = 5_000

type GroupPresenceListener = () => void

type GroupPresenceProbeFn = (
  args: TGroupPresenceInput & { timeoutMs?: number }
) => Promise<TGroupPresenceProbeResult>

type GroupPresenceCacheEntry = {
  query: TGroupPresenceInput
  state: TGroupPresenceState
  expiresAt: number
}

type GroupPresenceQueueJob = {
  key: string
  query: TGroupPresenceInput
  ttlMs: number
  priority: number
  timeoutMs?: number
  probe: GroupPresenceProbeFn
}

const groupPresenceCache = new Map<string, GroupPresenceCacheEntry>()
const groupPresenceInflight = new Map<string, Promise<TGroupPresenceState>>()
const groupPresenceListeners = new Map<string, Set<GroupPresenceListener>>()
const groupPresenceQueue: GroupPresenceQueueJob[] = []
const queuedPresenceKeys = new Set<string>()
let activeGroupPresenceRequests = 0

function normalizePeerKeyList(values?: string[]) {
  if (!Array.isArray(values) || values.length === 0) return []
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  )
}

export function createGroupPresenceState(
  overrides: Partial<TGroupPresenceState> = {}
): TGroupPresenceState {
  const count = Number.isFinite(overrides.count) ? Number(overrides.count) : null
  const status = overrides.status || (count === null ? 'idle' : 'ready')
  return {
    count,
    status,
    source: overrides.source || 'unknown',
    gatewayIncluded: overrides.gatewayIncluded === true,
    gatewayHealthy: overrides.gatewayHealthy === true,
    lastUpdatedAt: Number.isFinite(overrides.lastUpdatedAt) ? Number(overrides.lastUpdatedAt) : null,
    unknown: overrides.unknown === true || status === 'unknown' || (count === null && status !== 'ready'),
    error: typeof overrides.error === 'string' && overrides.error.trim() ? overrides.error.trim() : null
  }
}

export function normalizeGroupPresenceInput(input: TGroupPresenceInput): TGroupPresenceInput {
  return {
    groupId: typeof input.groupId === 'string' ? input.groupId.trim() : '',
    relay: typeof input.relay === 'string' && input.relay.trim() ? input.relay.trim() : undefined,
    gatewayId: typeof input.gatewayId === 'string' && input.gatewayId.trim() ? input.gatewayId.trim().toLowerCase() : null,
    gatewayOrigin:
      typeof input.gatewayOrigin === 'string' && input.gatewayOrigin.trim()
        ? input.gatewayOrigin.trim()
        : null,
    directJoinOnly: input.directJoinOnly === true,
    discoveryTopic:
      typeof input.discoveryTopic === 'string' && input.discoveryTopic.trim()
        ? input.discoveryTopic.trim()
        : null,
    hostPeerKeys: normalizePeerKeyList(input.hostPeerKeys),
    leaseReplicaPeerKeys: normalizePeerKeyList(input.leaseReplicaPeerKeys)
  }
}

export function buildGroupPresenceCacheKey(input: TGroupPresenceInput | string | null | undefined) {
  if (typeof input === 'string') {
    const normalized = input.trim()
    return normalized || null
  }
  const normalizedGroupId = typeof input?.groupId === 'string' ? input.groupId.trim() : ''
  return normalizedGroupId || null
}

export function mergeGroupPresenceInputs(
  base: TGroupPresenceInput | null | undefined,
  next: TGroupPresenceInput
): TGroupPresenceInput {
  const normalizedNext = normalizeGroupPresenceInput(next)
  if (!base) return normalizedNext
  const normalizedBase = normalizeGroupPresenceInput(base)
  return {
    groupId: normalizedNext.groupId || normalizedBase.groupId,
    relay: normalizedNext.relay || normalizedBase.relay,
    gatewayId: normalizedNext.gatewayId || normalizedBase.gatewayId,
    gatewayOrigin: normalizedNext.gatewayOrigin || normalizedBase.gatewayOrigin,
    directJoinOnly:
      normalizedNext.directJoinOnly === true || normalizedBase.directJoinOnly === true,
    discoveryTopic: normalizedNext.discoveryTopic || normalizedBase.discoveryTopic,
    hostPeerKeys: normalizePeerKeyList([
      ...(normalizedBase.hostPeerKeys || []),
      ...(normalizedNext.hostPeerKeys || [])
    ]),
    leaseReplicaPeerKeys: normalizePeerKeyList([
      ...(normalizedBase.leaseReplicaPeerKeys || []),
      ...(normalizedNext.leaseReplicaPeerKeys || [])
    ])
  }
}

export function getCachedGroupPresenceState(
  input: TGroupPresenceInput | string | null | undefined
): TGroupPresenceState {
  const key = buildGroupPresenceCacheKey(input)
  if (!key) {
    return createGroupPresenceState({
      status: 'unknown',
      unknown: true
    })
  }
  return groupPresenceCache.get(key)?.state || createGroupPresenceState()
}

export function compareGroupPresenceStates(
  left: TGroupPresenceState | null | undefined,
  right: TGroupPresenceState | null | undefined,
  direction: 'asc' | 'desc'
) {
  const leftReady = left?.status === 'ready' && Number.isFinite(left?.count)
  const rightReady = right?.status === 'ready' && Number.isFinite(right?.count)

  if (leftReady && rightReady) {
    const leftCount = Number(left?.count || 0)
    const rightCount = Number(right?.count || 0)
    return direction === 'asc' ? leftCount - rightCount : rightCount - leftCount
  }

  if (leftReady !== rightReady) {
    return leftReady ? -1 : 1
  }

  return 0
}

function notifyGroupPresenceListeners(key: string) {
  const listeners = groupPresenceListeners.get(key)
  if (!listeners?.size) return
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeGroupPresence(
  key: string,
  listener: GroupPresenceListener
) {
  const normalizedKey = buildGroupPresenceCacheKey(key)
  if (!normalizedKey) return () => {}
  const listeners = groupPresenceListeners.get(normalizedKey) || new Set<GroupPresenceListener>()
  listeners.add(listener)
  groupPresenceListeners.set(normalizedKey, listeners)
  return () => {
    const current = groupPresenceListeners.get(normalizedKey)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      groupPresenceListeners.delete(normalizedKey)
    }
  }
}

function setGroupPresenceCacheEntry(key: string, entry: GroupPresenceCacheEntry) {
  groupPresenceCache.set(key, entry)
  notifyGroupPresenceListeners(key)
}

function normalizeGroupPresenceProbeResult(
  result: TGroupPresenceProbeResult
): TGroupPresenceState {
  return createGroupPresenceState({
    count: Number.isFinite(result.aggregatePeerCount)
      ? Number(result.aggregatePeerCount)
      : result.count,
    status: result.status,
    source: result.source,
    gatewayIncluded: result.gatewayIncluded,
    gatewayHealthy: result.gatewayHealthy,
    lastUpdatedAt: Number.isFinite(result.verifiedAt)
      ? Number(result.verifiedAt)
      : result.lastUpdatedAt,
    unknown: result.unknown,
    error: result.error || null
  })
}

function shouldRefreshGroupPresence(entry: GroupPresenceCacheEntry | undefined) {
  if (!entry) return true
  if (entry.expiresAt <= Date.now()) return true
  if (entry.state.status === 'idle') return true
  return false
}

function isGatewayBackedPresenceInput(input: TGroupPresenceInput | null | undefined) {
  if (!input) return false
  return input.directJoinOnly !== true && !!String(input.gatewayOrigin || '').trim()
}

function isGatewayFallbackError(error: string | null | undefined) {
  const normalized = String(error || '').trim().toLowerCase()
  if (!normalized) return false
  return (
    normalized === 'fetch failed'
    || normalized.startsWith('gateway-presence-')
  )
}

export function selectGroupPresenceStateUpdate({
  existingState,
  nextState,
  query,
  now = Date.now()
}: {
  existingState?: TGroupPresenceState | null
  nextState: TGroupPresenceState
  query: TGroupPresenceInput
  now?: number
}) {
  const shouldPreserveExistingGatewayReadyState =
    isGatewayBackedPresenceInput(query)
    && existingState?.status === 'ready'
    && existingState?.source === 'gateway'
    && Number.isFinite(existingState?.count)
    && nextState.status === 'ready'
    && nextState.source === 'direct-probe'
    && Number.isFinite(nextState.count)
    && Number(existingState.count) > Number(nextState.count)
    && isGatewayFallbackError(nextState.error)
    && Number.isFinite(existingState.lastUpdatedAt)
    && now - Number(existingState.lastUpdatedAt) <= GROUP_PRESENCE_GATEWAY_FALLBACK_GRACE_MS

  if (shouldPreserveExistingGatewayReadyState) {
    return {
      state: createGroupPresenceState({
        ...existingState,
        error: nextState.error || existingState?.error || null
      }),
      expiresAt: now + GROUP_PRESENCE_GATEWAY_FALLBACK_RETRY_MS,
      preservedGatewayState: true
    }
  }

  return {
    state: nextState,
    expiresAt: now,
    preservedGatewayState: false
  }
}

function runGroupPresenceQueue() {
  while (
    activeGroupPresenceRequests < MAX_CONCURRENT_GROUP_PRESENCE_REQUESTS
    && groupPresenceQueue.length > 0
  ) {
    groupPresenceQueue.sort((left, right) => right.priority - left.priority)
    const job = groupPresenceQueue.shift()
    if (!job) return
    queuedPresenceKeys.delete(job.key)

    const promise = (async () => {
      activeGroupPresenceRequests += 1
      try {
        const result = await job.probe({
          ...job.query,
          timeoutMs: job.timeoutMs
        })
        const nextState = normalizeGroupPresenceProbeResult(result)
        const existingState = groupPresenceCache.get(job.key)?.state || null
        const selected = selectGroupPresenceStateUpdate({
          existingState,
          nextState,
          query: job.query
        })
        if (selected.preservedGatewayState) {
          console.warn('[GroupPresence] Preserving previous gateway-backed presence over reduced fallback probe result', {
            groupId: job.query.groupId,
            previousCount: existingState?.count ?? null,
            fallbackCount: nextState.count,
            error: nextState.error || null
          })
        }
        setGroupPresenceCacheEntry(job.key, {
          query: job.query,
          state: selected.state,
          expiresAt: selected.preservedGatewayState
            ? selected.expiresAt
            : Date.now() + Math.max(1_000, job.ttlMs)
        })
        return selected.state
      } catch (error) {
        const existing = groupPresenceCache.get(job.key)
        if (!existing || existing.state.status !== 'ready') {
          const errorState = createGroupPresenceState({
            status: 'error',
            source: existing?.state.source || 'unknown',
            gatewayIncluded: existing?.state.gatewayIncluded,
            gatewayHealthy: existing?.state.gatewayHealthy,
            error: error instanceof Error ? error.message : String(error)
          })
          setGroupPresenceCacheEntry(job.key, {
            query: job.query,
            state: errorState,
            expiresAt: Date.now() + Math.max(1_000, job.ttlMs)
          })
          return errorState
        }
        return existing.state
      } finally {
        activeGroupPresenceRequests = Math.max(0, activeGroupPresenceRequests - 1)
        groupPresenceInflight.delete(job.key)
        runGroupPresenceQueue()
      }
    })()

    groupPresenceInflight.set(job.key, promise)
  }
}

export function scheduleGroupPresenceProbe(
  input: TGroupPresenceInput,
  probe: GroupPresenceProbeFn,
  {
    ttlMs,
    priority = 0,
    timeoutMs
  }: {
    ttlMs: number
    priority?: number
    timeoutMs?: number
  }
) {
  const normalizedInput = normalizeGroupPresenceInput(input)
  const key = buildGroupPresenceCacheKey(normalizedInput)
  if (!key) {
    return Promise.resolve(
      createGroupPresenceState({
        status: 'unknown',
        unknown: true
      })
    )
  }

  const existing = groupPresenceCache.get(key)
  const mergedQuery = mergeGroupPresenceInputs(existing?.query, normalizedInput)
  if (existing && existing.query !== mergedQuery) {
    groupPresenceCache.set(key, {
      ...existing,
      query: mergedQuery
    })
  }

  if (!shouldRefreshGroupPresence(existing) && !groupPresenceInflight.has(key)) {
    return Promise.resolve(existing?.state || createGroupPresenceState())
  }

  if (groupPresenceInflight.has(key)) {
    return groupPresenceInflight.get(key) as Promise<TGroupPresenceState>
  }

  if (!existing || existing.state.status !== 'ready') {
    setGroupPresenceCacheEntry(key, {
      query: mergedQuery,
      state: createGroupPresenceState({
        status: 'scanning',
        source: existing?.state.source || 'unknown',
        gatewayIncluded: existing?.state.gatewayIncluded,
        gatewayHealthy: existing?.state.gatewayHealthy
      }),
      expiresAt: Date.now()
    })
  }

  if (!queuedPresenceKeys.has(key)) {
    queuedPresenceKeys.add(key)
    groupPresenceQueue.push({
      key,
      query: mergedQuery,
      ttlMs,
      priority,
      timeoutMs,
      probe
    })
    runGroupPresenceQueue()
  }

  return groupPresenceInflight.get(key) || Promise.resolve(getCachedGroupPresenceState(key))
}

export function resetGroupPresenceCache() {
  groupPresenceCache.clear()
  groupPresenceInflight.clear()
  groupPresenceListeners.clear()
  groupPresenceQueue.length = 0
  queuedPresenceKeys.clear()
  activeGroupPresenceRequests = 0
}
