import { SEARCHABLE_RELAY_URLS } from '@/constants'
import { useFeed } from '@/providers/FeedProvider'
import client from '@/services/client.service'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFetchRelayInfos } from './useFetchRelayInfos'
import { NostrUser } from '@nostr/gadgets/metadata'

export function useSearchProfiles(search: string, limit: number) {
  const { relayUrls } = useFeed()
  const { searchableRelayUrls } = useFetchRelayInfos(relayUrls)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [profiles, setProfiles] = useState<NostrUser[]>([])
  const requestIdRef = useRef(0)
  const remoteDelayMs = 80
  const fetchLimit = Math.max(limit * 3, 24)
  const remoteRelayUrls = useMemo(
    () => Array.from(new Set([...searchableRelayUrls, ...SEARCHABLE_RELAY_URLS])).slice(0, 4),
    [searchableRelayUrls]
  )
  const remoteRelayKey = useMemo(() => remoteRelayUrls.join(','), [remoteRelayUrls])

  useEffect(() => {
    const trimmedSearch = search.trim()
    const requestId = ++requestIdRef.current
    const startedAt = Date.now()
    let cancelled = false
    let remoteTimer: number | null = null
    let settledCount = 0
    let rejectedCount = 0
    let firstError: Error | null = null
    const mergedProfiles = new Map<string, NostrUser>()
    const profileOrder = new Map<string, number>()
    let nextOrder = 0

    const isStale = () => cancelled || requestIdRef.current !== requestId
    const finishOne = () => {
      settledCount += 1
      if (settledCount < 2 || isStale()) return
      console.info('[useSearchProfiles] search settled', {
        requestId,
        search: trimmedSearch,
        settledCount,
        rejectedCount,
        elapsedMs: Date.now() - startedAt,
        profileCount: mergedProfiles.size
      })
      if (rejectedCount === 2) {
        setError(firstError || new Error('fail to search profiles'))
      } else {
        setError(null)
      }
      setIsFetching(false)
    }
    const recordError = (reason: unknown) => {
      rejectedCount += 1
      if (firstError) return
      firstError = reason instanceof Error ? reason : new Error(String(reason))
    }
    const profileQuality = (profile: NostrUser) => {
      const metadata = profile?.metadata || {}
      let score = 0
      if (metadata.display_name) score += 3
      if (metadata.name) score += 2
      if (metadata.nip05) score += 1
      if (metadata.picture) score += 1
      return score
    }
    const shouldReplaceExistingProfile = (
      existing: NostrUser,
      incoming: NostrUser,
      source: 'local' | 'remote'
    ) => {
      if (source === 'remote') return true
      return profileQuality(incoming) > profileQuality(existing)
    }
    const mergeResults = (results: NostrUser[], source: 'local' | 'remote') => {
      if (!Array.isArray(results) || !results.length) {
        console.info('[useSearchProfiles] search results empty', {
          requestId,
          search: trimmedSearch,
          source,
          stale: isStale()
        })
        return
      }
      if (isStale()) {
        console.info('[useSearchProfiles] search results ignored (stale)', {
          requestId,
          search: trimmedSearch,
          source,
          resultCount: results.length
        })
        return
      }
      let addedCount = 0
      let replacedCount = 0
      let skippedDuplicateCount = 0
      for (let i = 0; i < results.length; i++) {
        const profile = results[i]
        if (!profile?.pubkey) continue
        const existing = mergedProfiles.get(profile.pubkey)
        if (!existing) {
          mergedProfiles.set(profile.pubkey, profile)
          profileOrder.set(profile.pubkey, nextOrder++)
          addedCount += 1
          continue
        }
        if (shouldReplaceExistingProfile(existing, profile, source)) {
          mergedProfiles.set(profile.pubkey, profile)
          replacedCount += 1
        } else {
          skippedDuplicateCount += 1
        }
      }
      const nextProfiles = Array.from(mergedProfiles.entries())
        .sort((left, right) => {
          const leftOrder = profileOrder.get(left[0]) ?? Number.MAX_SAFE_INTEGER
          const rightOrder = profileOrder.get(right[0]) ?? Number.MAX_SAFE_INTEGER
          return leftOrder - rightOrder
        })
        .map((entry) => entry[1])
        .slice(0, fetchLimit)
      const withDisplayName = nextProfiles.filter((profile) => profile?.metadata?.display_name).length
      const withName = nextProfiles.filter((profile) => profile?.metadata?.name).length
      console.info('[useSearchProfiles] search results merged', {
        requestId,
        search: trimmedSearch,
        source,
        inputCount: results.length,
        addedCount,
        replacedCount,
        skippedDuplicateCount,
        mergedCount: mergedProfiles.size,
        returnedCount: nextProfiles.length,
        withDisplayName,
        withName
      })
      setProfiles(nextProfiles)
    }

    if (!trimmedSearch) {
      setProfiles([])
      setError(null)
      setIsFetching(false)
      console.info('[useSearchProfiles] search cleared', {
        requestId,
        search: trimmedSearch
      })
      return () => {
        cancelled = true
      }
    }

    setIsFetching(true)
    setError(null)
    console.info('[useSearchProfiles] search start', {
      requestId,
      search: trimmedSearch,
      limit,
      fetchLimit,
      remoteDelayMs,
      remoteRelayCount: remoteRelayUrls.length
    })

    client
      .searchProfilesFromLocal(trimmedSearch, fetchLimit)
      .then((results) => {
        mergeResults(results, 'local')
      })
      .catch((error) => {
        recordError(error)
      })
      .finally(() => {
        finishOne()
      })

    remoteTimer = window.setTimeout(() => {
      console.info('[useSearchProfiles] remote search start', {
        requestId,
        search: trimmedSearch,
        relayCount: remoteRelayUrls.length,
        relayPreview: remoteRelayUrls.slice(0, 2)
      })
      client
        .searchProfiles(remoteRelayUrls, {
          search: trimmedSearch,
          limit: fetchLimit
        })
        .then((results) => {
          mergeResults(results, 'remote')
        })
        .catch((error) => {
          recordError(error)
        })
        .finally(() => {
          finishOne()
        })
    }, remoteDelayMs)

    return () => {
      cancelled = true
      if (remoteTimer !== null) {
        clearTimeout(remoteTimer)
      }
    }
  }, [search, limit, fetchLimit, remoteRelayUrls, remoteRelayKey])

  return { isFetching, error, profiles }
}
