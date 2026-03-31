import { createMuteListDraftEvent } from '@/lib/draft-event'
import client from '@/services/client.service'
import storage from '@/services/local-storage.service'
import dayjs from 'dayjs'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useNostr } from './NostrProvider'
import { TMutedList } from '@/types'

type TMuteListContext = {
  changing: boolean
  mutePubkeySet: Set<string>
  getMutePubkeys: () => string[]
  getMuteType: (pubkey: string) => 'public' | 'private' | null
  mutePublicly: (pubkey: string) => Promise<void>
  mutePrivately: (pubkey: string) => Promise<void>
  unmute: (pubkey: string) => Promise<void>
}

const MuteListContext = createContext<TMuteListContext | undefined>(undefined)

export const useMuteList = () => {
  const context = useContext(MuteListContext)
  if (!context) {
    throw new Error('useMuteList must be used within a MuteListProvider')
  }
  return context
}

export function MuteListProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const {
    pubkey: accountPubkey,
    muteList,
    publish,
    updateMuteListEvent,
    nip04Encrypt,
    nip04Decrypt
  } = useNostr()
  const [changing, setChanging] = useState(false)
  const [lastPublished, setLastPublished] = useState(0)
  const [optimisticMuteList, setOptimisticMuteList] = useState<TMutedList | null>(null)

  const effectiveMuteList = optimisticMuteList || muteList

  useEffect(() => {
    setOptimisticMuteList(null)
  }, [accountPubkey])

  const getMutePubkeys = () => {
    return [...effectiveMuteList.public, ...effectiveMuteList.private]
  }

  const mutePubkeySet = useMemo(() => {
    return new Set([...effectiveMuteList.private, ...effectiveMuteList.public])
  }, [effectiveMuteList])

  const getMuteType = useCallback(
    (pubkey: string): 'public' | 'private' | null => {
      if (effectiveMuteList.public.includes(pubkey)) return 'public'
      if (effectiveMuteList.private.includes(pubkey)) return 'private'
      return null
    },
    [effectiveMuteList]
  )

  const publishNewMuteListEvent = async (list: TMutedList) => {
    if (!accountPubkey) return

    const tags = list.public.map((pubkey) => ['p', pubkey])
    const content = await nip04Encrypt(
      accountPubkey,
      JSON.stringify(list.private.map((pubkey) => ['p', pubkey]))
    )

    if (dayjs().unix() === lastPublished) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const newMuteListDraftEvent = createMuteListDraftEvent(tags, content)
    const event = await publish(newMuteListDraftEvent)
    toast.success(t('Successfully updated mute list'))
    setLastPublished(dayjs().unix())
    await updateMuteListEvent(event)

    return event
  }

  const checkMuteList = (muteList: TMutedList) => {
    if (muteList.public.length === 0 && muteList.private.length === 0) {
      const result = confirm(t('MuteListNotFoundConfirmation'))
      if (!result) {
        throw new Error('Mute list not found')
      }
    }
  }

  const cloneMuteList = useCallback(
    (value: TMutedList): TMutedList => ({
      public: [...value.public],
      private: [...value.private]
    }),
    []
  )

  const resolveSourceMuteList = useCallback(async () => {
    const cached = cloneMuteList(effectiveMuteList)
    if (cached.public.length > 0 || cached.private.length > 0 || !accountPubkey) {
      return cached
    }

    const fetched = await client.fetchMuteList(accountPubkey, nip04Decrypt)
    storage.setMuteListCache(accountPubkey, fetched)
    return fetched
  }, [accountPubkey, cloneMuteList, effectiveMuteList, nip04Decrypt])

  const mutePublicly = async (pubkey: string) => {
    if (!accountPubkey || changing) return

    setChanging(true)
    try {
      const nextMuteList = await resolveSourceMuteList()
      checkMuteList(nextMuteList)

      if (!nextMuteList.public.includes(pubkey)) {
        // add to public
        nextMuteList.public.push(pubkey)

        {
          // and remove from private
          const idx = nextMuteList.private.indexOf(pubkey)
          if (idx !== -1) {
            nextMuteList.private.splice(idx, 1)
          }
        }

        setOptimisticMuteList(nextMuteList)
        storage.setMuteListCache(accountPubkey, nextMuteList)
        await publishNewMuteListEvent(nextMuteList)
        setOptimisticMuteList(null)
      }
    } catch (error) {
      storage.setMuteListCache(accountPubkey, muteList)
      setOptimisticMuteList(null)
      toast.error(t('Failed to mute user publicly') + ': ' + (error as Error).message)
    } finally {
      setChanging(false)
    }
  }

  const mutePrivately = async (pubkey: string) => {
    if (!accountPubkey || changing) return

    setChanging(true)
    try {
      const nextMuteList = await resolveSourceMuteList()
      checkMuteList(nextMuteList)

      if (!nextMuteList.private.includes(pubkey)) {
        // add to private
        nextMuteList.private.push(pubkey)

        {
          // and remove from public
          const idx = nextMuteList.public.indexOf(pubkey)
          if (idx !== -1) {
            nextMuteList.public.splice(idx, 1)
          }
        }

        setOptimisticMuteList(nextMuteList)
        storage.setMuteListCache(accountPubkey, nextMuteList)
        await publishNewMuteListEvent(nextMuteList)
        setOptimisticMuteList(null)
      }
    } catch (error) {
      storage.setMuteListCache(accountPubkey, muteList)
      setOptimisticMuteList(null)
      toast.error(t('Failed to mute user privately') + ': ' + (error as Error).message)
    } finally {
      setChanging(false)
    }
  }

  const unmute = async (pubkey: string) => {
    if (!accountPubkey || changing) return

    setChanging(true)
    try {
      const nextMuteList = await resolveSourceMuteList()
      checkMuteList(nextMuteList)

      let modified = false
      {
        const idx = nextMuteList.private.indexOf(pubkey)
        if (idx !== -1) {
          nextMuteList.private.splice(idx, 1)
          modified = true
        }
      }
      {
        const idx = nextMuteList.public.indexOf(pubkey)
        if (idx !== -1) {
          nextMuteList.public.splice(idx, 1)
          modified = true
        }
      }

      if (modified) {
        setOptimisticMuteList(nextMuteList)
        storage.setMuteListCache(accountPubkey, nextMuteList)
        await publishNewMuteListEvent(nextMuteList)
        setOptimisticMuteList(null)
      }
    } catch (error) {
      storage.setMuteListCache(accountPubkey, muteList)
      setOptimisticMuteList(null)
      toast.error(t('Failed to unmute user') + ': ' + (error as Error).message)
    } finally {
      setChanging(false)
    }
  }

  return (
    <MuteListContext.Provider
      value={{
        mutePubkeySet,
        changing,
        getMutePubkeys,
        getMuteType,
        mutePublicly,
        mutePrivately,
        unmute
      }}
    >
      {children}
    </MuteListContext.Provider>
  )
}
