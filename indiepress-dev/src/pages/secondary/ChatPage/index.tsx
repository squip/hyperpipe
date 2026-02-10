import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useSecondaryPage } from '@/PageManager'
import { Check, ChevronLeft, Search, UserPlus, Users } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMessenger } from '@/providers/MessengerProvider'
import { useNostr } from '@/providers/NostrProvider'
import { ChatThread } from '@/components/ChatThread'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import Username, { SimpleUsername } from '@/components/Username'
import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import { useSearchProfiles } from '@/hooks/useSearchProfiles'
import client from '@/services/client.service'
import { toProfile } from '@/lib/link'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

const ChatPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { pop, push } = useSecondaryPage()
  const conversationId = useMemo(() => window.location.pathname.split('/').pop() || '', [])
  const { conversations, grantConversationAdmin, inviteMembers } = useMessenger()
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

  const openProfile = useCallback((userPubkey: string) => {
    if (!userPubkey) return
    push(toProfile(userPubkey))
  }, [push])

  const makeAdmin = useCallback(async (targetPubkey: string) => {
    if (!conversationId || !targetPubkey) return
    try {
      await grantConversationAdmin(conversationId, targetPubkey)
      toast.success('Admin permissions granted')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to grant admin permissions'
      toast.error(message)
      throw error
    }
  }, [conversationId, grantConversationAdmin])

  const addMembers = useCallback(async (members: string[]) => {
    if (!conversationId || !members.length) return
    try {
      await inviteMembers(conversationId, members)
      toast.success(members.length === 1 ? 'Invite sent' : 'Invites sent')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to invite members'
      toast.error(message)
      throw error
    }
  }, [conversationId, inviteMembers])

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
                alt="Chat"
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
            <div className="text-sm font-semibold truncate">{meta?.title || 'Chat'}</div>
            <div className="text-xs text-muted-foreground truncate">{participantLine}</div>
          </button>
        </div>
      }
      displayScrollToTopButton={false}
      skipInitialScrollToTop
      onScrollContextChange={setUseDocumentScroll}
    >
      <ChatThread conversationId={conversationId} myPubkey={pubkey} useDocumentScroll={useDocumentScroll} />
      <MembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        subject={meta?.title || 'Chat'}
        participants={meta?.participants || []}
        adminPubkeys={meta?.adminPubkeys || []}
        canManageAdmins={Boolean(meta?.canInviteMembers)}
        myPubkey={pubkey}
        onOpenProfile={openProfile}
        onMakeAdmin={makeAdmin}
        onInviteMembers={addMembers}
      />
    </SecondaryPageLayout>
  )
})

ChatPage.displayName = 'ChatPage'
export default ChatPage

