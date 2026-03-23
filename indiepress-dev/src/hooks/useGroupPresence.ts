import {
  DISCOVER_GROUPS_PRESENCE_TTL_MS,
  createGroupPresenceState,
  getCachedGroupPresenceState,
  GROUP_PAGE_PRESENCE_TTL_MS,
  MY_GROUPS_PRESENCE_TTL_MS,
  normalizeGroupPresenceInput,
  scheduleGroupPresenceProbe,
  subscribeGroupPresence
} from '@/lib/group-presence'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import type { TGroupPresenceInput, TGroupPresenceState } from '@/types/groups'
import { useEffect, useMemo, useState } from 'react'

export function useGroupPresence(
  input: TGroupPresenceInput | null,
  {
    enabled = true,
    ttlMs = GROUP_PAGE_PRESENCE_TTL_MS,
    priority = 2,
    timeoutMs = 8_000
  }: {
    enabled?: boolean
    ttlMs?: number
    priority?: number
    timeoutMs?: number
  } = {}
) {
  const { probeGroupPresence } = useWorkerBridge()
  const normalizedInput = useMemo(
    () => (input ? normalizeGroupPresenceInput(input) : null),
    [input]
  )
  const cacheKey = normalizedInput?.groupId || null
  const [state, setState] = useState<TGroupPresenceState>(() =>
    cacheKey ? getCachedGroupPresenceState(cacheKey) : createGroupPresenceState({ status: 'unknown', unknown: true })
  )

  useEffect(() => {
    if (!cacheKey || !normalizedInput) {
      setState(createGroupPresenceState({ status: 'unknown', unknown: true }))
      return
    }

    setState(getCachedGroupPresenceState(cacheKey))
    const unsubscribe = subscribeGroupPresence(cacheKey, () => {
      setState(getCachedGroupPresenceState(cacheKey))
    })

    if (enabled) {
      void scheduleGroupPresenceProbe(normalizedInput, probeGroupPresence, {
        ttlMs,
        priority,
        timeoutMs
      })
    }

    return unsubscribe
  }, [cacheKey, enabled, normalizedInput, priority, probeGroupPresence, timeoutMs, ttlMs])

  return state
}

export function useGroupPresenceMap(
  inputs: TGroupPresenceInput[],
  {
    enabled = true,
    ttlMs = DISCOVER_GROUPS_PRESENCE_TTL_MS,
    priority = 0,
    timeoutMs = 8_000
  }: {
    enabled?: boolean
    ttlMs?: number
    priority?: number
    timeoutMs?: number
  } = {}
) {
  const { probeGroupPresence } = useWorkerBridge()
  const serializedInputs = JSON.stringify(inputs || [])
  const normalizedInputs = useMemo(
    () => (Array.isArray(inputs) ? inputs.map((input) => normalizeGroupPresenceInput(input)) : []),
    [serializedInputs]
  )
  const keys = useMemo(
    () => normalizedInputs.map((input) => input.groupId).filter(Boolean),
    [normalizedInputs]
  )
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!keys.length) return
    const handleUpdate = () => setVersion((prev) => prev + 1)
    const unsubscribers = keys.map((key) => subscribeGroupPresence(key, handleUpdate))

    if (enabled) {
      for (const input of normalizedInputs) {
        void scheduleGroupPresenceProbe(input, probeGroupPresence, {
          ttlMs,
          priority,
          timeoutMs
        })
      }
    }

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [enabled, keys, normalizedInputs, priority, probeGroupPresence, timeoutMs, ttlMs])

  return useMemo(() => {
    const map = new Map<string, TGroupPresenceState>()
    for (const input of normalizedInputs) {
      map.set(input.groupId, getCachedGroupPresenceState(input.groupId))
    }
    return map
  }, [normalizedInputs, version])
}

export {
  DISCOVER_GROUPS_PRESENCE_TTL_MS,
  GROUP_PAGE_PRESENCE_TTL_MS,
  MY_GROUPS_PRESENCE_TTL_MS
}
