import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import mediaUploadService, { type MediaUploadResult } from '@/services/media-upload.service'
import * as nip19 from '@jsr/nostr__tools/nip19'
import { Button } from '@/components/ui/button'
import { useMessenger } from '@/providers/MessengerProvider'
import type { MessageAttachment, ThreadMessage } from '@/lib/conversations/types'
import { CONVERSATION_JUMP_FAB_THRESHOLD } from '@/lib/conversations/types'
import { cn } from '@/lib/utils'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import EmojiPicker from '@/components/EmojiPicker'
import Content from '@/components/Content'
import { useFetchProfile } from '@/hooks'
import {
  Image as ImageIcon,
  Smile,
  Send,
  ChevronDown,
  Heart,
  MessageCircle,
  X,
  Plus,
  Paperclip
} from 'lucide-react'
import PostTextarea, { TPostTextareaHandle } from '@/components/PostEditor/PostTextarea'

const debug = (...args: any[]) => console.debug('[ChatThread]', ...args)

const HYPERDRIVE_UPLOAD_RELAY_URL = 'http://127.0.0.1:8443'

function shortNpub(pubkey: string) {
  try {
    const npub = nip19.npubEncode(pubkey)
    return `${npub.slice(0, 6)}…${npub.slice(-4)}`
  } catch {
    return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`
  }
}

function formatName(pubkey: string, myPubkey: string | null) {
  if (pubkey === myPubkey) return 'You'
  return shortNpub(pubkey)
}

type ReactionStat = { emoji: string; count: number; self: boolean }

function mergeMessagesById(existing: ThreadMessage[], incoming: ThreadMessage | ThreadMessage[]) {
  const list = Array.isArray(incoming) ? incoming : [incoming]
  const map = new Map<string, ThreadMessage>()
  existing.forEach((message) => map.set(message.id, message))
  list.forEach((message) => map.set(message.id, message))
  return Array.from(map.values()).sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
    return left.id.localeCompare(right.id)
  })
}

function toAttachmentFromUpload(result: MediaUploadResult, ownerPubkey: string | null) {
  return {
    url: result.url,
    gatewayUrl: null,
    mime: result.metadata?.mimeType || null,
    size: Number.isFinite(result.metadata?.size) ? Number(result.metadata?.size) : null,
    width: Number.isFinite(result.metadata?.dim?.width) ? Number(result.metadata?.dim?.width) : null,
    height: Number.isFinite(result.metadata?.dim?.height)
      ? Number(result.metadata?.dim?.height)
      : null,
    fileName: result.metadata?.fileName || null,
    sha256: result.metadata?.sha256 || null,
    driveKey: result.metadata?.driveKey || null,
    ownerPubkey: ownerPubkey || null,
    fileId: result.metadata?.fileId || null
  } satisfies MessageAttachment
}

export function ChatThread({
  conversationId,
  myPubkey,
  useDocumentScroll = false
}: {
  conversationId: string
  myPubkey: string | null
  useDocumentScroll?: boolean
}) {
  const {
    messenger,
    conversations,
    ready,
    initialSyncPending,
    unsupportedReason,
    drainBufferedMessages
  } = useMessenger()
  const { isSmallScreen } = useScreenSize()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null)
  const [reactionSendingId, setReactionSendingId] = useState<string | null>(null)
  const [localMessages, setLocalMessages] = useState<ThreadMessage[]>([])
  const [pickerOpen, setPickerOpen] = useState<string | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [nearBottom, setNearBottom] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [anchored, setAnchored] = useState(false)
  const prevLength = useRef(0)
  const anchorRetry = useRef<number | null>(null)
  const lastReadSentRef = useRef<{ messageId: string; timestamp: number } | null>(null)

  const conversation = useMemo(
    () => conversations.find((item) => item.id === conversationId) || null,
    [conversations, conversationId]
  )

  const markConversationReadIfNeeded = useCallback(
    async (message: ThreadMessage | null | undefined) => {
      if (!messenger || !conversationId || !message) return

      const messageId = String(message.id || '').trim()
      const timestamp = Number(message.timestamp)
      if (!messageId || !Number.isFinite(timestamp) || timestamp <= 0) return

      const lastSent = lastReadSentRef.current
      if (lastSent && lastSent.messageId === messageId && lastSent.timestamp === timestamp) {
        return
      }

      const knownReadMessageId = String(conversation?.lastReadMessageId || '')
      const knownReadAt = Number(conversation?.lastReadAt || 0)
      if (knownReadMessageId === messageId && knownReadAt >= timestamp) {
        lastReadSentRef.current = { messageId, timestamp }
        return
      }
      if (knownReadAt > timestamp) {
        return
      }

      lastReadSentRef.current = { messageId, timestamp }
      try {
        await messenger.markConversationRead(conversationId, messageId, timestamp)
      } catch (error) {
        if (
          lastReadSentRef.current?.messageId === messageId
          && lastReadSentRef.current?.timestamp === timestamp
        ) {
          lastReadSentRef.current = null
        }
        debug('markConversationRead failed', error)
      }
    },
    [messenger, conversationId, conversation?.lastReadMessageId, conversation?.lastReadAt]
  )

  useEffect(() => {
    if (!messenger || !conversationId) return
    lastReadSentRef.current = null
    let cancelled = false
    const load = async () => {
      debug('load thread (init)', { conversationId })
      const thread = await messenger.loadThread(conversationId, { limit: 500, sync: true })
      const buffered = drainBufferedMessages(conversationId)
      const merged = [...thread.messages, ...buffered]
        .reduce<Map<string, ThreadMessage>>((map, message) => map.set(message.id, message), new Map())
      const mergedList = Array.from(merged.values()).sort((left, right) => {
        if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
        return left.id.localeCompare(right.id)
      })
      if (cancelled) return
      setLocalMessages(mergedList)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [messenger, conversationId])

  useEffect(() => {
    if (!messenger || !conversationId) return
    let cancelled = false

    const sync = async (reason: string) => {
      try {
        const thread = await messenger.loadThread(conversationId, { limit: 500, sync: true })
        if (cancelled) return
        setLocalMessages((previous) => {
          const prevLast = previous.at(-1)?.id
          const nextLast = thread.messages.at(-1)?.id
          if (previous.length === thread.messages.length && prevLast === nextLast) return previous
          return thread.messages
        })
      } catch (error) {
        debug(`recovery sync failed (${reason})`, error)
      }
    }

    const handleFocus = () => {
      void sync('focus')
    }
    const handleOnline = () => {
      void sync('online')
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void sync('visible')
      }
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void sync('interval')
      }
    }, 30_000)

    window.addEventListener('focus', handleFocus)
    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [messenger, conversationId])

  useEffect(() => {
    if (!messenger) return
    const off = messenger.on((event) => {
      if (event.type === 'message' && event.message.conversationId === conversationId) {
        setLocalMessages((previous) => mergeMessagesById(previous, event.message))
      }
    })
    return () => {
      off?.()
    }
  }, [messenger, conversationId])

  useEffect(() => {
    if (localMessages.length !== prevLength.current) {
      setAnchored(false)
      prevLength.current = localMessages.length
    }
  }, [localMessages.length])

  const firstUnreadIdx = useMemo(
    () => localMessages.findIndex((message) => message.senderPubkey !== myPubkey && message.timestamp > (conversation?.lastReadAt || 0)),
    [localMessages, myPubkey, conversation?.lastReadAt]
  )

  const unreadCount = useMemo(
    () => localMessages.filter((message) => message.senderPubkey !== myPubkey && message.timestamp > (conversation?.lastReadAt || 0)).length,
    [localMessages, myPubkey, conversation?.lastReadAt]
  )

  type ScrollContext = { el: HTMLElement | null; useDocument: boolean }

  const getScrollContext = (): ScrollContext => {
    if (!useDocumentScroll) {
      return { el: listRef.current, useDocument: false }
    }

    if (typeof document !== 'undefined') {
      return {
        el: (document.scrollingElement as HTMLElement | null) || document.documentElement,
        useDocument: true
      }
    }

    return { el: null, useDocument: false }
  }

  const scrollToMessage = (id: string, smooth = true) => {
    const element = messageRefs.current.get(id)
    const { el: list, useDocument } = getScrollContext()
    if (!element || !list) return false

    const top = useDocument
      ? element.getBoundingClientRect().top + (window.scrollY || document.documentElement.scrollTop) - 24
      : element.offsetTop - 24

    if (useDocument) {
      window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    } else if ((list as any).scrollTo) {
      ;(list as any).scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    } else {
      window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    }
    return true
  }

  const scrollToBottom = (smooth = true) => {
    const { el: list, useDocument } = getScrollContext()
    if (!list) return false

    if (useDocument) {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
      if (list.scrollHeight <= viewportHeight + 4) return false
      const top = list.scrollHeight
      window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    } else {
      if (list.scrollHeight <= list.clientHeight + 4) return false
      const top = list.scrollHeight
      if ((list as any).scrollTo) {
        ;(list as any).scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
        list.scrollTop = list.scrollHeight
      } else {
        window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
      }
    }

    const last = localMessages.at(-1)
    if (last) {
      void markConversationReadIfNeeded(last)
    }
    return true
  }

  const isNearBottom = (
    list?: HTMLElement | null,
    viewportHeight?: number,
    useDocumentFlag = false,
    threshold = 80
  ) => {
    if (!list) return false
    if (useDocumentFlag) {
      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0
      const clientHeight = viewportHeight ?? window.innerHeight
      const distance = list.scrollHeight - scrollTop - clientHeight
      return distance < threshold
    }
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    return distance < threshold
  }

  const isMessageVisible = (id: string) => {
    const element = messageRefs.current.get(id)
    const { el: list, useDocument } = getScrollContext()
    if (!element || !list) return false

    if (useDocument) {
      const rect = element.getBoundingClientRect()
      return rect.bottom <= window.innerHeight && rect.top >= -24
    }

    const top = element.offsetTop
    const bottom = top + element.offsetHeight
    const viewTop = list.scrollTop
    const viewBottom = list.scrollTop + list.clientHeight
    return bottom <= viewBottom && top >= viewTop - 24
  }

  const attemptAnchor = (attempt = 1) => {
    if (anchored) return
    if (!localMessages.length) return

    const targetMessage =
      unreadCount > 0 && firstUnreadIdx >= 0
        ? localMessages[firstUnreadIdx]
        : localMessages.at(-1)

    if (!targetMessage) return

    const { el: anchorContextEl, useDocument: useDocumentContext } = getScrollContext()
    let canScroll = false
    if (anchorContextEl) {
      canScroll = useDocumentContext
        ? anchorContextEl.scrollHeight > ((window.innerHeight || anchorContextEl.clientHeight || 0) + 4)
        : anchorContextEl.scrollHeight > (anchorContextEl.clientHeight + 4)
    }

    if (!canScroll && unreadCount <= CONVERSATION_JUMP_FAB_THRESHOLD) {
      if (unreadCount > 0) {
        const last = localMessages.at(-1)
        if (last) {
          void markConversationReadIfNeeded(last)
        }
      }
      setAnchored(true)
      return
    }

    const scrolled =
      unreadCount > CONVERSATION_JUMP_FAB_THRESHOLD
        ? scrollToMessage(targetMessage.id, false)
        : scrollToBottom(false)

    const verify = () => {
      anchorRetry.current = null
      const { el: list, useDocument } = getScrollContext()
      const targetVisible =
        unreadCount > CONVERSATION_JUMP_FAB_THRESHOLD
          ? isMessageVisible(targetMessage.id)
          : isNearBottom(list, useDocument ? window.innerHeight : undefined, useDocument)

      if (targetVisible) {
        if (scrolled && unreadCount <= CONVERSATION_JUMP_FAB_THRESHOLD && unreadCount > 0) {
          const last = localMessages.at(-1)
          if (last) {
            void markConversationReadIfNeeded(last)
          }
        }
        setAnchored(true)
      } else if (attempt < 5) {
        anchorRetry.current = window.setTimeout(() => attemptAnchor(attempt + 1), 120)
      }
    }

    anchorRetry.current = window.setTimeout(verify, 16)
    verify()
  }

  useLayoutEffect(() => {
    attemptAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMessages, firstUnreadIdx, anchored, unreadCount, messenger, conversationId, conversation?.lastReadAt, useDocumentScroll])

  useEffect(() => {
    if (!anchored) {
      attemptAnchor()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDocumentScroll])

  useEffect(() => {
    return () => {
      if (anchorRetry.current) clearTimeout(anchorRetry.current)
      anchorRetry.current = null
    }
  }, [])

  useEffect(() => {
    const { el, useDocument } = getScrollContext()
    if (!el) return

    const handler = () => {
      const context = getScrollContext()
      const near = isNearBottom(
        context.el,
        context.useDocument ? window.innerHeight : undefined,
        context.useDocument,
        120
      )
      setNearBottom(near)
      setShowScrollBottom(unreadCount > CONVERSATION_JUMP_FAB_THRESHOLD && !near)

      if (near && unreadCount > 0) {
        const last = localMessages.at(-1)
        if (last) {
          void markConversationReadIfNeeded(last)
        }
      }
    }

    handler()

    const primaryTarget = useDocument ? window : el
    primaryTarget?.addEventListener('scroll', handler, { passive: true } as any)
    const secondaryTarget = !useDocument && isSmallScreen ? window : null
    secondaryTarget?.addEventListener('scroll', handler, { passive: true } as any)

    return () => {
      primaryTarget?.removeEventListener('scroll', handler)
      secondaryTarget?.removeEventListener('scroll', handler)
    }
  }, [unreadCount, localMessages, isSmallScreen, markConversationReadIfNeeded])

  useEffect(() => {
    if (!localMessages.length) return
    const { el: scrollEl, useDocument } = getScrollContext()
    const wasNearBottom = isNearBottom(scrollEl, useDocument ? window.innerHeight : undefined, useDocument)
    if (anchored || wasNearBottom) {
      scrollToBottom(false)
    }
  }, [localMessages.length])

  const handleSend = async () => {
    if (!messenger || !conversation) return
    const hasText = Boolean(draft.trim())
    const hasAttachments = pendingAttachments.length > 0
    if (!hasText && !hasAttachments) return

    setSending(true)
    try {
      let sentMessages: ThreadMessage[] = []
      if (hasAttachments) {
        sentMessages = await messenger.sendMediaMessage(conversation.id, draft.trim(), pendingAttachments, {
          replyTo: replyTarget?.id
        })
      } else {
        sentMessages = await messenger.sendMessage(conversation.id, draft.trim(), {
          replyTo: replyTarget?.id
        })
      }

      setLocalMessages((previous) => mergeMessagesById(previous, sentMessages))
      setDraft('')
      setReplyTarget(null)
      setPendingAttachments([])

      const last = sentMessages.at(-1)
      if (last) {
        await markConversationReadIfNeeded(last)
      }

      scrollToBottom()
    } catch (error) {
      console.error('Failed to send conversation message', error)
    } finally {
      setSending(false)
    }
  }

  const handleMediaUpload = async (file: File) => {
    if (!conversationId) return

    setUploading(true)
    setUploadProgress(0)

    try {
      const result = await mediaUploadService.upload(
        file,
        {
          onProgress: (progress) => setUploadProgress(progress)
        },
        {
          target: 'group-hyperdrive',
          groupId: conversationId,
          relayUrl: HYPERDRIVE_UPLOAD_RELAY_URL,
          resourceScope: 'conversation',
          parentKind: 14
        }
      )

      setPendingAttachments((previous) => [...previous, toAttachmentFromUpload(result, myPubkey)])
    } catch (error) {
      console.error('Media upload failed', error)
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  const handleReact = async (message: ThreadMessage, emoji = '👍') => {
    if (!messenger || !conversation) return

    setReactionSendingId(message.id)
    try {
      const reactions = await messenger.sendMessage(conversation.id, emoji, {
        type: 'reaction',
        replyTo: message.id
      })
      setLocalMessages((previous) => mergeMessagesById(previous, reactions))
    } catch (error) {
      console.error('Failed to send reaction', error)
    } finally {
      setReactionSendingId(null)
      setPickerOpen(null)
    }
  }

  if (unsupportedReason && !conversation) {
    return <div className="p-4 text-sm text-muted-foreground">{unsupportedReason}</div>
  }

  if (!ready || !messenger || (!conversation && initialSyncPending)) {
    return <div className="p-4 text-sm text-muted-foreground">Loading chat…</div>
  }

  if (!conversation) {
    return <div className="p-4 text-sm text-muted-foreground">Chat not found.</div>
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col gap-3 overflow-hidden',
        useDocumentScroll ? '' : 'h-full'
      )}
    >
      <div
        ref={listRef}
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-3 px-3 py-2 scrollbar-chat"
      >
        {localMessages.map((message, index) => (
          <React.Fragment key={message.id}>
            {firstUnreadIdx === index && unreadCount > 0 && (
              <UnreadDivider onClick={() => scrollToBottom()} disabled={nearBottom} />
            )}
            <MessageBubble
              messageRef={(element) => {
                if (!element) return
                const existing = messageRefs.current.get(message.id)
                if (existing === element) return
                messageRefs.current.set(message.id, element)
              }}
              message={message}
              myPubkey={myPubkey}
              onReply={() => setReplyTarget(message)}
              replyTarget={replyTarget}
              onReact={(emoji) => handleReact(message, emoji)}
              reactionSendingId={reactionSendingId}
              reactions={collectReactions(localMessages, message.id, myPubkey)}
              pickerOpen={pickerOpen === message.id}
              setPickerOpen={(open) => setPickerOpen(open ? message.id : null)}
              resolveReply={async () => {
                const thread = await messenger.loadThread(conversationId, { limit: 500, sync: true })
                setLocalMessages(thread.messages)
              }}
              allMessages={localMessages}
            />
          </React.Fragment>
        ))}

        {localMessages.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-6">No messages yet.</div>
        )}

        {showScrollBottom && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full shadow"
              onClick={() => scrollToBottom()}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <ChatComposer
        isSmallScreen={isSmallScreen}
        draft={draft}
        setDraft={setDraft}
        onSend={handleSend}
        sending={sending}
        replyTarget={replyTarget}
        myPubkey={myPubkey}
        clearReply={() => setReplyTarget(null)}
        onAddMedia={handleMediaUpload}
        uploading={uploading}
        uploadProgress={uploadProgress}
        pendingAttachments={pendingAttachments}
        clearAttachment={(index) => {
          setPendingAttachments((previous) => previous.filter((_, attachmentIndex) => attachmentIndex !== index))
        }}
      />
    </div>
  )
}

function collectReactions(messages: ThreadMessage[], targetId: string, myPubkey: string | null) {
  const stats = new Map<string, { count: number; self: boolean }>()

  messages
    .filter((message) => message.type === 'reaction' && message.replyTo === targetId)
    .forEach((message) => {
      const key = message.content || '+'
      const previous = stats.get(key) || { count: 0, self: false }
      stats.set(key, {
        count: previous.count + 1,
        self: previous.self || message.senderPubkey === myPubkey
      })
    })

  return Array.from(stats.entries()).map(([emoji, value]) => ({ emoji, ...value }))
}

function MessageBubble({
  message,
  myPubkey,
  onReply,
  replyTarget,
  onReact,
  reactions,
  reactionSendingId,
  pickerOpen,
  setPickerOpen,
  messageRef,
  resolveReply,
  allMessages
}: {
  message: ThreadMessage
  myPubkey: string | null
  onReply: () => void
  replyTarget: ThreadMessage | null
  onReact: (emoji: string) => void
  reactions: ReactionStat[]
  reactionSendingId: string | null
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  messageRef: (el: HTMLDivElement | null) => void
  resolveReply: (id: string) => void
  allMessages: ThreadMessage[]
}) {
  const mine = message.senderPubkey === myPubkey
  const bubbleClasses = mine
    ? 'bg-primary/10 border-primary/30 ml-auto'
    : 'bg-muted/60 border-muted-foreground/20 mr-auto'

  const { profile } = useFetchProfile(message.senderPubkey)

  const replyMessage = useMemo(() => {
    if (!message.replyTo) return null
    return allMessages.find((item) => item.id === message.replyTo) || null
  }, [allMessages, message.replyTo])

  const { profile: replyProfile } = useFetchProfile(replyMessage?.senderPubkey || '')

  const attemptedResolve = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (message.replyTo && !replyMessage && !attemptedResolve.current.has(message.replyTo)) {
      attemptedResolve.current.add(message.replyTo)
      resolveReply(message.replyTo)
    }
  }, [message.replyTo, replyMessage, resolveReply])

  const displayName = (pubkey: string, profileData?: any) => {
    if (pubkey === myPubkey) return 'You'
    if (profileData?.shortName) return profileData.shortName
    return shortNpub(pubkey)
  }

  const renderAttachment = (attachment: MessageAttachment, index: number) => {
    const url = attachment.url || attachment.gatewayUrl
    if (!url) return null

    const mime = attachment.mime || ''
    if (mime.startsWith('image/')) {
      return (
        <img
          key={`${message.id}:attachment:${index}`}
          src={url}
          alt={attachment.fileName || 'attachment'}
          className="max-h-72 rounded-lg border object-cover"
        />
      )
    }

    if (mime.startsWith('video/')) {
      return (
        <video
          key={`${message.id}:attachment:${index}`}
          src={url}
          controls
          className="max-h-72 rounded-lg border"
        />
      )
    }

    return (
      <a
        key={`${message.id}:attachment:${index}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-muted/60"
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span>{attachment.fileName || attachment.url}</span>
      </a>
    )
  }

  return (
    <div className={cn('flex w-full gap-2', mine ? 'justify-end' : 'justify-start')} ref={messageRef}>
      {!mine && <SimpleUserAvatar userId={message.senderPubkey} size="small" />}
      <div className={cn('max-w-[80%] space-y-2')}>
        <div className={cn('rounded-2xl border px-3 py-2 shadow-sm', bubbleClasses, 'flex flex-col gap-2')}>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{displayName(message.senderPubkey, profile)}</span>
            <span>{new Date(message.timestamp * 1000).toLocaleString()}</span>
          </div>

          {message.replyTo && (
            <div className="text-[11px] text-muted-foreground border-l pl-2">
              {replyMessage ? (
                <>
                  <div className="font-semibold text-foreground/80 text-xs">
                    {displayName(replyMessage.senderPubkey, replyProfile)}
                  </div>
                  <div className="text-sm line-clamp-2">
                    <Content content={replyMessage.content || 'Encrypted message'} />
                  </div>
                </>
              ) : (
                <div className="text-xs">Referenced message not loaded</div>
              )}
            </div>
          )}

          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-col gap-2">
              {message.attachments.map((attachment, index) => renderAttachment(attachment, index))}
            </div>
          )}

          {message.content && (
            <div className="text-sm whitespace-pre-wrap space-y-2">
              <Content content={message.content || ''} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            className={cn(
              'flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors',
              replyTarget?.id === message.id && 'text-primary font-medium'
            )}
            onClick={() => onReply()}
          >
            <MessageCircle className="h-4 w-4" />
            Reply
          </button>

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                disabled={reactionSendingId === message.id}
              >
                <Heart className="h-4 w-4" />
                React
              </button>
            </PopoverTrigger>
            <PopoverContent className="p-0" align="start">
              <EmojiPicker
                onEmojiClick={(emoji) => {
                  if (emoji) onReact(typeof emoji === 'string' ? emoji : (emoji as any).native || '+')
                }}
              />
            </PopoverContent>
          </Popover>

          <div className="flex gap-1 flex-wrap">
            {reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-full border text-xs',
                  reaction.self
                    ? 'border-primary text-primary bg-primary/10'
                    : 'text-muted-foreground'
                )}
                onClick={() => onReact(reaction.emoji)}
              >
                <span>{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {mine && <SimpleUserAvatar userId={message.senderPubkey} size="small" />}
    </div>
  )
}