function MembersDialog({
  open,
  onOpenChange,
  subject,
  participants,
  adminPubkeys,
  canManageAdmins,
  myPubkey,
  onOpenProfile,
  onMakeAdmin,
  onInviteMembers
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: string
  participants: string[]
  adminPubkeys: string[]
  canManageAdmins: boolean
  myPubkey: string | null
  onOpenProfile: (pubkey: string) => void
  onMakeAdmin: (pubkey: string) => Promise<void>
  onInviteMembers: (members: string[]) => Promise<void>
}) {
  const [addMembersOpen, setAddMembersOpen] = useState(false)
  const [inviteSearch, setInviteSearch] = useState('')
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([])
  const [invitingMembers, setInvitingMembers] = useState(false)
  const [promotingPubkey, setPromotingPubkey] = useState<string | null>(null)
  const { profiles: inviteProfiles, isFetching: isSearchingInvites } = useSearchProfiles(inviteSearch, 8)
  const adminSet = useMemo(
    () => new Set((adminPubkeys || []).map((pubkey) => String(pubkey || '').trim().toLowerCase()).filter(Boolean)),
    [adminPubkeys]
  )
  const normalizedMyPubkey = useMemo(() => normalizePubkey(myPubkey || ''), [myPubkey])
  const participantSet = useMemo(
    () =>
      new Set(
        (participants || [])
          .map((participant) => normalizePubkey(participant))
          .filter((participant): participant is string => Boolean(participant))
      ),
    [participants]
  )
  const inviteCandidateProfiles = useMemo(
    () =>
      inviteProfiles.filter((profile) => {
        const normalizedPubkey = normalizePubkey(profile?.pubkey || '')
        if (!normalizedPubkey) return false
        if (normalizedMyPubkey && normalizedPubkey === normalizedMyPubkey) return false
        return !participantSet.has(normalizedPubkey)
      }),
    [inviteProfiles, normalizedMyPubkey, participantSet]
  )

  useEffect(() => {
    if (!open) {
      setPromotingPubkey(null)
      setAddMembersOpen(false)
      setInviteSearch('')
      setSelectedInvitees([])
      setInvitingMembers(false)
    }
  }, [open])

  const handlePromote = async (participant: string) => {
    if (!participant || promotingPubkey) return
    setPromotingPubkey(participant)
    try {
      await onMakeAdmin(participant)
    } catch {
      // errors are surfaced by the caller
    } finally {
      setPromotingPubkey((current) => (current === participant ? null : current))
    }
  }

  const handleInviteToggle = (pubkey: string) => {
    setSelectedInvitees((previous) =>
      previous.includes(pubkey)
        ? previous.filter((existing) => existing !== pubkey)
        : [...previous, pubkey]
    )
  }

  const handleInviteMembers = async () => {
    if (!selectedInvitees.length || invitingMembers) return
    setInvitingMembers(true)
    try {
      await onInviteMembers(selectedInvitees)
      setSelectedInvitees([])
      setInviteSearch('')
      setAddMembersOpen(false)
    } catch {
      // errors are surfaced by the caller
    } finally {
      setInvitingMembers(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,48rem)] sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex flex-row items-center gap-3">
          <DialogClose asChild>
            <Button variant="ghost" size="icon">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </DialogClose>
          <div className="flex-1 min-w-0">
            <DialogTitle className="truncate">{subject}</DialogTitle>
            <div className="text-sm text-muted-foreground whitespace-normal break-words line-clamp-2">
              {participants.length === 1 ? (
                <Username userId={participants[0]} className="truncate" withoutSkeleton />
              ) : (
                <div className="min-w-0">
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
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-3">
          {canManageAdmins ? (
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Add members</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddMembersOpen((previous) => !previous)}
                  disabled={invitingMembers}
                >
                  {addMembersOpen ? 'Hide' : 'Add members'}
                </Button>
              </div>
              {addMembersOpen ? (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={inviteSearch}
                      onChange={(event) => setInviteSearch(event.target.value)}
                      placeholder="Search users..."
                      className="pl-8"
                    />
                  </div>
                  <div className="max-h-44 overflow-y-auto overflow-x-hidden rounded border py-1 scrollbar-hide">
                    {inviteSearch && isSearchingInvites ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
                    ) : null}
                    {!isSearchingInvites && inviteCandidateProfiles.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {inviteSearch ? 'No users found' : 'Search for users to invite'}
                      </div>
                    ) : null}
                    {inviteCandidateProfiles.map((profile) => {
                      const normalizedPubkey = normalizePubkey(profile?.pubkey || '')
                      if (!normalizedPubkey) return null
                      const isSelected = selectedInvitees.includes(normalizedPubkey)
                      return (
                        <div
                          key={normalizedPubkey}
                          className="flex min-w-0 items-center gap-2 px-2 py-1.5 hover:bg-accent/40"
                        >
                          <SimpleUserAvatar userId={normalizedPubkey} size="small" />
                          <div className="min-w-0 flex-1">
                            <SimpleUsername
                              userId={normalizedPubkey}
                              profile={profile}
                              className="font-medium truncate"
                              withoutSkeleton
                            />
                            <div className="text-xs text-muted-foreground truncate">
                              {shortPubkey(normalizedPubkey)}
                            </div>
                          </div>
                          <Button
                            variant={isSelected ? 'secondary' : 'outline'}
                            size="sm"
                            className="h-8 w-20 shrink-0 px-2"
                            onClick={() => handleInviteToggle(normalizedPubkey)}
                          >
                            {isSelected ? (
                              <>
                                <Check className="mr-1 h-3 w-3" />
                                Added
                              </>
                            ) : (
                              <>
                                <UserPlus className="mr-1 h-3 w-3" />
                                Add
                              </>
                            )}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      {selectedInvitees.length > 0 ? `${selectedInvitees.length} selected` : ''}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => void handleInviteMembers()}
                      disabled={invitingMembers || selectedInvitees.length === 0}
                    >
                      {invitingMembers
                        ? 'Inviting...'
                        : selectedInvitees.length === 1
                          ? 'Invite member'
                          : 'Invite members'}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden space-y-2 pr-1 scrollbar-hide">
          {participants.map((participant) => {
            const normalizedParticipant = String(participant || '').trim().toLowerCase()
            const isAdmin = adminSet.has(normalizedParticipant)
            const canPromote =
              canManageAdmins
              && participant !== myPubkey
              && !isAdmin
            const isPromoting = promotingPubkey === participant

            return (
              <div
                key={participant}
                role="button"
                tabIndex={0}
                className="flex min-w-0 items-center gap-3 rounded-md border px-2 py-2 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                onClick={() => onOpenProfile(participant)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpenProfile(participant)
                  }
                }}
              >
                <SimpleUserAvatar userId={participant} size="medium" />
                <div className="flex-1 min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <SimpleUsername userId={participant} className="font-medium truncate" withoutSkeleton />
                    {isAdmin ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Admin
                      </span>
                    ) : null}
                  </div>
                </div>
                {canPromote ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={Boolean(promotingPubkey)}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void handlePromote(participant)
                    }}
                  >
                    {isPromoting ? 'Updating…' : 'Make admin'}
                  </Button>
                ) : null}
              </div>
            )
          })}
          {!participants.length && (
            <div className="text-sm text-muted-foreground">No chat members found.</div>
          )}
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function normalizePubkey(value: string): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null
  return normalized
}

function shortPubkey(pubkey: string): string {
  if (!pubkey) return ''
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`
}
