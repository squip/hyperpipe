import { useMemo } from 'react'
import { useMessenger } from '@/providers/MessengerProvider'
import type { ConversationSummary } from '@/lib/conversations/types'
import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import { Users } from 'lucide-react'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import { useFetchProfile } from '@/hooks'

function deriveDisplayName(meta: ConversationSummary, myPubkey: string | null): string {
  if (meta.title) return meta.title
  const others = meta.participants.filter((participant) => participant !== myPubkey)
  if (others.length === 0) return 'Me'
  if (others.length === 1) return others[0]
  return `${others[0]} +${others.length - 1}`
}

function shortPubkey(pubkey: string): string {
  const normalized = String(pubkey || '').trim()
  if (!normalized) return ''
  return `${normalized.slice(0, 8)}…${normalized.slice(-6)}`
}

export function ChatListPanel({
  myPubkey,
  onOpenConversation,
  conversations: providedConversations
}: {
  myPubkey: string | null
  onOpenConversation: (id: string) => void
  conversations?: ConversationSummary[]
}) {
  const { conversations, ready, unsupportedReason } = useMessenger()

  const rows = providedConversations || conversations

  const sorted = useMemo(
    () => [...rows].sort((left, right) => (right.lastMessageAt || 0) - (left.lastMessageAt || 0)),
    [rows]
  )

  if (unsupportedReason) {
    return <div className="p-4 text-sm text-muted-foreground">{unsupportedReason}</div>
  }

  if (!ready) {
    return <div className="p-4 text-sm text-muted-foreground">Loading chats…</div>
  }

  if (!sorted.length) {
    return <div className="p-4 text-sm text-muted-foreground">No chats yet.</div>
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      {sorted.map((meta) => (
        <ConversationListItem
          key={meta.id}
          meta={meta}
          myPubkey={myPubkey}
          onOpenConversation={onOpenConversation}
        />
      ))}
    </div>
  )
}

function ConversationListItem({
  meta,
  myPubkey,
  onOpenConversation
}: {
  meta: ConversationSummary
  myPubkey: string | null
  onOpenConversation: (id: string) => void
}) {
  const others = useMemo(
    () => meta.participants.filter((participant) => participant !== myPubkey),
    [meta.participants, myPubkey]
  )

  const title = deriveDisplayName(meta, myPubkey)
  const compactMemberCount = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: 'compact' }),
    []
  )
  const facepileMembers = useMemo(
    () => meta.participants.slice(0, 3),
    [meta.participants]
  )
  const normalizedSenderPubkey = useMemo(
    () => String(meta.lastMessageSenderPubkey || '').trim().toLowerCase(),
    [meta.lastMessageSenderPubkey]
  )
  const normalizedMyPubkey = useMemo(
    () => String(myPubkey || '').trim().toLowerCase(),
    [myPubkey]
  )
  const { profile: senderProfile } = useFetchProfile(normalizedSenderPubkey || undefined)
  const messagePreview = meta.lastMessagePreview || 'No messages yet.'
  const senderLabel = useMemo(() => {
    if (!normalizedSenderPubkey || !meta.lastMessagePreview) return null
    if (normalizedSenderPubkey === normalizedMyPubkey) return 'You'
    return (
      senderProfile?.shortName
      || senderProfile?.metadata?.display_name
      || senderProfile?.metadata?.name
      || shortPubkey(normalizedSenderPubkey)
    )
  }, [meta.lastMessagePreview, normalizedMyPubkey, normalizedSenderPubkey, senderProfile])
  const messagePreviewLabel = senderLabel ? `${senderLabel}: ${messagePreview}` : messagePreview

  return (
    <div
      className="clickable flex items-center gap-3 cursor-pointer px-4 py-3 border-b"
      onClick={() => onOpenConversation(meta.id)}
    >
      <div className="flex items-center justify-center mt-1.5">
        {meta.imageUrl ? (
          <img
            src={meta.imageUrl}
            alt="Chat"
            className="w-9 h-9 rounded-full object-cover border"
          />
        ) : others.length <= 1 ? (
          <UserAvatar userId={others[0] || meta.participants[0]} size="medium" />
        ) : (
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center border">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex-1 w-0 min-w-0">
        <div className="font-semibold truncate">{title}</div>
        <div className="mt-1 line-clamp-1 text-sm text-muted-foreground">
          {messagePreviewLabel}
          {meta.lastMessageAt > 0 ? (
            <>
              <span className="mx-1">•</span>
              <FormattedTimestamp
                timestamp={meta.lastMessageAt}
                className="text-muted-foreground text-sm"
                short
              />
            </>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
          <div className="flex -space-x-2">
            {facepileMembers.map((participant) => (
              <div
                key={`${meta.id}:${participant}`}
                className="h-5 w-5 overflow-hidden rounded-full bg-muted ring-2 ring-background"
              >
                <SimpleUserAvatar
                  userId={participant}
                  size="small"
                  className="h-full w-full rounded-full"
                />
              </div>
            ))}
          </div>
          <span className="text-xs font-medium">
            {compactMemberCount.format(meta.participants.length)}
          </span>
        </div>
        {meta.unreadCount > 0 && (
          <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
            {meta.unreadCount}
          </span>
        )}
      </div>
    </div>
  )
}