function ChatComposer({
  isSmallScreen,
  draft,
  setDraft,
  onSend,
  sending,
  replyTarget,
  myPubkey,
  clearReply,
  onAddMedia,
  uploading,
  uploadProgress,
  pendingAttachments,
  clearAttachment
}: {
  isSmallScreen: boolean
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  onSend: () => void
  sending: boolean
  replyTarget: ThreadMessage | null
  myPubkey: string | null
  clearReply: () => void
  onAddMedia: (file: File) => void
  uploading: boolean
  uploadProgress: number | null
  pendingAttachments: MessageAttachment[]
  clearAttachment: (index: number) => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<TPostTextareaHandle | null>(null)
  const mobileComposerOffset = 'calc(env(safe-area-inset-bottom) + 3rem)'

  const handleMediaClick = () => {
    if (!fileInputRef.current) {
      fileInputRef.current = document.createElement('input')
      fileInputRef.current.type = 'file'
      fileInputRef.current.onchange = (event: any) => {
        const file = event.target.files?.[0]
        if (file) {
          onAddMedia(file)
        }
      }
    }
    fileInputRef.current.click()
  }

  const handleAddEmoji = (emoji: string) => {
    if (editorRef.current) {
      editorRef.current.insertEmoji(emoji)
    } else {
      setDraft((current) => `${current}${emoji}`)
    }
  }

  const emojiButton = (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" title="Emoji">
          <Smile className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start">
        <EmojiPicker
          onEmojiClick={(emoji) => {
            if (emoji) handleAddEmoji(typeof emoji === 'string' ? emoji : (emoji as any).native || '+')
          }}
        />
      </PopoverContent>
    </Popover>
  )

  const renderPendingAttachments = (
    <div className="flex flex-wrap gap-2 px-1">
      {pendingAttachments.map((attachment, index) => (
        <div
          key={`${attachment.url}:${index}`}
          className="inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs"
        >
          <Paperclip className="h-3.5 w-3.5" />
          <span className="max-w-[10rem] truncate">
            {attachment.fileName || attachment.url.split('/').pop() || 'attachment'}
          </span>
          <button onClick={() => clearAttachment(index)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )

  if (isSmallScreen) {
    return (
      <div
        className="sticky left-0 right-0 bg-background px-3 py-2 border-t space-y-2 z-40"
        style={{ bottom: mobileComposerOffset }}
      >
        {replyTarget && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-2">
            <span>
              Replying to {formatName(replyTarget.senderPubkey, myPubkey)}:{' '}
              {replyTarget.content || 'Encrypted message'}
            </span>
            <Button variant="ghost" size="sm" onClick={clearReply}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {pendingAttachments.length > 0 && renderPendingAttachments}

        <div className="flex items-end gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full">
                <Plus className="h-5 w-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="flex flex-col p-2 space-y-1 w-44">
              <Button variant="ghost" className="justify-start" onClick={handleMediaClick}>
                Media
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" className="justify-start">
                    Emoji
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0" align="start">
                  <EmojiPicker
                    onEmojiClick={(emoji) => {
                      if (emoji) {
                        handleAddEmoji(typeof emoji === 'string' ? emoji : (emoji as any).native || '+')
                      }
                    }}
                  />
                </PopoverContent>
              </Popover>
            </PopoverContent>
          </Popover>

          <div className="flex-1">
            <PostTextarea
              ref={editorRef}
              text={draft}
              setText={setDraft}
              onSubmit={onSend}
              className="min-h-[40px] rounded-2xl"
              submitOnEnter={!isSmallScreen}
              hidePreviewToggle
            />
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={sending || (!draft.trim() && pendingAttachments.length === 0)}
            onClick={onSend}
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t bg-background px-3 py-3 space-y-2">
      {replyTarget && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-2">
          <span>
            Replying to {formatName(replyTarget.senderPubkey, myPubkey)}:{' '}
            {replyTarget.content || 'Encrypted message'}
          </span>
          <Button variant="ghost" size="sm" onClick={clearReply}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="rounded-lg border bg-muted/30 p-3 space-y-2 shadow-sm">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Button variant="ghost" size="icon" className="rounded-full" title="Media" onClick={handleMediaClick}>
            <ImageIcon className="h-4 w-4" />
          </Button>
          {emojiButton}
        </div>

        {pendingAttachments.length > 0 && renderPendingAttachments}

        {uploading && (
          <div className="text-xs text-muted-foreground flex items-center gap-2 px-1">
            <span>Uploading…</span>
            {uploadProgress !== null && <span>{Math.round(uploadProgress)}%</span>}
          </div>
        )}

        <PostTextarea
          ref={editorRef}
          text={draft}
          setText={setDraft}
          onSubmit={onSend}
          className="min-h-[80px]"
          submitOnEnter={!isSmallScreen}
          hidePreviewToggle
        />

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setDraft('')
            }}
          >
            Cancel
          </Button>
          <Button onClick={onSend} disabled={sending || (!draft.trim() && pendingAttachments.length === 0)}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function UnreadDivider({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-center py-1">
      {disabled ? (
        <div className="text-xs text-muted-foreground px-3 py-1 rounded-full border bg-muted/40">
          Unread messages
        </div>
      ) : (
        <Button variant="secondary" size="sm" className="rounded-full" onClick={onClick}>
          <ChevronDown className="h-4 w-4" />
          <span className="ml-1">Jump to latest</span>
        </Button>
      )}
    </div>
  )
}
