import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import { dedupeRelayUrlsByIdentity } from '@/lib/relay-targets'
import client from '@/services/client.service'
import { TDraftEvent } from '@/types'
import { Event } from '@jsr/nostr__tools/wasm'
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react'
import { useNostr } from './NostrProvider'
import * as kinds from '@jsr/nostr__tools/kinds'

export type TStarterPack = {
  id: string // d tag value
  title: string
  description?: string
  image?: string
  pubkeys: string[]
  relayUrls?: string[]
  event: Event
}

type TListsContext = {
  lists: TStarterPack[]
  isLoading: boolean
  createList: (
    title: string,
    description?: string,
    image?: string,
    pubkeys?: string[],
    relayUrls?: string[]
  ) => Promise<Event>
  updateList: (
    id: string,
    title: string,
    pubkeys: string[],
    description?: string,
    image?: string,
    relayUrls?: string[]
  ) => Promise<Event>
  deleteList: (id: string) => Promise<void>
  addToList: (id: string, pubkey: string) => Promise<Event>
  removeFromList: (id: string, pubkey: string) => Promise<Event>
  fetchLists: (extraRelayUrls?: string[]) => Promise<void>
}

const ListsContext = createContext<TListsContext | undefined>(undefined)

function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export const useLists = () => {
  const context = useContext(ListsContext)
  if (!context) {
    throw new Error('useLists must be used within a ListsProvider')
  }
  return context
}

