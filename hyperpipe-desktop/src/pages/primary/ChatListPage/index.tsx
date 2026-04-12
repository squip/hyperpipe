import { SimpleUserAvatar } from '@/components/UserAvatar'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import { NewChatDialog, type CreateChatModalPayload } from '@/components/NewChatDialog'
import TitlebarInfoButton from '@/components/TitlebarInfoButton'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Loader2, MessageSquare, Search, Users, X } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessenger } from '@/providers/MessengerProvider'
import { ChatListPanel } from '@/components/ChatConversations'
import { useNostr } from '@/providers/NostrProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useSecondaryPage } from '@/PageManager'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import Username from '@/components/Username'
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
import { toast } from 'sonner'
import type { TPageRef } from '@/types'

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
    <div className="flex h-full w-full min-w-0 items-center justify-between gap-2 pl-3 pr-2">
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
