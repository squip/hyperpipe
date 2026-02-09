import { useMemo } from 'react'
import { useMessenger } from '@/providers/MessengerProvider'
import type { ConversationSummary } from '@/lib/conversations/types'
import UserAvatar from '@/components/UserAvatar'
import { Users } from 'lucide-react'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'

function deriveDisplayName(meta: ConversationSummary, myPubkey: string | null): string {
  if (meta.title) return meta.title
  const others = meta.participants.filter((participant) => participant !== myPubkey)
  if (others.length === 0) return 'Me'
  if (others.length === 1) return others[0]
  return `${others[0]} +${others.length - 1}`
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

  return (
    <div
      className="clickable flex items-start gap-3 cursor-pointer px-4 py-3 border-b"
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
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold truncate">{title}</div>
          {meta.lastMessageAt > 0 && (
            <FormattedTimestamp
              timestamp={meta.lastMessageAt}
              className="text-muted-foreground text-xs shrink-0"
              short
            />
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {others.length > 1 ? `${others.length} participants` : null}
        </div>
        <div className="line-clamp-1 text-sm text-muted-foreground">
          {meta.lastMessagePreview || 'No messages yet.'}
        </div>
      </div>

      {meta.unreadCount > 0 && (
        <div className="self-center shrink-0">
          <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
            {meta.unreadCount}
          </span>
        </div>
      )}
    </div>
  )
}
