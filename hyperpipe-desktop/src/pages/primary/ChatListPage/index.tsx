import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import TitlebarInfoButton from '@/components/TitlebarInfoButton'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import PostRelaySelector from '@/components/PostEditor/PostRelaySelector'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent } from '@/components/ui/card'
import { Check, Loader2, MessageSquare, Search, Upload, UserPlus, Users, X } from 'lucide-react'
import { forwardRef, type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessenger } from '@/providers/MessengerProvider'
import { ChatListPanel } from '@/components/ChatConversations'
import { useNostr } from '@/providers/NostrProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useSecondaryPage } from '@/PageManager'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSearchProfiles } from '@/hooks/useSearchProfiles'
import Username from '@/components/Username'
import Nip05 from '@/components/Nip05'
import type {
  ConversationInvite,
  ConversationSummary,
  ConversationTab
} from '@/lib/conversations/types'
import {
  buildGroupRelayDisplayMetaMap,
  buildGroupRelayTargets,
  dedupeRelayUrlsByIdentity,
  resolvePublishRelayUrls,
  type GroupRelayTarget,
  type RelayDisplayMeta
} from '@/lib/relay-targets'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { TPageRef } from '@/types'

type CreateChatModalPayload = {
  title: string
  description: string
  members: string[]
  imageFile: File | null
  relayUrls: string[]
}

type ActiveJoinInviteErrorState = {
  inviteId: string
  message: string
}

function normalizeRelayListForChat(
  relayList: { read: string[]; write: string[] } | null,
  discoveryRelay?: string
) {
  return dedupeRelayUrlsByIdentity([
    ...(relayList?.read || []),
    ...(relayList?.write || []),
    discoveryRelay || ''
  ])
}

function MembersCell({ members }: { members: string[] }) {
  const compact = useMemo(() => new Intl.NumberFormat(undefined, { notation: 'compact' }), [])

  if (!members.length) {
    return <span className="text-xs text-muted-foreground">0</span>
  }

  const preview = members.slice(0, 3)
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
      <div className="flex -space-x-2">
        {preview.map((pubkey) => (
          <div
            key={pubkey}
            className="h-5 w-5 overflow-hidden rounded-full bg-muted ring-2 ring-background"
          >
            <SimpleUserAvatar userId={pubkey} size="small" className="h-full w-full rounded-full" />
          </div>
        ))}
      </div>
      <span className="text-xs font-medium">{compact.format(members.length)}</span>
    </div>
  )
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function normalizePubkey(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed.toLowerCase()
  return null
}

