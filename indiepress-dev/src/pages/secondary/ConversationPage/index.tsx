import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useSecondaryPage } from '@/PageManager'
import { ChevronLeft, Users } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMessenger } from '@/providers/MessengerProvider'
import { useNostr } from '@/providers/NostrProvider'
import { DMThread } from '@/components/DMThread'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import Username, { SimpleUsername } from '@/components/Username'
import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import client from '@/services/client.service'
import { cn } from '@/lib/utils'

const ConversationPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { pop } = useSecondaryPage()
  const conversationId = useMemo(() => window.location.pathname.split('/').pop() || '', [])
  const { conversations } = useMessenger()
  const { pubkey } = useNostr()
  const meta = conversations.find((conversation) => conversation.id === conversationId)
  const [showMembers, setShowMembers] = useState(false)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [useDocumentScroll, setUseDocumentScroll] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!meta?.participants?.length) return

    ;(async () => {
      const entries = await Promise.all(
        meta.participants.map(async (participant) => {
          try {
            const profile = await client.fetchProfile(participant)
            const display = profile?.shortName || participant
            return [participant, display] as const
          } catch {
            return [participant, participant] as const
          }
        })
      )
      if (!cancelled) {
        setNameMap(Object.fromEntries(entries))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [meta?.participants])

  const participantLine = useMemo(() => {
    if (!meta?.participants?.length) return ''
    return meta.participants.map((participant) => nameMap[participant] || participant).join(', ')
  }, [meta?.participants, nameMap])

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      titlebar={
        <div className="flex items-center gap-2 h-full px-2">
          <Button variant="ghost" size="titlebar-icon" onClick={() => pop()}>
            <ChevronLeft />
          </Button>
          <div className="flex items-center gap-2">
            {meta?.imageUrl ? (
              <img
                src={meta.imageUrl}
                alt="Conversation"
                className="w-8 h-8 rounded-full object-cover border"
              />
            ) : meta?.participants && meta.participants.length <= 2 ? (
              <UserAvatar
                userId={meta.participants.find((participant) => participant !== pubkey) || meta.participants[0]}
                size="small"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center border">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
          </div>
          <button
            type="button"
            className={cn(
              'flex flex-col min-w-0 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
              'hover:text-foreground'
            )}
            onClick={() => setShowMembers(true)}
          >
            <div className="text-sm font-semibold truncate">{meta?.title || 'Conversation'}</div>
            <div className="text-xs text-muted-foreground truncate">{participantLine}</div>
          </button>
        </div>
      }
      displayScrollToTopButton={false}
      skipInitialScrollToTop
      onScrollContextChange={setUseDocumentScroll}
    >
      <DMThread conversationId={conversationId} myPubkey={pubkey} useDocumentScroll={useDocumentScroll} />
      <MembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        subject={meta?.title || 'Conversation'}
        participants={meta?.participants || []}
      />
    </SecondaryPageLayout>
  )
})

ConversationPage.displayName = 'ConversationPage'
export default ConversationPage

function MembersDialog({
  open,
  onOpenChange,
  subject,
  participants
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: string
  participants: string[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex flex-row items-center gap-3">
          <DialogClose asChild>
            <Button variant="ghost" size="icon">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </DialogClose>
          <div className="flex-1 min-w-0">
            <DialogTitle className="truncate">{subject}</DialogTitle>
            <div className="text-sm text-muted-foreground truncate">
              {participants.length === 1 ? (
                <Username userId={participants[0]} className="truncate" withoutSkeleton />
              ) : (
                <div className="truncate">
                  {participants.map((participant, index) => (
                    <span key={participant} className="text-sm text-muted-foreground">
                      <SimpleUsername userId={participant} className="inline" withoutSkeleton />
                      {index < participants.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>
        <div className="mt-2 max-h-[70vh] overflow-y-auto space-y-3 pr-1">
          {participants.map((participant) => (
            <div key={participant} className="flex items-center gap-3">
              <SimpleUserAvatar userId={participant} size="medium" />
              <div className="flex-1 min-w-0">
                <SimpleUsername userId={participant} className="font-medium truncate" withoutSkeleton />
                <div className="text-xs text-muted-foreground truncate">{participant}</div>
              </div>
            </div>
          ))}
          {!participants.length && (
            <div className="text-sm text-muted-foreground">No conversation members found.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
