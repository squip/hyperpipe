import { APP_DISPLAY_NAME, BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import { compareEvents } from '@/lib/event'
import { notificationFilter } from '@/lib/notification'
import { usePrimaryPage } from '@/PageManager'
import client from '@/services/client.service'
import storage from '@/services/local-storage.service'
import { NostrEvent } from '@nostr/tools/wasm'
import * as kinds from '@nostr/tools/kinds'
import { SubCloser } from '@nostr/tools/abstract-pool'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useContentPolicy } from './ContentPolicyProvider'
import { useGroups } from './GroupsProvider'
import { useMessenger } from './MessengerProvider'
import { useMuteList } from './MuteListProvider'
import { useNostr } from './NostrProvider'
import { useUserTrust } from './UserTrustProvider'
import { pool } from '@nostr/gadgets/global'

type TNotificationContext = {
  hasNewNotification: boolean
  newNotificationCount: number
  newInviteNotificationCount: number
  getNotificationsSeenAt: () => number
  isNotificationRead: (id: string) => boolean
  markNotificationAsRead: (id: string) => void
}

const NotificationContext = createContext<TNotificationContext | undefined>(undefined)

export const useNotification = () => {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotification must be used within a NotificationProvider')
  }
  return context
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { current } = usePrimaryPage()
  const active = useMemo(() => current === 'notifications', [current])
  const { pubkey, notificationsSeenAt, updateNotificationsSeenAt } = useNostr()
  const { invites } = useGroups()
  const { invites: conversationInvites } = useMessenger()
  const { hideUntrustedNotifications, isUserTrusted } = useUserTrust()
  const { mutePubkeySet } = useMuteList()
  const { hideContentMentioningMutedUsers } = useContentPolicy()
  const [newNotifications, setNewNotifications] = useState<NostrEvent[]>([])
  const [readNotificationIdSet, setReadNotificationIdSet] = useState<Set<string>>(new Set())
  const filteredNewNotifications = useMemo(() => {
    if (active || notificationsSeenAt < 0) {
      return []
    }
    const filtered: NostrEvent[] = []
    for (const notification of newNotifications) {
      if (notification.created_at <= notificationsSeenAt || filtered.length >= 10) {
        break
      }
      if (
        !notificationFilter(notification, {
          pubkey,
          mutePubkeySet,
          hideContentMentioningMutedUsers,
          hideUntrustedNotifications,
          isUserTrusted
        })
      ) {
        continue
      }
      filtered.push(notification)
    }
    return filtered
  }, [
    newNotifications,
    notificationsSeenAt,
    mutePubkeySet,
    hideContentMentioningMutedUsers,
    hideUntrustedNotifications,
    isUserTrusted,
    active
  ])

  const newInviteNotificationCount = useMemo(() => {
    if (active || notificationsSeenAt < 0) return 0
    const seenInviteEventIds = new Set<string>()
    let count = 0
    for (const invite of invites) {
      const inviteEventId = invite.event?.id
      if (!inviteEventId || seenInviteEventIds.has(inviteEventId)) continue
      seenInviteEventIds.add(inviteEventId)
      if (invite.event.created_at > notificationsSeenAt) {
        count += 1
      }
    }
    const seenConversationInviteIds = new Set<string>()
    for (const invite of conversationInvites) {
      const inviteId = invite.id
      if (!inviteId || seenConversationInviteIds.has(inviteId)) continue
      seenConversationInviteIds.add(inviteId)
      const createdAt = Number.isFinite(invite.createdAt) ? Number(invite.createdAt) : 0
      const receivedAt = Number.isFinite(invite.receivedAt) ? Number(invite.receivedAt) : 0
      const effectiveTimestamp = Math.max(createdAt, receivedAt)
      if (effectiveTimestamp > notificationsSeenAt) {
        count += 1
      }
    }
    return count
  }, [active, invites, conversationInvites, notificationsSeenAt])

  const newNotificationCount = filteredNewNotifications.length + newInviteNotificationCount

  useEffect(() => {
    setNewNotifications([])
    updateNotificationsSeenAt(!active)
  }, [active])

  useEffect(() => {
    if (!pubkey) return

    setNewNotifications([])
    setReadNotificationIdSet(new Set())

    // Track if component is mounted
    const isMountedRef = { current: true }
    const subCloserRef: {
      current: SubCloser | null
    } = { current: null }

    const subscribe = async () => {
      if (subCloserRef.current) {
        subCloserRef.current.close()
        subCloserRef.current = null
      }
      if (!isMountedRef.current) return null

      try {
        let eosed = false
        const relayList = await client.fetchRelayList(pubkey)
        const subCloser = pool.subscribe(
          relayList.read.length > 0 ? relayList.read.slice(0, 5) : BIG_RELAY_URLS,
          {
            kinds: [
              kinds.ShortTextNote,
              kinds.Repost,
              kinds.Reaction,
              kinds.Zap,
              ExtendedKind.COMMENT,
              ExtendedKind.POLL_RESPONSE,
              ExtendedKind.VOICE_COMMENT,
              ExtendedKind.POLL
            ],
            '#p': [pubkey],
            limit: 20
          },
          {
            label: 'f-notifications',
            oneose: () => {
              eosed = true
              setNewNotifications((prev) => {
                return [...prev.sort((a, b) => compareEvents(b, a))]
              })
            },
            onevent: (evt) => {
              if (evt.pubkey !== pubkey) {
                setNewNotifications((prev) => {
                  if (!eosed) {
                    return [evt, ...prev]
                  }
                  if (prev.length && compareEvents(prev[0], evt) >= 0) {
                    return prev
                  }

                  client.emitNewEvent(evt)
                  return [evt, ...prev]
                })
              }
            },
            onclose: (reasons) => {
              if (reasons.every((reason) => reason === 'closed by caller')) {
                return
              }

              // Only reconnect if still mounted and not a manual close
              if (isMountedRef.current) {
                setTimeout(() => {
                  if (isMountedRef.current) {
                    subscribe()
                  }
                }, 5_000)
              }
            }
          }
        )

        subCloserRef.current = subCloser
        return subCloser
      } catch (error) {
        console.error('Subscription error:', error)

        // Retry on error if still mounted
        if (isMountedRef.current) {
          setTimeout(() => {
            if (isMountedRef.current) {
              subscribe()
            }
          }, 5_000)
        }
        return null
      }
    }

    // Initial subscription
    subscribe()

    // Cleanup function
    return () => {
      isMountedRef.current = false
      if (subCloserRef.current) {
        subCloserRef.current.close()
        subCloserRef.current = null
      }
    }
  }, [pubkey])

  useEffect(() => {
    // Update title
    if (newNotificationCount > 0) {
      document.title = `(${newNotificationCount >= 10 ? '9+' : newNotificationCount}) ${APP_DISPLAY_NAME}`
    } else {
      document.title = APP_DISPLAY_NAME
    }

    // Update favicons
    const favicons = document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']")
    if (!favicons.length) return

    if (newNotificationCount === 0) {
      favicons.forEach((favicon) => {
        favicon.href = '/favicon.ico'
      })
    } else {
      const img = document.createElement('img')
      img.src = '/favicon.ico'
      img.onload = () => {
        const size = Math.max(img.width, img.height, 32)
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, size, size)
        const r = size * 0.16
        ctx.beginPath()
        ctx.arc(size - r - 3, r + 25, r, 0, 2 * Math.PI)
        ctx.fillStyle = '#FF0000'
        ctx.fill()
        favicons.forEach((favicon) => {
          favicon.href = canvas.toDataURL('image/png')
        })
      }
    }
  }, [newNotificationCount])

  const getNotificationsSeenAt = () => {
    if (notificationsSeenAt >= 0) {
      return notificationsSeenAt
    }
    if (pubkey) {
      return storage.getLastReadNotificationTime(pubkey)
    }
    return 0
  }

  const isNotificationRead = (notificationId: string): boolean => {
    return readNotificationIdSet.has(notificationId)
  }

  const markNotificationAsRead = (notificationId: string): void => {
    setReadNotificationIdSet((prev) => new Set([...prev, notificationId]))
  }

  return (
    <NotificationContext.Provider
      value={{
        hasNewNotification: newNotificationCount > 0,
        newNotificationCount,
        newInviteNotificationCount,
        getNotificationsSeenAt,
        isNotificationRead,
        markNotificationAsRead
      }}
    >
      {children}
    </NotificationContext.Provider>
  )
}
