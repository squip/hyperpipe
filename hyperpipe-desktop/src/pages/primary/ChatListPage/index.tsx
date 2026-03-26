import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import TitlebarInfoButton from '@/components/TitlebarInfoButton'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import PostRelaySelector from '@/components/PostEditor/PostRelaySelector'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Check, Loader2, MessageSquare, Search, UserPlus, Users, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
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
import {
  getCreateConversationProgressLabel,
  getCreateConversationProgressTitle,
  getCreateConversationProgressValue,
  getJoinConversationProgressLabel,
  getJoinConversationProgressTitle,
  getJoinConversationProgressValue,
  type CreateConversationProgressState,
  type JoinConversationProgressState
} from '@/lib/workflow-progress-ui'
import mediaUploadService from '@/services/media-upload.service'
import { toast } from 'sonner'
import type { TPageRef } from '@/types'
import WorkflowProgress from '@/components/WorkflowProgress'

type RelayPublishMode = 'withFallback' | 'strict'

type CreateChatModalPayload = {
  title: string
  description: string
  members: string[]
  imageFile: File | null
  relayUrls: string[]
  relayMode: RelayPublishMode
}

type ActiveJoinInviteProgressState = JoinConversationProgressState & {
  inviteId: string
}

const HYPERDRIVE_UPLOAD_RELAY_URL = 'http://127.0.0.1:8443'

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
    unsupportedReason,
    createConversation,
    acceptInvite,
    refreshConversations,
    refreshInvites,
    updateConversationMetadata,
    dismissInvite
  } = useMessenger()
  const [tab, setTab] = useState<ConversationTab>(initialTab || 'my')
  const [search, setSearch] = useState('')
  const [openNew, setOpenNew] = useState(false)
  const [creatingConversation, setCreatingConversation] = useState(false)
  const [createConversationProgress, setCreateConversationProgress] =
    useState<CreateConversationProgressState | null>(null)
  const [createConversationError, setCreateConversationError] = useState<string | null>(null)
  const [joiningInviteId, setJoiningInviteId] = useState<string | null>(null)
  const [joinInviteProgress, setJoinInviteProgress] =
    useState<ActiveJoinInviteProgressState | null>(null)
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
    setCreateConversationProgress(null)
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
    relayUrls,
    relayMode
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
    setCreateConversationProgress({ phase: 'creatingConversation' })
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
          relayUrls: publishRelayUrls,
          relayMode
        },
        {
          onProgress: (state) => {
            if (state.phase === 'error') {
              setCreateConversationError(state.error || t('Failed to create chat'))
              return
            }
            setCreateConversationError(null)
            setCreateConversationProgress(state)
          }
        }
      )
      const conversation = createResult.conversation

      if (createResult.failed.length > 0) {
        const failedLabel = createResult.failed[0]?.pubkey || t('one or more members')
        console.warn('[Chat] invite failures during create', {
          conversationId: conversation.id,
          failed: createResult.failed
        })
        toast.warning(
          t('Chat created, but invite failed for {{member}}', {
            member: failedLabel
          })
        )
      }

      if (imageFile) {
        try {
          setCreateConversationProgress({
            phase: 'uploadingThumbnail',
            uploadProgress: 0
          })
          const upload = await mediaUploadService.upload(
            imageFile,
            {
              onProgress: (progress) => {
                setCreateConversationProgress({
                  phase: 'uploadingThumbnail',
                  uploadProgress: progress
                })
              }
            },
            {
              target: 'group-hyperdrive',
              groupId: conversation.id,
              relayUrl: HYPERDRIVE_UPLOAD_RELAY_URL,
              resourceScope: 'conversation',
              parentKind: 39000
            }
          )
          const imageUrl = upload.url
          if (imageUrl) {
            setCreateConversationProgress({ phase: 'publishingThumbnailMetadata' })
            await updateConversationMetadata({
              conversationId: conversation.id,
              imageUrl,
              imageAttachment: {
                url: upload.url,
                gatewayUrl: null,
                mime: upload.metadata?.mimeType || null,
                size: Number.isFinite(upload.metadata?.size) ? Number(upload.metadata?.size) : null,
                width: Number.isFinite(upload.metadata?.dim?.width)
                  ? Number(upload.metadata?.dim?.width)
                  : null,
                height: Number.isFinite(upload.metadata?.dim?.height)
                  ? Number(upload.metadata?.dim?.height)
                  : null,
                fileName: upload.metadata?.fileName || null,
                sha256: upload.metadata?.sha256 || null,
                driveKey: upload.metadata?.driveKey || null,
                ownerPubkey: normalizePubkey(pubkey || '') || null,
                fileId: upload.metadata?.fileId || null
              }
            })
          }
        } catch (error) {
          console.error('Chat created but thumbnail upload failed', error)
          toast.error(t('Chat created, but thumbnail upload failed'))
        }
      }

      setCreateConversationProgress({ phase: 'openingConversation' })
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
    setJoinInviteProgress({
      inviteId: invite.id,
      phase: 'joiningConversation',
      error: null
    })
    try {
      const result = await acceptInvite(invite.id, {
        onProgress: (state) => {
          if (state.phase === 'error') {
            setJoinInviteProgress((previous) =>
              previous?.inviteId === invite.id
                ? {
                    ...previous,
                    error: state.error || t('Failed to join invite')
                  }
                : previous
            )
            return
          }
          setJoinInviteProgress({
            inviteId: invite.id,
            ...state
          })
        }
      })
      setJoinInviteProgress({
        inviteId: invite.id,
        phase: 'openingConversation',
        error: null
      })
      const conversationId = result.conversationId || invite.conversationId
      if (conversationId) {
        push(`/conversations/${conversationId}`)
      } else {
        setJoinInviteProgress(null)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed joining chat invite', error)
      setJoinInviteProgress((previous) =>
        previous?.inviteId === invite.id
          ? {
              ...previous,
              error: message
            }
          : {
              inviteId: invite.id,
              phase: 'joiningConversation',
              error: message
            }
      )
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
            {unsupportedReason ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                {unsupportedReason}
              </div>
            ) : (
              <ChatListPanel
                myPubkey={pubkey}
                conversations={filteredConversations}
                onOpenConversation={(id) => push(`/conversations/${id}`)}
              />
            )}
          </TabsContent>

          <TabsContent value="invites" className="mt-4">
            {!ready ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                {t('Loading invites...')}
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
                      const activeJoinProgress =
                        joinInviteProgress?.inviteId === invite.id ? joinInviteProgress : null
                      const isJoining = joiningInviteId === invite.id || invite.status === 'joining'
                      const joinDisabled = Boolean(joiningInviteId) || invite.status === 'joining'
                      const dismissDisabled = joiningInviteId === invite.id
                      const joinProgressTitle = getJoinConversationProgressTitle(
                        activeJoinProgress?.phase
                      )
                      const joinProgressDetail = getJoinConversationProgressLabel(
                        activeJoinProgress?.phase
                      )
                      const joinProgressValue = getJoinConversationProgressValue(
                        activeJoinProgress?.phase
                      )
                      const rowError = activeJoinProgress?.error || invite.error
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
                            {activeJoinProgress ? (
                              <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2">
                                <WorkflowProgress
                                  title={joinProgressTitle}
                                  detail={joinProgressDetail}
                                  value={joinProgressValue}
                                />
                              </div>
                            ) : null}
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
        progress={createConversationProgress}
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
  progress,
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
  progress: CreateConversationProgressState | null
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
  const [relayMode, setRelayMode] = useState<RelayPublishMode>('withFallback')
  const wasOpenRef = useRef(false)
  const { profiles: inviteProfiles, isFetching: isSearchingInvites } = useSearchProfiles(
    inviteSearch,
    8
  )
  const inviteCandidateProfiles = useMemo(
    () => inviteProfiles.filter((profile) => profile.pubkey && profile.pubkey !== myPubkey),
    [inviteProfiles, myPubkey]
  )

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
    setImagePreviewUrl(null)
    setSelectedRelayUrls(defaultRelayUrls)
    setRelayMode('withFallback')
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
    setImagePreviewUrl(file ? URL.createObjectURL(file) : null)
  }

  const handleInviteToggle = (pubkey: string) => {
    setSelectedInvitees((prev) =>
      prev.includes(pubkey) ? prev.filter((existing) => existing !== pubkey) : [...prev, pubkey]
    )
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
      relayUrls: selectedRelayUrls,
      relayMode
    })
  }

  const hasThumbnailPreview = Boolean(imagePreviewUrl)
  const progressTitle = getCreateConversationProgressTitle(progress?.phase)
  const progressDetail = getCreateConversationProgressLabel(progress)
  const progressValue = getCreateConversationProgressValue(progress)
  const showProgressSection = Boolean(progress || error)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-xl max-h-[90vh] flex flex-col"
        withoutClose={busy}
        onEscapeKeyDown={busy ? (event) => event.preventDefault() : undefined}
        onInteractOutside={busy ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('Create chat')}</DialogTitle>
          <DialogDescription>
            {t('Choose members, relays, and an optional thumbnail for the new chat.')}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-3 px-1',
            busy && 'pointer-events-none opacity-60'
          )}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('Title') as string}
            className="focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            disabled={busy}
          />
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('Description (optional)') as string}
            className="min-h-[72px] focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            disabled={busy}
          />

          <div className="space-y-2">
            <div className="text-sm font-medium">{t('Invite members')}</div>
            <div className="relative px-0.5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={inviteSearch}
                onChange={(event) => setInviteSearch(event.target.value)}
                placeholder={t('Search users...') as string}
                className="pl-9"
                disabled={busy}
              />
            </div>
            <div
              className={`${hasThumbnailPreview ? 'h-44' : 'h-56'} overflow-y-auto overflow-x-hidden space-y-2 pr-1 rounded border py-2`}
            >
              <div className="min-h-5 px-2 text-sm text-muted-foreground">
                {inviteSearch && isSearchingInvites ? t('Searching...') : null}
                {inviteSearch && !isSearchingInvites && inviteCandidateProfiles.length === 0
                  ? t('No users found')
                  : null}
              </div>
              {inviteCandidateProfiles.map((profile) => {
                const isSelected = selectedInvitees.includes(profile.pubkey)
                return (
                  <div
                    key={profile.pubkey}
                    className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-accent"
                  >
                    <UserAvatar userId={profile.pubkey} className="shrink-0" />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <Username
                        userId={profile.pubkey}
                        className="block w-full min-w-0 truncate font-semibold"
                      />
                      <Nip05 pubkey={profile.pubkey} className="w-full min-w-0" />
                    </div>
                    <Button
                      variant={isSelected ? 'secondary' : 'outline'}
                      size="sm"
                      onClick={() => handleInviteToggle(profile.pubkey)}
                      className="h-8 w-20 shrink-0 px-2"
                      disabled={busy}
                    >
                      {isSelected ? (
                        <>
                          <Check className="w-3 h-3 mr-1" />
                          {t('Added')}
                        </>
                      ) : (
                        <>
                          <UserPlus className="w-3 h-3 mr-1" />
                          {t('Add')}
                        </>
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
            {selectedInvitees.length > 0 ? (
              <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto pr-1">
                {selectedInvitees.map((pubkey) => (
                  <Button
                    key={pubkey}
                    variant="secondary"
                    size="sm"
                    className="flex max-w-full items-center gap-2"
                    onClick={() => handleInviteToggle(pubkey)}
                    disabled={busy}
                  >
                    <UserAvatar userId={pubkey} size="xSmall" />
                    <Username userId={pubkey} className="truncate max-w-[8rem] min-w-0" />
                    <span className="text-xs text-muted-foreground">{t('Remove')}</span>
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <div className="text-sm font-medium">{t('Chat thumbnail (optional)')}</div>
            <Input type="file" accept="image/*" onChange={handleFileChange} disabled={busy} />
            {imagePreviewUrl ? (
              <div className="flex items-center gap-2 rounded-md border p-2">
                <img
                  src={imagePreviewUrl}
                  alt={imageFile?.name || 'Chat thumbnail'}
                  className="h-10 w-10 rounded object-cover"
                />
                <div className="text-xs text-muted-foreground truncate">
                  {t('Selected image')}: {imageFile?.name}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-2 rounded-md border p-3">
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
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">{t('Discovery relay fallback')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('Also publish chat events to discovery relays')}
                </div>
              </div>
              <Switch
                checked={relayMode === 'withFallback'}
                onCheckedChange={(checked) => setRelayMode(checked ? 'withFallback' : 'strict')}
                disabled={busy}
              />
            </div>
          </div>
        </div>

        {showProgressSection ? (
          <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
            <WorkflowProgress title={progressTitle} detail={progressDetail} value={progressValue} />
            {error ? <div className="text-sm text-red-500">{error}</div> : null}
          </div>
        ) : null}

        <DialogFooter className="flex shrink-0 justify-end gap-2 border-t pt-3">
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
      </DialogContent>
    </Dialog>
  )
}
