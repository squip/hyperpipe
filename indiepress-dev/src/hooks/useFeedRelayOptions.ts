import {
  buildGroupRelayDisplayMetaMap,
  buildGroupRelayTargets,
  dedupeRelayTargetsByIdentity,
  dedupeRelayUrlsByIdentity,
  getRelayIdentity,
  normalizeRelayTransportUrl,
  type GroupRelayTarget,
  type RelayDisplayMeta
} from '@/lib/relay-targets'
import { useFavoriteRelays } from '@/providers/FavoriteRelaysProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useCallback, useMemo } from 'react'

function hasTokenInRelayUrl(relayUrl?: string | null) {
  if (!relayUrl) return false
  try {
    return !!new URL(relayUrl).searchParams.get('token')
  } catch (_err) {
    return /[?&]token=/.test(relayUrl)
  }
}

function buildIdentifierCandidates(identifier: string) {
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

export type FeedRelayOption = {
  relayUrl: string
  relayIdentity: string
  isGroupRelay: boolean
  readyForReq: boolean
  groupId?: string
  displayMeta?: RelayDisplayMeta
}

type FeedGroupRelayState = {
  groupId: string
  relayUrl: string
  relayIdentity: string
  label: string
  imageUrl?: string | null
  workerManaged: boolean
  readyForReq: boolean
}

export type FeedRelaySelectionState = {
  relayIdentity: string | null
  relayUrl: string | null
  option: FeedRelayOption | null
  groupState: FeedGroupRelayState | null
  isLocalGroupRelay: boolean
  isWorkerManagedGroupRelay: boolean
  isReadyForReq: boolean
}

export default function useFeedRelayOptions() {
  const { urls } = useFavoriteRelays()
  const { relays: workerRelays } = useWorkerBridge()
  const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()

  const groupRelayTargets = useMemo<GroupRelayTarget[]>(
    () =>
      buildGroupRelayTargets({
        myGroupList,
        resolveRelayUrl,
        getProvisionalGroupMetadata,
        discoveryGroups
      }),
    [discoveryGroups, getProvisionalGroupMetadata, myGroupList, resolveRelayUrl]
  )

  const groupRelayStates = useMemo<FeedGroupRelayState[]>(() => {
    return groupRelayTargets.map((target) => {
      const candidates = buildIdentifierCandidates(target.groupId)
      const relayEntry =
        workerRelays.find(
          (relay) =>
            (relay.publicIdentifier && candidates.includes(relay.publicIdentifier))
            || (relay.relayKey && candidates.includes(relay.relayKey))
        ) || null
      const workerManaged = !!relayEntry
      const candidateRelayUrl = relayEntry?.connectionUrl || target.relayUrl
      const resolvedRelayUrl =
        normalizeRelayTransportUrl(resolveRelayUrl(candidateRelayUrl) || candidateRelayUrl)
        || target.relayUrl
      const relayIdentity = getRelayIdentity(resolvedRelayUrl) || target.relayIdentity
      const requiresAuth = relayEntry?.requiresAuth === true
      const writable = relayEntry?.writable === true
      const tokenPresent =
        !!relayEntry?.userAuthToken
        || hasTokenInRelayUrl(relayEntry?.connectionUrl)
        || hasTokenInRelayUrl(resolvedRelayUrl)
      const fallbackReadyForReq = writable && (!requiresAuth || tokenPresent)
      const relayReadyForReq =
        typeof relayEntry?.readyForReq === 'boolean' ? relayEntry.readyForReq : fallbackReadyForReq

      return {
        groupId: target.groupId,
        relayUrl: resolvedRelayUrl,
        relayIdentity,
        label: target.label,
        imageUrl: target.imageUrl || null,
        workerManaged,
        readyForReq: workerManaged ? relayReadyForReq : false
      }
    })
  }, [groupRelayTargets, resolveRelayUrl, workerRelays])

  const workerManagedGroupRelayTargets = useMemo<GroupRelayTarget[]>(
    () =>
      groupRelayStates
        .filter((state) => state.workerManaged)
        .map((state) => ({
          groupId: state.groupId,
          relayUrl: state.relayUrl,
          relayIdentity: state.relayIdentity,
          label: state.label,
          imageUrl: state.imageUrl || null
        })),
    [groupRelayStates]
  )

  const groupRelayDisplayMeta = useMemo(
    () => buildGroupRelayDisplayMetaMap(workerManagedGroupRelayTargets),
    [workerManagedGroupRelayTargets]
  )

  const groupRelayStateByIdentity = useMemo(() => {
    const map = new Map<string, FeedGroupRelayState>()
    groupRelayStates.forEach((state) => {
      map.set(state.relayIdentity, state)
    })
    return map
  }, [groupRelayStates])

  const readyGroupRelayUrls = useMemo(
    () =>
      dedupeRelayUrlsByIdentity(
        groupRelayStates
          .filter((state) => state.workerManaged && state.readyForReq)
          .map((state) => state.relayUrl)
      ),
    [groupRelayStates]
  )

  const mergedRelayUrls = useMemo(
    () => dedupeRelayUrlsByIdentity([...(urls || []), ...readyGroupRelayUrls]),
    [readyGroupRelayUrls, urls]
  )

  const relayOptions = useMemo<FeedRelayOption[]>(
    () =>
      dedupeRelayTargetsByIdentity(mergedRelayUrls)
        .map(({ relayUrl, relayIdentity }) => {
          const groupState = groupRelayStateByIdentity.get(relayIdentity)
          const displayMeta =
            groupRelayDisplayMeta[relayIdentity] || groupRelayDisplayMeta[relayUrl] || undefined
          return {
            relayUrl,
            relayIdentity,
            isGroupRelay: !!groupState,
            readyForReq: groupState ? groupState.readyForReq : true,
            groupId: groupState?.groupId,
            displayMeta
          }
        })
        .filter((option) => !option.isGroupRelay || option.readyForReq),
    [groupRelayDisplayMeta, groupRelayStateByIdentity, mergedRelayUrls]
  )

  const relayOptionByIdentity = useMemo(() => {
    const map = new Map<string, FeedRelayOption>()
    relayOptions.forEach((option) => {
      map.set(option.relayIdentity, option)
    })
    return map
  }, [relayOptions])

  const readinessByRelayIdentity = useMemo(() => {
    const readiness: Record<string, boolean> = {}
    groupRelayStates.forEach((state) => {
      if (!state.workerManaged) return
      readiness[state.relayIdentity] = state.readyForReq
    })
    return readiness
  }, [groupRelayStates])

  const readinessByGroupId = useMemo(() => {
    const readiness: Record<string, boolean> = {}
    groupRelayStates.forEach((state) => {
      if (!state.workerManaged) return
      readiness[state.groupId] = state.readyForReq
    })
    return readiness
  }, [groupRelayStates])

  const getRelaySelectionState = useCallback(
    (relay?: string | null): FeedRelaySelectionState => {
      const resolvedInput = relay ? resolveRelayUrl(relay) || relay : null
      const normalizedRelay = resolvedInput ? normalizeRelayTransportUrl(resolvedInput) : null
      const relayIdentity =
        (normalizedRelay && getRelayIdentity(normalizedRelay))
        || (relay ? getRelayIdentity(relay) : null)
      if (!relayIdentity) {
        return {
          relayIdentity: null,
          relayUrl: normalizedRelay || resolvedInput || null,
          option: null,
          groupState: null,
          isLocalGroupRelay: false,
          isWorkerManagedGroupRelay: false,
          isReadyForReq: true
        }
      }

      const option = relayOptionByIdentity.get(relayIdentity) || null
      const groupState = groupRelayStateByIdentity.get(relayIdentity) || null
      return {
        relayIdentity,
        relayUrl: option?.relayUrl || groupState?.relayUrl || normalizedRelay || resolvedInput || null,
        option,
        groupState,
        isLocalGroupRelay: !!groupState,
        isWorkerManagedGroupRelay: groupState ? groupState.workerManaged : false,
        isReadyForReq: groupState ? groupState.readyForReq : true
      }
    },
    [groupRelayStateByIdentity, relayOptionByIdentity, resolveRelayUrl]
  )

  return {
    relayOptions,
    groupRelayDisplayMeta,
    readinessByRelayIdentity,
    readinessByGroupId,
    getRelaySelectionState
  }
}
