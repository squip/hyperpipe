import { getRelayIdentity, normalizeRelayTransportUrl } from '@/lib/relay-targets'
import { useNostr } from '@/providers/NostrProvider'
import storage from '@/services/local-storage.service'
import { useCallback, useEffect, useState } from 'react'

export default function useSharedFeedCustomRelayUrls() {
  const { pubkey } = useNostr()
  const [relayUrls, setRelayUrls] = useState<string[]>(() =>
    storage.getSharedFeedFilterCustomRelayUrls(pubkey)
  )

  useEffect(() => {
    setRelayUrls(storage.getSharedFeedFilterCustomRelayUrls(pubkey))
  }, [pubkey])

  const persistRelayUrls = useCallback(
    (nextRelayUrls: string[]) => {
      setRelayUrls(nextRelayUrls)
      storage.setSharedFeedFilterCustomRelayUrls(pubkey, nextRelayUrls)
    },
    [pubkey]
  )

  const addRelayUrl = useCallback(
    (input: string) => {
      const normalizedRelayUrl = normalizeRelayTransportUrl(input)
      if (!normalizedRelayUrl) return null

      const relayIdentity = getRelayIdentity(normalizedRelayUrl)
      if (!relayIdentity) return null

      const nextRelayUrls = relayUrls.filter((relayUrl) => {
        const existingRelayIdentity = getRelayIdentity(relayUrl)
        return existingRelayIdentity !== relayIdentity
      })
      persistRelayUrls([...nextRelayUrls, normalizedRelayUrl])
      return relayIdentity
    },
    [persistRelayUrls, relayUrls]
  )

  const removeRelayIdentity = useCallback(
    (relayIdentity: string) => {
      const normalizedRelayIdentity = getRelayIdentity(relayIdentity) || relayIdentity
      persistRelayUrls(
        relayUrls.filter((relayUrl) => getRelayIdentity(relayUrl) !== normalizedRelayIdentity)
      )
    },
    [persistRelayUrls, relayUrls]
  )

  return {
    relayUrls,
    addRelayUrl,
    removeRelayIdentity
  }
}