function matchesConversationSearch(conversation: ConversationSummary, query: string) {
  if (!query) return true
  const haystack = [
    conversation.id,
    conversation.title,
    conversation.description,
    conversation.lastMessagePreview,
    ...conversation.participants
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
  return haystack.includes(query)
}

function matchesInviteSearch(invite: ConversationInvite, query: string) {
  if (!query) return true
  const haystack = [
    invite.id,
    invite.senderPubkey,
    invite.title,
    invite.description,
    invite.conversationId
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
  return haystack.includes(query)
}

const ChatListPage = forwardRef<
  TPageRef,
  { initialTab?: ConversationTab; tabRequestId?: string | number }
>(({ initialTab, tabRequestId }, ref) => {
  const { t } = useTranslation()
  const { pubkey, relayList } = useNostr()
  const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()
  const { refreshRelaySubscriptions } = useWorkerBridge()
  const { push } = useSecondaryPage()
  const {
    conversations,
    invites,
    pendingInviteCount,
    ready,
    initialSyncPending,
    unsupportedReason,
    createConversation,
    acceptInvite,
    refreshConversations,
    refreshInvites,
    dismissInvite
  } = useMessenger()
  const [tab, setTab] = useState<ConversationTab>(initialTab || 'my')
  const [search, setSearch] = useState('')
  const [openNew, setOpenNew] = useState(false)
  const [creatingConversation, setCreatingConversation] = useState(false)
  const [createConversationError, setCreateConversationError] = useState<string | null>(null)
  const [joiningInviteId, setJoiningInviteId] = useState<string | null>(null)
  const [joinInviteError, setJoinInviteError] = useState<ActiveJoinInviteErrorState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const discoveryRelay = import.meta.env.VITE_DISCOVERY_RELAY as string | undefined

  const defaultCreateRelayUrls = useMemo(
    () => normalizeRelayListForChat(relayList, discoveryRelay),
    [relayList, discoveryRelay]
  )

  const groupRelayTargets = useMemo<GroupRelayTarget[]>(
    () =>
      buildGroupRelayTargets({
        myGroupList,
        resolveRelayUrl,
        getProvisionalGroupMetadata,
        discoveryGroups
      }),
    [discoveryGroups, getProvisionalGroupMetadata, myGroupList, resolveRelayUrl]
  )

  const localGroupRelayDisplay = useMemo<Record<string, RelayDisplayMeta>>(
    () => buildGroupRelayDisplayMetaMap(groupRelayTargets),
    [groupRelayTargets]
  )

  const query = useMemo(() => normalizeSearch(search), [search])

  const filteredConversations = useMemo(
    () => conversations.filter((conversation) => matchesConversationSearch(conversation, query)),
    [conversations, query]
  )

  const filteredInvites = useMemo(
    () => invites.filter((invite) => matchesInviteSearch(invite, query)),
    [invites, query]
  )

  useEffect(() => {
    if (!initialTab) return
    setTab(initialTab)
  }, [initialTab, tabRequestId])

  useEffect(() => {
    if (openNew) return
    setCreateConversationError(null)
  }, [openNew])

  const conversationParticipantsById = useMemo(() => {
    const next = new Map<string, string[]>()
    for (const conversation of conversations) {
      next.set(
        conversation.id,
        Array.isArray(conversation.participants)
          ? conversation.participants.filter((participant) => Boolean(participant))
          : []
      )
    }
    return next
  }, [conversations])

  const inviteRows = useMemo(() => {
    return [...filteredInvites]
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
        return left.id.localeCompare(right.id)
      })
      .map((invite) => {
        const conversationMembers = invite.conversationId
          ? conversationParticipantsById.get(invite.conversationId) || []
          : []
        const explicitMembers = Array.isArray(invite.memberPubkeys)
          ? invite.memberPubkeys.filter((member) => Boolean(member))
          : []
        const members = Array.from(
          new Set(
            explicitMembers.length
              ? explicitMembers
              : conversationMembers.length
                ? conversationMembers
                : [invite.senderPubkey].filter(Boolean)
          )
        )
        return { invite, members }
      })
  }, [filteredInvites, conversationParticipantsById])

  const invitesTabLabel =
    pendingInviteCount > 0 ? `${t('Invites')} (${pendingInviteCount})` : t('Invites')

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshConversations(), refreshInvites()])
    } catch (error) {
      console.warn('Failed refreshing chats', error)
      toast.error(t('Failed to refresh chats'))
    } finally {
      setRefreshing(false)
    }
  }

  const handleCreateConversation = async ({
    title,
    description,
    members,
    imageFile,
    relayUrls
  }: CreateChatModalPayload) => {
    const uniqueMembers = Array.from(
      new Set(
        members
          .map((member) => normalizePubkey(member))
          .filter((member): member is string => !!member)
      )
    ).filter((member) => member !== pubkey)

    if (!uniqueMembers.length) {
      toast.error(t('Add at least one valid member'))
      return
    }

    setCreatingConversation(true)
    setCreateConversationError(null)
    try {
      const publishRelayUrls = await resolvePublishRelayUrls({
        relayUrls: dedupeRelayUrlsByIdentity(relayUrls),
        resolveRelayUrl,
        groupRelayTargets,
        refreshGroupRelay: async (groupId) => {
          await refreshRelaySubscriptions({
            publicIdentifier: groupId,
            reason: 'chat-create-relay-publish',
            timeoutMs: 12_000
          })
        }
      })
      if (!publishRelayUrls.length) {
        throw new Error(t('Select at least one relay'))
      }

      const createResult = await createConversation(
        {
          title: title.trim() || t('Chat'),
          description: description.trim() || undefined,
          members: uniqueMembers,
          thumbnailFile: imageFile,
          relayUrls: publishRelayUrls
        }
      )
      const conversation = createResult.conversation

      setOpenNew(false)
      push(`/conversations/${conversation.id}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed creating chat', error)
      setCreateConversationError(message)
      toast.error(t('Failed to create chat'))
    } finally {
      setCreatingConversation(false)
    }
  }

  const handleJoinInvite = async (invite: ConversationInvite) => {
    if (!invite?.id) return
    if (joiningInviteId) return

    if (invite.status === 'joined' && invite.conversationId) {
      push(`/conversations/${invite.conversationId}`)
      return
    }

    setJoiningInviteId(invite.id)
    setJoinInviteError((previous) =>
      previous?.inviteId === invite.id ? null : previous
    )
    try {
      const result = await acceptInvite(invite.id)
      const conversationId = result.conversationId || invite.conversationId
      if (conversationId) {
        push(`/conversations/${conversationId}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed joining chat invite', error)
      setJoinInviteError({
        inviteId: invite.id,
        message
      })
      toast.error(t('Failed to join invite'))
    } finally {
      setJoiningInviteId(null)
    }
  }

  const handleDismissInvite = (invite: ConversationInvite) => {
    if (!invite?.id) return
    dismissInvite(invite.id)
  }

  return (
    <PrimaryPageLayout
      ref={ref}
      pageName="conversations"
      titlebar={<ChatListPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                tab === 'my' ? (t('Search chats...') as string) : (t('Search invites...') as string)
              }
              className="pl-8"
            />
          </div>
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing}>
            <Loader2 className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setOpenNew(true)}>{t('Create')}</Button>
        </div>

        <Tabs value={tab} onValueChange={(value) => setTab(value as ConversationTab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="my">{t('My Chats')}</TabsTrigger>
            <TabsTrigger value="invites">{invitesTabLabel}</TabsTrigger>
          </TabsList>

          <TabsContent value="my" className="mt-4">
            <ChatListPanel
              myPubkey={pubkey}
              conversations={filteredConversations}
              onOpenConversation={(id) => push(`/conversations/${id}`)}
            />
          </TabsContent>

          <TabsContent value="invites" className="mt-4">
            {!ready || (initialSyncPending && !inviteRows.length) ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                {t('Loading invites...')}
              </div>
            ) : unsupportedReason && !inviteRows.length ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                {unsupportedReason}
              </div>
            ) : !inviteRows.length ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                {t('No invites')}
              </div>
            ) : (
              <div className="overflow-x-auto scrollbar-hide rounded-lg border">
                <table className="w-full min-w-[1060px] table-fixed">
                  <thead className="bg-muted/40 text-xs font-medium text-muted-foreground">
                    <tr>
                      <th className="w-[220px] px-3 py-2 text-left">{t('Actions')}</th>
                      <th className="w-14 px-3 py-2 text-left">
                        <span className="sr-only">{t('Thumbnail')}</span>
                      </th>
                      <th className="w-[200px] px-3 py-2 text-left">{t('Chat')}</th>
                      <th className="w-[220px] px-3 py-2 text-left">{t('Description')}</th>
                      <th className="w-[160px] px-3 py-2 text-left">{t('Members')}</th>
                      <th className="w-[220px] px-3 py-2 text-left">{t('Invited by')}</th>
                      <th className="w-[140px] px-3 py-2 text-left">{t('Invite age')}</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {inviteRows.map(({ invite, members }) => {
                      const isJoining = joiningInviteId === invite.id || invite.status === 'joining'
                      const joinDisabled = Boolean(joiningInviteId) || invite.status === 'joining'
                      const dismissDisabled = joiningInviteId === invite.id
                      const rowError =
                        joinInviteError?.inviteId === invite.id
                          ? joinInviteError.message
                          : invite.error
                      const initials = (invite.title || t('Chat')).slice(0, 2).toUpperCase()

                      return (
                        <tr
                          key={invite.id}
                          className="border-t transition-colors hover:bg-accent/30"
                        >
                          <td className="px-3 py-3 align-top">
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDismissInvite(invite)}
                                disabled={dismissDisabled}
                              >
                                <X className="mr-1 h-4 w-4" />
                                {t('Dismiss')}
                              </Button>
                              <Button
                                size="sm"
                                disabled={joinDisabled}
                                onClick={() => handleJoinInvite(invite)}
                              >
                                {isJoining ? t('Joining...') : t('Join')}
                              </Button>
                            </div>
                            {rowError ? (
                              <div className="mt-2 text-xs text-red-500">{rowError}</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 align-top">
                            <Avatar className="h-10 w-10 shrink-0">
                              {invite.imageUrl ? (
                                <AvatarImage
                                  src={invite.imageUrl}
                                  alt={invite.title || t('Chat invite')}
                                />
                              ) : null}
                              <AvatarFallback className="text-xs font-semibold">
                                {invite.imageUrl ? (
                                  initials
                                ) : (
                                  <Users className="h-4 w-4 text-muted-foreground" />
                                )}
                              </AvatarFallback>
                            </Avatar>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="truncate font-semibold">
                              {invite.title || t('Chat invite')}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top text-muted-foreground">
                            <div className="line-clamp-3 max-w-[220px] whitespace-pre-wrap break-words">
                              {invite.description || t('Encrypted chat invite')}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <MembersCell members={members} />
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="flex min-w-0 items-center gap-2">
                              <SimpleUserAvatar
                                userId={invite.senderPubkey}
                                size="small"
                                className="h-6 w-6 rounded-full"
                              />
                              <Username userId={invite.senderPubkey} className="truncate text-sm" />
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                            {invite.createdAt > 0 ? (
                              <FormattedTimestamp timestamp={invite.createdAt} />
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <NewChatDialog
        open={openNew}
        onOpenChange={setOpenNew}
        busy={creatingConversation}
        myPubkey={pubkey}
        defaultRelayUrls={defaultCreateRelayUrls}
        groupRelayTargets={groupRelayTargets}
        localGroupRelayDisplay={localGroupRelayDisplay}
        error={createConversationError}
        onCreate={handleCreateConversation}
      />
    </PrimaryPageLayout>
  )
})
ChatListPage.displayName = 'ChatListPage'
export default ChatListPage

function ChatListPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center justify-between h-full pl-3 pr-2">
      <div className="flex items-center gap-2">
        <MessageSquare />
        <div className="text-lg font-semibold">{t('Chat')}</div>
      </div>
      <TitlebarInfoButton
        label="Chat info"
        content="Decentralized, end-to-end encrypted group messaging over Marmot protocol (MLS + Nostr)"
      />
    </div>
  )
}

export function NewChatDialog({
  open,
  onOpenChange,
  busy,
  myPubkey,
  defaultRelayUrls,
  groupRelayTargets,
  localGroupRelayDisplay,
  error,
  onCreate
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  busy: boolean
  myPubkey: string | null
  defaultRelayUrls: string[]
  groupRelayTargets: GroupRelayTarget[]
  localGroupRelayDisplay: Record<string, RelayDisplayMeta>
  error: string | null
  onCreate: (payload: CreateChatModalPayload) => Promise<void>
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [inviteSearch, setInviteSearch] = useState('')
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([])
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [selectedRelayUrls, setSelectedRelayUrls] = useState<string[]>(defaultRelayUrls)
  const wasOpenRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { profiles: inviteProfiles, isFetching: isSearchingInvites } = useSearchProfiles(
    inviteSearch,
    8
  )
  const inviteCandidateProfiles = useMemo(
    () =>
      inviteProfiles.filter(
        (profile) => profile.pubkey && normalizePubkey(profile.pubkey) !== normalizePubkey(myPubkey || '')
      ),
    [inviteProfiles, myPubkey]
  )
  const normalizedInviteSearch = inviteSearch.trim()
  const showInviteResults = Boolean(normalizedInviteSearch)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelectedRelayUrls(defaultRelayUrls)
    }
    wasOpenRef.current = open
  }, [defaultRelayUrls, open])

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl)
      }
    }
  }, [imagePreviewUrl])

  const resetState = () => {
    setTitle('')
    setDescription('')
    setInviteSearch('')
    setSelectedInvitees([])
    setImageFile(null)
    setImagePreviewUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous)
      }
      return null
    })
    setSelectedRelayUrls(defaultRelayUrls)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    if (open) return
    resetState()
  }, [defaultRelayUrls, open])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) {
      return
    }
    onOpenChange(nextOpen)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null
    setImageFile(file)
    setImagePreviewUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous)
      }
      return file ? URL.createObjectURL(file) : null
    })
  }

  const handleInviteAdd = (pubkey: string) => {
    setSelectedInvitees((previous) =>
      previous.includes(pubkey) ? previous : [...previous, pubkey]
    )
  }

  const handleInviteRemove = (pubkey: string) => {
    setSelectedInvitees((previous) => previous.filter((existing) => existing !== pubkey))
  }

  const openFilePicker = () => {
    if (busy) return
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const clearSelectedImage = () => {
    setImageFile(null)
    setImagePreviewUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous)
      }
      return null
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleCreate = async () => {
    if (!selectedInvitees.length) return
    if (!selectedRelayUrls.length) {
      toast.error(t('Select at least one relay'))
      return
    }
    await onCreate({
      title,
      description,
      members: selectedInvitees,
      imageFile,
      relayUrls: selectedRelayUrls
    })
  }

  const hasThumbnailPreview = Boolean(imagePreviewUrl)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(96vw,46rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        withoutClose={busy}
        onEscapeKeyDown={busy ? (event) => event.preventDefault() : undefined}
        onInteractOutside={busy ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5">
          <DialogTitle>{t('Create chat')}</DialogTitle>
          <DialogDescription>
            {t('Choose members, relays, and an optional thumbnail for the new chat.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div
            className={cn(
              'flex flex-col gap-5',
              busy && 'pointer-events-none opacity-60'
            )}
          >
            <section className="space-y-4 rounded-2xl border border-border/70 bg-card/60 p-4">
              <div className="space-y-1">
                <div className="text-sm font-semibold">{t('Basics')}</div>
                <p className="text-sm text-muted-foreground">
                  {t('Add a name, optional description, and optional thumbnail.')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-chat-title">{t('Chat title')}</Label>
                <div className="relative z-0 rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:z-10 focus-within:border-ring/70 focus-within:ring-4 focus-within:ring-ring/10">
                  <Input
                    id="create-chat-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t('Give this chat a name') as string}
                    className="h-11 rounded-xl border-0 bg-transparent px-4 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-chat-description">{t('Description')}</Label>
                <div className="relative z-0 rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:z-10 focus-within:border-ring/70 focus-within:ring-4 focus-within:ring-ring/10">
                  <Textarea
                    id="create-chat-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t('Add context for members joining this chat (optional)') as string}
                    className="min-h-[96px] resize-y rounded-xl border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>{t('Chat thumbnail (optional)')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('Choose an image to help people recognize this chat.')}
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  disabled={busy}
                  className="sr-only"
                />
                {!hasThumbnailPreview ? (
                  <button
                    type="button"
                    onClick={openFilePicker}
                    disabled={busy}
                    className="flex w-full items-center gap-4 rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-4 text-left transition-colors hover:border-ring/40 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Upload className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium">{t('Upload a chat thumbnail')}</div>
                      <div className="text-sm text-muted-foreground">
                        {t('PNG, JPG, or GIF')}
                      </div>
                    </div>
                  </button>
                ) : (
                  <div className="rounded-xl border border-border/70 bg-background p-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <img
                        src={imagePreviewUrl || undefined}
                        alt={imageFile?.name || 'Chat thumbnail'}
                        className="h-14 w-14 shrink-0 rounded-lg object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{imageFile?.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {t('Selected image')}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button variant="outline" size="sm" onClick={openFilePicker} disabled={busy}>
                          {t('Replace')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={clearSelectedImage} disabled={busy}>
                          {t('Remove')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-border/70 bg-card/60 p-4">
              <div className="space-y-1">
                <div className="text-sm font-semibold">{t('Members')}</div>
                <p className="text-sm text-muted-foreground">
                  {t('Search for people to invite, then review the final member list below.')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-chat-invite-search">{t('Invite members')}</Label>
                <div className="relative z-0 rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:z-10 focus-within:border-ring/70 focus-within:ring-4 focus-within:ring-ring/10">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="create-chat-invite-search"
                    value={inviteSearch}
                    onChange={(event) => setInviteSearch(event.target.value)}
                    placeholder={t('Search users...') as string}
                    className="h-11 rounded-xl border-0 bg-transparent pl-10 pr-4 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={busy}
                  />
                </div>
              </div>

              {showInviteResults ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t('Search results')}</div>
                  <Card className="overflow-hidden">
                    <ScrollArea className="max-h-60">
                      <CardContent className="space-y-2 p-3">
                        {isSearchingInvites ? (
                          <div className="py-3 text-sm text-muted-foreground">
                            {t('Searching...')}
                          </div>
                        ) : null}
                        {!isSearchingInvites && inviteCandidateProfiles.length === 0 ? (
                          <div className="py-3 text-sm text-muted-foreground">
                            {t('No users found')}
                          </div>
                        ) : null}
                        {!isSearchingInvites &&
                          inviteCandidateProfiles.map((profile) => {
                            const normalizedPubkey = normalizePubkey(profile.pubkey || '')
                            if (!normalizedPubkey) return null
                            const isSelected = selectedInvitees.includes(normalizedPubkey)
                            return (
                              <div
                                key={normalizedPubkey}
                                className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/40"
                              >
                                <UserAvatar userId={normalizedPubkey} className="shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <Username
                                    userId={normalizedPubkey}
                                    className="block truncate font-semibold"
                                  />
                                  <Nip05 pubkey={normalizedPubkey} className="w-full min-w-0" />
                                </div>
                                <Button
                                  variant={isSelected ? 'secondary' : 'outline'}
                                  size="sm"
                                  onClick={() => handleInviteAdd(normalizedPubkey)}
                                  className="h-8 w-20 shrink-0 px-2"
                                  disabled={busy || isSelected}
                                >
                                  {isSelected ? (
                                    <>
                                      <Check className="mr-1 h-3 w-3" />
                                      {t('Added')}
                                    </>
                                  ) : (
                                    <>
                                      <UserPlus className="mr-1 h-3 w-3" />
                                      {t('Add')}
                                    </>
                                  )}
                                </Button>
                              </div>
                            )
                          })}
                      </CardContent>
                    </ScrollArea>
                  </Card>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-3 py-2 text-sm text-muted-foreground">
                  {t('Search for users to invite')}
                </div>
              )}

              {selectedInvitees.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">
                    {t('Selected members')} ({selectedInvitees.length})
                  </div>
                  <Card className="overflow-hidden">
                    <ScrollArea className="max-h-56">
                      <CardContent className="space-y-2 p-3">
                        {selectedInvitees.map((pubkey) => (
                          <div
                            key={pubkey}
                            className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/30"
                          >
                            <UserAvatar userId={pubkey} className="shrink-0" />
                            <div className="min-w-0 flex-1">
                              <Username userId={pubkey} className="block truncate font-semibold" />
                              <Nip05 pubkey={pubkey} className="w-full min-w-0" />
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0"
                              onClick={() => handleInviteRemove(pubkey)}
                              disabled={busy}
                            >
                              {t('Remove')}
                            </Button>
                          </div>
                        ))}
                      </CardContent>
                    </ScrollArea>
                  </Card>
                </div>
              ) : null}
            </section>

            <section className="space-y-4 rounded-2xl border border-border/70 bg-card/60 p-4">
              <div className="space-y-1">
                <div className="text-sm font-semibold">{t('Relays')}</div>
                <p className="text-sm text-muted-foreground">
                  {t('Choose the relays this chat should publish to.')}
                </p>
              </div>

              <PostRelaySelector
                allowWriteRelays={false}
                extraRelayUrls={[
                  ...defaultRelayUrls,
                  ...groupRelayTargets.map((target) => target.relayUrl)
                ]}
                relayDisplayMeta={localGroupRelayDisplay}
                valueRelayUrls={selectedRelayUrls}
                onValueRelayUrlsChange={setSelectedRelayUrls}
              />
            </section>
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-6 py-4">
          {error ? <div className="mb-3 text-sm text-red-500">{error}</div> : null}
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={busy || selectedInvitees.length === 0 || selectedRelayUrls.length === 0}
            >
              {busy ? t('Creating...') : t('Create chat')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