export function ListsProvider({ children }: { children: ReactNode }) {
  const { pubkey: accountPubkey, publish } = useNostr()
  const [lists, setLists] = useState<TStarterPack[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const knownExtraRelayUrlsRef = useRef<string[]>([])

  const parseStarterPackEvent = useCallback((event: Event): TStarterPack | null => {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] || ''
    if (!dTag) return null
    const title = event.tags.find((tag) => tag[0] === 'title')?.[1] || 'Untitled List'
    const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
    const image = event.tags.find((tag) => tag[0] === 'image')?.[1]
    const pubkeys = event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1])
    const relayUrls = client.getSeenEventRelayUrls(event.id, event)

    return {
      id: dTag,
      title,
      description,
      image,
      pubkeys,
      relayUrls,
      event
    }
  }, [])

  const dedupeAndSortLists = useCallback((starterPacks: TStarterPack[]): TStarterPack[] => {
    const latestByKey = new Map<string, TStarterPack>()

    starterPacks.forEach((list) => {
      const key = `${list.event.pubkey}:${list.id}`
      const current = latestByKey.get(key)
      if (!current || current.event.created_at < list.event.created_at) {
        latestByKey.set(key, list)
      }
    })

    return Array.from(latestByKey.values()).sort((a, b) => b.event.created_at - a.event.created_at)
  }, [])

  const upsertListFromEvent = useCallback((event: Event, relayUrls?: string[]) => {
    const parsed = parseStarterPackEvent(event)
    if (!parsed) return
    const next = relayUrls?.length
      ? {
          ...parsed,
          relayUrls
        }
      : parsed
    setLists((prev) => dedupeAndSortLists([next, ...prev]))
  }, [dedupeAndSortLists, parseStarterPackEvent])

  const fetchLists = useCallback(async (extraRelayUrls: string[] = []) => {
    if (!accountPubkey) return

    setIsLoading(true)
    try {
      const mergedExtraRelayUrls = dedupeRelayUrlsByIdentity([
        ...knownExtraRelayUrlsRef.current,
        ...extraRelayUrls
      ])
      if (!areStringArraysEqual(knownExtraRelayUrlsRef.current, mergedExtraRelayUrls)) {
        knownExtraRelayUrlsRef.current = mergedExtraRelayUrls
      }

      const events = await client.fetchStarterPackEvents(accountPubkey, mergedExtraRelayUrls)
      const parsedLists = events
        .map(parseStarterPackEvent)
        .filter((list): list is TStarterPack => !!list)
      setLists((previous) => dedupeAndSortLists([...parsedLists, ...previous]))
    } catch (error) {
      console.error('Failed to fetch lists:', error)
    } finally {
      setIsLoading(false)
    }
  }, [accountPubkey, dedupeAndSortLists, parseStarterPackEvent])

  useEffect(() => {
    knownExtraRelayUrlsRef.current = []
  }, [accountPubkey])

  useEffect(() => {
    fetchLists()
  }, [fetchLists])

  const createList = useCallback(async (
    title: string,
    description?: string,
    image?: string,
    pubkeys: string[] = [],
    relayUrls: string[] = []
  ): Promise<Event> => {
    if (!accountPubkey) throw new Error('Not logged in')

    const dTag = `list-${Date.now()}`
    const tags: string[][] = [
      ['d', dTag],
      ['title', title],
      ...pubkeys.map((pubkey) => ['p', pubkey])
    ]

    if (description) {
      tags.push(['description', description])
    }

    if (image) {
      tags.push(['image', image])
    }

    const draftEvent: TDraftEvent = {
      kind: ExtendedKind.STARTER_PACK,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }

    const event = await publish(
      draftEvent,
      relayUrls.length ? { specifiedRelayUrls: relayUrls } : { additionalRelayUrls: BIG_RELAY_URLS }
    )
    upsertListFromEvent(event, relayUrls)
    return event
  }, [accountPubkey, publish, upsertListFromEvent])

  const updateList = useCallback(async (
    id: string,
    title: string,
    pubkeys: string[],
    description?: string,
    image?: string,
    relayUrls: string[] = []
  ): Promise<Event> => {
    if (!accountPubkey) throw new Error('Not logged in')

    const tags: string[][] = [
      ['d', id],
      ['title', title],
      ...pubkeys.map((pubkey) => ['p', pubkey])
    ]

    if (description) {
      tags.push(['description', description])
    }

    if (image) {
      tags.push(['image', image])
    }

    const draftEvent: TDraftEvent = {
      kind: ExtendedKind.STARTER_PACK,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }

    const event = await publish(
      draftEvent,
      relayUrls.length ? { specifiedRelayUrls: relayUrls } : { additionalRelayUrls: BIG_RELAY_URLS }
    )
    upsertListFromEvent(event, relayUrls)
    return event
  }, [accountPubkey, publish, upsertListFromEvent])

  const deleteList = useCallback(async (id: string): Promise<void> => {
    if (!accountPubkey) throw new Error('Not logged in')

    const list = lists.find((l) => l.id === id)
    if (!list) throw new Error('List not found')

    const draftEvent: TDraftEvent = {
      kind: kinds.EventDeletion,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['a', `${ExtendedKind.STARTER_PACK}:${accountPubkey}:${id}`]],
      content: ''
    }

    await publish(draftEvent, {
      additionalRelayUrls: BIG_RELAY_URLS
    })
    setLists((prev) => prev.filter((l) => l.id !== id))
  }, [accountPubkey, lists, publish])

  const addToList = useCallback(async (id: string, pubkey: string): Promise<Event> => {
    const list = lists.find((l) => l.id === id)
    if (!list) throw new Error('List not found')

    if (list.pubkeys.includes(pubkey)) {
      return list.event
    }

    return updateList(id, list.title, [...list.pubkeys, pubkey], list.description, list.image)
  }, [lists, updateList])

  const removeFromList = useCallback(async (id: string, pubkey: string): Promise<Event> => {
    const list = lists.find((l) => l.id === id)
    if (!list) throw new Error('List not found')

    const newPubkeys = list.pubkeys.filter((p) => p !== pubkey)

    return updateList(id, list.title, newPubkeys, list.description, list.image)
  }, [lists, updateList])

  const contextValue = useMemo(
    () => ({
      lists,
      isLoading,
      createList,
      updateList,
      deleteList,
      addToList,
      removeFromList,
      fetchLists
    }),
    [lists, isLoading, createList, updateList, deleteList, addToList, removeFromList, fetchLists]
  )

  return (
    <ListsContext.Provider value={contextValue}>
      {children}
    </ListsContext.Provider>
  )
}
