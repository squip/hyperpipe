import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GROUP_PAGE_PRESENCE_TTL_MS, useGroupPresence } from '@/hooks/useGroupPresence'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useGroups } from '@/providers/GroupsProvider'
import { TFeedSubRequest, TPageRef } from '@/types'
import { useTranslation } from 'react-i18next'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { Event as NostrEvent } from '@jsr/nostr__tools/wasm'
import {
  Users,
  Loader2,
  LogOut,
  Settings,
  Copy,
  Check,
  Search,
  UserPlus,
  EllipsisVertical,
  Pin,
  BellOff,
  TriangleAlert,
  X
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import UserAvatar from '@/components/UserAvatar'
import Username from '@/components/Username'
import NormalFeed from '@/components/NormalFeed'
import GroupFilesList from '@/components/GroupFilesList'
import { BIG_RELAY_URLS } from '@/constants'
import { buildPrivateGroupLeaveShadowRef, parseGroupIdentifier } from '@/lib/groups'
import { getBaseRelayUrl } from '@/lib/hyperpipe-group-events'
import client from '@/services/client.service'
import relayMembershipService from '@/services/relay-membership.service'
import { useSecondaryPage } from '@/PageManager'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { useNostr } from '@/providers/NostrProvider'
import { isElectron } from '@/lib/platform'
import PostEditor from '@/components/PostEditor'
import GroupMetadataEditor, { TGroupMetadataForm } from '@/components/GroupMetadataEditor'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useSearchProfiles } from '@/hooks/useSearchProfiles'
import FollowButton from '@/components/FollowButton'
import Nip05 from '@/components/Nip05'
import { useMuteList } from '@/providers/MuteListProvider'
import ReportDialog from '@/components/NoteOptions/ReportDialog'
import localStorageService from '@/services/local-storage.service'
import * as nip19 from '@jsr/nostr__tools/nip19'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { SimpleUsername } from '@/components/Username'
import { generateImageByPubkey } from '@/lib/pubkey'
import React from 'react'
import { TJoinRequest } from '@/types/groups'
import { registerClosedJoinSimulator } from '@/devtools/closedJoinSimulator'
import HyperpipeJoinFlowProgress from '@/components/HyperpipeJoinFlowProgress'
import { formatJoinFlowErrorMessage } from '@/lib/join-flow-ui'
// import { registerJoinWorkflowSimulator } from '@/devtools/joinWorkflowSimulator'

type TJoinFlowHintFields = {
  discoveryTopic?: string | null
  gatewayId?: string | null
  gatewayOrigin?: string | null
  directJoinOnly?: boolean
  hostPeerKeys?: string[]
  leaseReplicaPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  writerLeaseEnvelope?: Record<string, unknown> | null
}

const RELAY_SUBSCRIPTION_REFRESH_NO_CLIENT_RETRY_ATTEMPTS = 6
const RELAY_SUBSCRIPTION_REFRESH_RETRY_BASE_DELAY_MS = 250
const RELAY_SUBSCRIPTION_REFRESH_RETRY_MAX_DELAY_MS = 1500
const GROUP_PAGE_FEED_GROUP_KINDS = [
  39000, 39001, 39002, 39003, 9000, 9001, 9002, 9005, 9007, 9008, 9009, 9021, 9022
]
const GROUP_PAGE_FEED_TIMELINE_KINDS = [
  1, 6, 20, 21, 22, 1063, 1068, 1111, 1222, 1244, 9802, 30023, 31987, 39089
]
const GROUP_PAGE_FEED_ALL_KINDS = [
  ...GROUP_PAGE_FEED_GROUP_KINDS,
  ...GROUP_PAGE_FEED_TIMELINE_KINDS
]

function toJoinFlowHintFields(value: unknown): TJoinFlowHintFields {
  if (!value || typeof value !== 'object') return {}
  return value as TJoinFlowHintFields
}

function getRefreshRelayReasonCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const topReason = (value as { reason?: unknown }).reason
  if (typeof topReason === 'string' && topReason.trim()) return topReason.trim()
  const nested = (value as { result?: unknown }).result
  if (!nested || typeof nested !== 'object') return null
  const nestedReason = (nested as { reason?: unknown }).reason
  if (typeof nestedReason === 'string' && nestedReason.trim()) return nestedReason.trim()
  return null
}

function GroupPresenceChip({
  count,
  status,
  t
}: {
  count: number | null
  status: 'idle' | 'scanning' | 'ready' | 'error' | 'unknown'
  t: (key: string, opts?: any) => string
}) {
  if (status === 'scanning') {
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground">
          {t('Scanning for peers…')}
        </span>
      </div>
    )
  }

  if (status !== 'ready' || !Number.isFinite(count)) {
    return null
  }

  const resolvedCount = Math.max(0, Number(count))
  const dotClass = resolvedCount > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40'

  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1">
      <span className={`inline-flex h-2.5 w-2.5 rounded-full ${dotClass}`} />
      <span className="text-xs font-semibold text-muted-foreground">
        {resolvedCount} {resolvedCount === 1 ? t('peer online') : t('peers online')}
      </span>
    </div>
  )
}

type MemberActionsMenuProps = {
  targetPubkey: string
  showGrantAdmin: boolean
  showRemove?: boolean
  actionsDisabled?: boolean
  onGrantAdmin: (pubkey: string) => void
  onReportUser: (pubkey: string) => void
  onMutePrivately: (pubkey: string) => void
  onMutePublicly: (pubkey: string) => void
  onRemove?: (pubkey: string) => void
  t: (key: string, opts?: any) => string
}

function MemberActionsMenu({
  targetPubkey,
  showGrantAdmin,
  showRemove,
  actionsDisabled,
  onGrantAdmin,
  onReportUser,
  onMutePrivately,
  onMutePublicly,
  onRemove,
  t
}: MemberActionsMenuProps) {
  const [open, setOpen] = React.useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-lg [&_svg]:size-5"
          onClick={(e) => e.stopPropagation()}
          disabled={actionsDisabled}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="p-1 scrollbar-hide max-h-[50vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {showGrantAdmin && (
          <DropdownMenuItem
            onClick={() => onGrantAdmin(targetPubkey)}
            className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md"
            disabled={actionsDisabled}
          >
            <Pin className="w-4 h-4" />
            {t('Grant admin permissions')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onReportUser(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <TriangleAlert className="w-4 h-4" />
          {t('Report')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onMutePrivately(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <BellOff className="w-4 h-4" />
          {t('Mute user privately')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onMutePublicly(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <BellOff className="w-4 h-4" />
          {t('Mute user publicly')}
        </DropdownMenuItem>
        {showRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onRemove?.(targetPubkey)}
              className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
              disabled={actionsDisabled}
            >
              <LogOut className="w-4 h-4" />
              {t('Remove member')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type MemberRowProps = {
  memberPubkey: string
  isSelf: boolean
  showGrantAdmin: boolean
  canMute: boolean
  nostrProfile: any
  pubkey?: string | null
  onGrantAdmin: (pubkey: string) => void
  onReportUser: (pubkey: string) => void
  onMutePrivately: (pubkey: string) => void
  onMutePublicly: (pubkey: string) => void
  onRemove?: (pubkey: string) => void
  t: (key: string, opts?: any) => string
}

function MemberRowComponent({
  memberPubkey,
  isSelf,
  showGrantAdmin,
  canMute,
  nostrProfile,
  pubkey,
  onGrantAdmin,
  onReportUser,
  onMutePrivately,
  onMutePublicly,
  onRemove,
  t
}: MemberRowProps) {
  const actionsDisabled = isSelf
  const selfProfile =
    isSelf && pubkey
      ? nostrProfile || {
          pubkey,
          metadata: { picture: generateImageByPubkey(pubkey) }
        }
      : null

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-transparent hover:border-border hover:bg-accent/30">
      {isSelf ? (
        <>
          <SimpleUserAvatar
            userId={memberPubkey}
            profile={selfProfile || undefined}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1">
            <SimpleUsername
              userId={memberPubkey}
              profile={selfProfile || undefined}
              className="font-semibold truncate max-w-full w-fit"
              withoutSkeleton
            />
            <Nip05 pubkey={memberPubkey} profile={selfProfile || undefined} />
          </div>
        </>
      ) : (
        <>
          <UserAvatar userId={memberPubkey} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <Username userId={memberPubkey} className="font-semibold truncate max-w-full w-fit" />
            <Nip05 pubkey={memberPubkey} />
          </div>
        </>
      )}
      <div className="flex items-center gap-2 flex-shrink-0">
        {!isSelf ? (
          <>
            <FollowButton pubkey={memberPubkey} />
            {(canMute || actionsDisabled) && (
              <MemberActionsMenu
                targetPubkey={memberPubkey}
                showGrantAdmin={showGrantAdmin}
                showRemove={showGrantAdmin}
                actionsDisabled={actionsDisabled}
                onGrantAdmin={onGrantAdmin}
                onReportUser={onReportUser}
                onMutePrivately={onMutePrivately}
                onMutePublicly={onMutePublicly}
                onRemove={onRemove}
                t={t}
              />
            )}
          </>
        ) : (
          <>
            <Button className="rounded-full min-w-28" variant="outline" size="sm" disabled>
              {t('Follow')}
            </Button>
            <MemberActionsMenu
              targetPubkey={memberPubkey}
              showGrantAdmin={false}
              showRemove={false}
              actionsDisabled
              onGrantAdmin={onGrantAdmin}
              onReportUser={onReportUser}
              onMutePrivately={onMutePrivately}
              onMutePublicly={onMutePublicly}
              onRemove={onRemove}
              t={t}
            />
          </>
        )}
      </div>
    </div>
  )
}

const MemoizedMemberRow = React.memo(
  MemberRowComponent,
  (prev, next) =>
    prev.memberPubkey === next.memberPubkey &&
    prev.isSelf === next.isSelf &&
    prev.showGrantAdmin === next.showGrantAdmin &&
    prev.canMute === next.canMute &&
    prev.nostrProfile === next.nostrProfile &&
    prev.pubkey === next.pubkey &&
    prev.onGrantAdmin === next.onGrantAdmin &&
    prev.onReportUser === next.onReportUser &&
    prev.onMutePrivately === next.onMutePrivately &&
    prev.onMutePublicly === next.onMutePublicly &&
    prev.onRemove === next.onRemove &&
    prev.t === next.t
)

type JoinRequestRowProps = {
  request: TJoinRequest
  onApprove: (request: TJoinRequest) => void
  onReject: (request: TJoinRequest) => void
  approving?: boolean
  rejecting?: boolean
  t: (key: string, opts?: any) => string
}

function JoinRequestRow({
  request,
  onApprove,
  onReject,
  approving,
  rejecting,
  t
}: JoinRequestRowProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-transparent hover:border-border hover:bg-accent/30">
      <UserAvatar userId={request.pubkey} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <Username userId={request.pubkey} className="font-semibold truncate max-w-full w-fit" />
        <Nip05 pubkey={request.pubkey} />
        {request.content && (
          <div className="text-xs text-muted-foreground line-clamp-2 mt-1">{request.content}</div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onReject(request)}
          disabled={rejecting || approving}
          className="rounded-full"
        >
          <X className="w-4 h-4 mr-1" />
          {rejecting ? t('Rejecting...') : t('Reject')}
        </Button>
        <Button
          size="sm"
          onClick={() => onApprove(request)}
          disabled={approving || rejecting}
          className="rounded-full"
        >
          <Check className="w-4 h-4 mr-1" />
          {approving ? t('Sending invite...') : t('Send invite')}
        </Button>
      </div>
    </div>
  )
}

type TGroupPageProps = {
  index?: number
  id?: string
  relay?: string
}

const makeGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

const normalizeComparablePubkeys = (values: string[]) =>
  [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))].sort()

const areComparablePubkeysEqual = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

const isSuspiciousAdminOnlySelfDetailDowngrade = (args: {
  prevMembers: string[]
  nextMembers: string[]
  prevAdmins: string[]
  nextAdmins: string[]
  prevMetadataPubkey?: string | null
  nextMetadataPubkey?: string | null
  pubkey?: string | null
  membershipAuthoritative?: boolean
  membershipFetchSource?: string | null
  membershipEventsCount?: number
}) => {
  const pubkey = String(args.pubkey || '').trim()
  if (!pubkey) return false
  if (!args.membershipAuthoritative) return false
  if (args.membershipFetchSource !== 'group-relay') return false
  if (Number(args.membershipEventsCount || 0) > 0) return false
  if (args.prevMembers.length <= 1) return false
  if (args.nextMembers.length !== 1 || args.nextMembers[0] !== pubkey) return false

  const isCreatorOrAdmin =
    args.nextAdmins.includes(pubkey) ||
    args.prevAdmins.includes(pubkey) ||
    String(args.nextMetadataPubkey || '').trim() === pubkey ||
    String(args.prevMetadataPubkey || '').trim() === pubkey

  return isCreatorOrAdmin
}

const CLOSED_GROUP_JOIN_PENDING_STORAGE_PREFIX = 'hyperpipe_group_closed_join_pending_v1'

const normalizePubkeyList = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>()
  const normalized: string[] = []
  values.forEach((value) => {
    const next = String(value || '').trim()
    if (!next || seen.has(next)) return
    seen.add(next)
    normalized.push(next)
  })
  return normalized
}

const toClosedGroupJoinPendingStorageKey = (args: {
  pubkey?: string | null
  groupId?: string
  relay?: string | null
}) => {
  const accountKey = args.pubkey ? String(args.pubkey).trim() : 'anonymous'
  const groupKey = String(args.groupId || '').trim() || 'unknown-group'
  const relayValue = String(args.relay || '').trim()
  const relayKey = relayValue ? getBaseRelayUrl(relayValue) : 'unknown-relay'
  return `${CLOSED_GROUP_JOIN_PENDING_STORAGE_PREFIX}:${accountKey}:${groupKey}:${relayKey}`
}

const GroupPage = forwardRef<TPageRef, TGroupPageProps>(({ index, id, relay }, ref) => {
  const { t } = useTranslation()
  const {
    discoveryGroups,
    fetchGroupDetail,
    getProvisionalGroupMetadata,
    getGroupMemberPreview,
    hydrateGroupMemberPreview,
    sendJoinRequest,
    leaveGroup,
    invites,
    sendInvites,
    joinRequests,
    joinRequestsError,
    loadJoinRequests,
    approveJoinRequest,
    rejectJoinRequest,
    updateMetadata,
    grantAdmin,
    removeUser,
    resolveRelayUrl,
    myGroupList
  } = useGroups()
  const { pubkey, profile: nostrProfile } = useNostr()
  const {
    joinFlows,
    startJoinFlow,
    relays,
    sendToWorker,
    relayServerReady,
    refreshRelaySubscriptions
  } = useWorkerBridge()
  const { pop } = useSecondaryPage()
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'notes' | 'files' | 'members' | 'requests'>('notes')
  const [groupFileCount, setGroupFileCount] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [groupRelay, setGroupRelay] = useState<string | undefined>(relay)
  const [groupId, setGroupId] = useState<string | undefined>(id)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchGroupDetail>> | null>(null)
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [isMetadataDialogOpen, setIsMetadataDialogOpen] = useState(false)
  const [isSavingMeta, setIsSavingMeta] = useState(false)
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false)
  const [isLeavingGroup, setIsLeavingGroup] = useState(false)
  const [leaveSaveRelaySnapshot, setLeaveSaveRelaySnapshot] = useState(true)
  const [leaveSaveSharedFiles, setLeaveSaveSharedFiles] = useState(true)
  const [adminLeaveNotice, setAdminLeaveNotice] = useState<{
    eventId: string
    pubkey: string
  } | null>(null)
  const [adminLeavePollTick, setAdminLeavePollTick] = useState(0)
  const [copiedRelayUrl, setCopiedRelayUrl] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false)
  const [inviteSearch, setInviteSearch] = useState('')
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([])
  const [reportTarget, setReportTarget] = useState<string | null>(null)
  const [joinRequestAction, setJoinRequestAction] = useState<{
    pubkey: string
    action: 'approve' | 'reject'
  } | null>(null)
  const [joinRelayRefreshNonce, setJoinRelayRefreshNonce] = useState(0)
  const [closedJoinRequestPending, setClosedJoinRequestPending] = useState(false)
  const { profiles: inviteProfiles, isFetching: isSearchingInvites } = useSearchProfiles(
    inviteSearch,
    8
  )
  const { mutePrivately, mutePublicly } = useMuteList()
  const reportEvent = useMemo(() => {
    if (!reportTarget) return null
    return {
      id: reportTarget,
      pubkey: reportTarget,
      kind: 0,
      tags: [],
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      sig: ''
    } as NostrEvent
  }, [reportTarget])
  const requestIdRef = useRef(0)
  const autoPopKeyRef = useRef<string | null>(null)
  const trackedGroupIdRef = useRef<string | undefined>(undefined)
  const previousIsInMyGroupsRef = useRef(false)
  const lastRouteSubscriptionRefreshRef = useRef<string | null>(null)
  const groupRelayWarmupKeyRef = useRef<string | null>(null)
  const lastWritableRefreshKeyRef = useRef<string | null>(null)
  const hydrateCursorResetKeyRef = useRef<string | null>(null)
  const relaySubscriptionRefreshThrottleRef = useRef<Map<string, number>>(new Map())

  const requestRelaySubscriptionRefresh = React.useCallback(
    ({
      relayKey,
      publicIdentifier,
      reason,
      minIntervalMs = 1500,
      retryOnNoClients = true
    }: {
      relayKey?: string | null
      publicIdentifier?: string | null
      reason: string
      minIntervalMs?: number
      retryOnNoClients?: boolean
    }) => {
      const normalizedPublicIdentifier =
        typeof publicIdentifier === 'string' && publicIdentifier.trim()
          ? publicIdentifier.trim()
          : null
      const normalizedRelayKey =
        typeof relayKey === 'string' && relayKey.trim() ? relayKey.trim() : null
      if (!normalizedPublicIdentifier && !normalizedRelayKey) return false
      if (!relayServerReady) return false

      const key = `${normalizedPublicIdentifier || ''}|${normalizedRelayKey || ''}`
      const now = Date.now()
      const lastSentAt = relaySubscriptionRefreshThrottleRef.current.get(key) || 0
      if (now - lastSentAt < minIntervalMs) return false
      relaySubscriptionRefreshThrottleRef.current.set(key, now)
      if (relaySubscriptionRefreshThrottleRef.current.size > 64) {
        const pruneBefore = now - 30_000
        for (const [entryKey, ts] of relaySubscriptionRefreshThrottleRef.current.entries()) {
          if (ts < pruneBefore) relaySubscriptionRefreshThrottleRef.current.delete(entryKey)
        }
      }

      const attemptRefresh = async (attempt: number): Promise<void> => {
        const attemptReason = attempt === 1 ? reason : `${reason}:retry-${attempt}`
        try {
          const refreshResult = await refreshRelaySubscriptions({
            relayKey: normalizedRelayKey,
            publicIdentifier: normalizedPublicIdentifier,
            reason: attemptReason,
            timeoutMs: 12_000
          })
          const refreshReasonCode = getRefreshRelayReasonCode(refreshResult)
          const shouldRetryNoClients =
            retryOnNoClients &&
            refreshReasonCode === 'no-clients' &&
            attempt < RELAY_SUBSCRIPTION_REFRESH_NO_CLIENT_RETRY_ATTEMPTS
          if (shouldRetryNoClients) {
            const retryDelayMs = Math.min(
              RELAY_SUBSCRIPTION_REFRESH_RETRY_MAX_DELAY_MS,
              RELAY_SUBSCRIPTION_REFRESH_RETRY_BASE_DELAY_MS * attempt
            )
            window.setTimeout(() => {
              void attemptRefresh(attempt + 1)
            }, retryDelayMs)
          }
        } catch (_error) {
          if (attempt >= RELAY_SUBSCRIPTION_REFRESH_NO_CLIENT_RETRY_ATTEMPTS) return
          const retryDelayMs = Math.min(
            RELAY_SUBSCRIPTION_REFRESH_RETRY_MAX_DELAY_MS,
            RELAY_SUBSCRIPTION_REFRESH_RETRY_BASE_DELAY_MS * attempt
          )
          window.setTimeout(() => {
            void attemptRefresh(attempt + 1)
          }, retryDelayMs)
        }
      }
      void attemptRefresh(1)
      return true
    },
    [refreshRelaySubscriptions, relayServerReady]
  )

  const myGroupRelay = useMemo(
    () => (groupId ? myGroupList.find((entry) => entry.groupId === groupId)?.relay : undefined),
    [groupId, myGroupList]
  )
  const isInMyGroups = useMemo(
    () => !!(groupId && myGroupList.some((entry) => entry.groupId === groupId)),
    [groupId, myGroupList]
  )

  useEffect(() => {
    if (!groupId) {
      trackedGroupIdRef.current = undefined
      previousIsInMyGroupsRef.current = false
      autoPopKeyRef.current = null
      return
    }

    const nextPopKey = `${groupId}|${pubkey || ''}`
    const groupChanged = trackedGroupIdRef.current !== groupId
    if (groupChanged) {
      trackedGroupIdRef.current = groupId
      previousIsInMyGroupsRef.current = isInMyGroups
      autoPopKeyRef.current = null
      return
    }

    const lostMembership = previousIsInMyGroupsRef.current && !isInMyGroups
    if (lostMembership && autoPopKeyRef.current !== nextPopKey) {
      autoPopKeyRef.current = nextPopKey
      window.setTimeout(() => pop(), 0)
    }

    previousIsInMyGroupsRef.current = isInMyGroups
  }, [groupId, isInMyGroups, pop, pubkey])

  const workerRelayEntryForGroup = useMemo(() => {
    if (!groupId || !relays?.length) return null
    const candidates = new Set<string>()
    candidates.add(groupId)
    candidates.add(groupId.replace(':', '/'))
    candidates.add(groupId.replace('/', ':'))
    return (
      relays.find(
        (entry) =>
          (entry.publicIdentifier && candidates.has(entry.publicIdentifier)) ||
          (entry.relayKey && candidates.has(entry.relayKey))
      ) || null
    )
  }, [groupId, relays])
  const effectiveGroupRelay = useMemo(() => groupRelay || myGroupRelay, [groupRelay, myGroupRelay])
  const provisionalMeta = useMemo(
    () => (groupId ? getProvisionalGroupMetadata(groupId, effectiveGroupRelay) : null),
    [effectiveGroupRelay, getProvisionalGroupMetadata, groupId]
  )
  const fallbackMeta = useMemo(() => {
    const discoveryMeta = discoveryGroups.find(
      (g) =>
        g.id === groupId && (!effectiveGroupRelay || !g.relay || g.relay === effectiveGroupRelay)
    )
    return discoveryMeta || provisionalMeta || undefined
  }, [discoveryGroups, effectiveGroupRelay, groupId, provisionalMeta])

  useEffect(() => {
    const searchRelay =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('r') || undefined
        : undefined
    const parsed = parseGroupIdentifier(id || '')
    setGroupRelay(parsed.relay ?? relay ?? searchRelay)
    setGroupId(parsed.groupId || id)
  }, [id, relay])

  useEffect(() => {
    if (!groupId) return
    hydrateGroupMemberPreview(groupId, effectiveGroupRelay).catch(() => {})
  }, [effectiveGroupRelay, groupId, hydrateGroupMemberPreview])

  useEffect(() => {
    if (!groupId) return
    const requestId = ++requestIdRef.current
    setIsLoading(false) // allow showing cached data immediately
    setError(null)
    fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true })
      .then((d) => {
        // Ignore stale responses
        if (requestId !== requestIdRef.current) return
        setDetail((prev) => {
          if (!d) return prev
          const normalizeMembers = (members?: any[]) =>
            (members || [])
              .map((m) => (typeof m === 'string' ? m : m?.pubkey))
              .filter(Boolean) as string[]
          const normalizeAdmins = (admins?: any[]) =>
            (admins || [])
              .map((admin) => String(admin?.pubkey || '').trim())
              .filter(Boolean) as string[]

          d.members = normalizeMembers(d.members)
          const normalizedPrevMembers = normalizeMembers(prev?.members)

          const isSameGroup = (prev?.metadata?.id || groupId) === groupId
          const next = { ...d }
          const isIncomingEmpty =
            !next.metadata &&
            (!next.admins || next.admins.length === 0) &&
            (!next.members || next.members.length === 0)
          if (isSameGroup && prev?.metadata && isIncomingEmpty) {
            return prev
          }
          // Preserve previous data if new fetch is empty/undefined
          // If incoming metadata is older than cached, keep the newer one
          const prevMetadata = prev?.metadata
          const prevMetaTsCached = prevMetadata?.event?.created_at || 0
          const nextMetaTs = next?.metadata?.event?.created_at || 0
          if (
            isSameGroup &&
            prevMetadata &&
            prevMetaTsCached > 0 &&
            nextMetaTs > 0 &&
            nextMetaTs < prevMetaTsCached
          ) {
            next.metadata = prevMetadata
          }
          const metaCandidates = [next.metadata, prevMetadata, fallbackMeta].filter(
            Boolean
          ) as (typeof next.metadata)[]
          const bestMeta = metaCandidates.sort(
            (a, b) => (b?.event?.created_at || 0) - (a?.event?.created_at || 0)
          )[0]
          if (bestMeta) {
            const pictureFromBestOrFallback =
              bestMeta.picture || metaCandidates.find((m) => m?.picture)?.picture
            next.metadata = { ...bestMeta, picture: pictureFromBestOrFallback || bestMeta.picture }
          }
          if (isSameGroup && prevMetadata?.picture && (!next?.metadata || !next.metadata.picture)) {
            next.metadata = {
              ...next.metadata,
              picture: prevMetadata.picture,
              id: next.metadata?.id || prevMetadata.id,
              relay: next.metadata?.relay || prevMetadata.relay,
              name: next.metadata?.name ?? prevMetadata.name,
              about: next.metadata?.about ?? prevMetadata.about,
              isOpen: next.metadata?.isOpen ?? prevMetadata.isOpen,
              isPublic: next.metadata?.isPublic ?? prevMetadata.isPublic,
              tags: next.metadata?.tags ?? prevMetadata.tags,
              event: next.metadata?.event || prevMetadata.event
            }
          }
          if (!next.metadata && isSameGroup && prevMetadata) next.metadata = prevMetadata
          if ((!next.admins || !next.admins.length) && isSameGroup && prev?.admins?.length) {
            next.admins = prev.admins
          }
          if (
            (!next.members || !next.members.length) &&
            isSameGroup &&
            normalizedPrevMembers?.length
          ) {
            next.members = normalizedPrevMembers
          }
          const nextMembers = normalizeMembers(next.members)
          const shouldBlockMembershipDowngrade =
            isSameGroup &&
            normalizedPrevMembers.length > 0 &&
            nextMembers.length < normalizedPrevMembers.length &&
            !next.membershipAuthoritative &&
            (next.membershipFetchTimedOutLike ||
              (nextMembers.length === 1 && pubkey ? nextMembers[0] === pubkey : false))
          const normalizedPrevAdmins = normalizeAdmins(prev?.admins)
          const normalizedNextAdmins = normalizeAdmins(next.admins)
          const shouldBlockSuspiciousAdminDowngrade =
            isSameGroup &&
            isSuspiciousAdminOnlySelfDetailDowngrade({
              prevMembers: normalizedPrevMembers,
              nextMembers,
              prevAdmins: normalizedPrevAdmins,
              nextAdmins: normalizedNextAdmins,
              prevMetadataPubkey: prevMetadata?.event?.pubkey,
              nextMetadataPubkey: next.metadata?.event?.pubkey,
              pubkey,
              membershipAuthoritative: next.membershipAuthoritative,
              membershipFetchSource: next.membershipFetchSource || null,
              membershipEventsCount: next.membershipEventsCount || 0
            })
          if (shouldBlockMembershipDowngrade) {
            next.members = normalizedPrevMembers
            if (prev?.membershipStatus) {
              next.membershipStatus = prev.membershipStatus
            }
          }
          if (shouldBlockSuspiciousAdminDowngrade) {
            console.warn('[GroupPage] Preserving previous member list over suspicious admin self-only relay snapshot', {
              groupId,
              previousCount: normalizedPrevMembers.length,
              incomingCount: nextMembers.length,
              membershipFetchSource: next.membershipFetchSource || null
            })
            next.members = normalizedPrevMembers
            next.membershipAuthoritative = false
            if (prev?.membershipStatus) {
              next.membershipStatus = prev.membershipStatus
            }
          }
          if (
            (!next.membershipStatus ||
              (next.membershipStatus === 'not-member' &&
                isSameGroup &&
                prev?.membershipStatus === 'member' &&
                (!next.members || next.members.length === 0))) &&
            prev?.membershipStatus
          ) {
            next.membershipStatus = prev.membershipStatus
          }
          if (isInMyGroups) {
            next.membershipStatus = 'member'
            if (pubkey) {
              const hasSelf = next.members?.some((m) => m === pubkey)
              if (!hasSelf) {
                next.members = [...(next.members || []), pubkey]
              }
            }
          }

          const prevComparableMembers = normalizeComparablePubkeys(normalizeMembers(prev?.members))
          const nextComparableMembers = normalizeComparablePubkeys(normalizeMembers(next.members))
          const prevComparableAdmins = normalizeComparablePubkeys(normalizedPrevAdmins)
          const nextComparableAdmins = normalizeComparablePubkeys(normalizedNextAdmins)
          const sameMembers = areComparablePubkeysEqual(
            prevComparableMembers,
            nextComparableMembers
          )
          const sameAdmins = areComparablePubkeysEqual(prevComparableAdmins, nextComparableAdmins)
          const sameMembership =
            (prev?.membershipStatus || 'not-member') === (next.membershipStatus || 'not-member') &&
            !!prev?.membershipAuthoritative === !!next.membershipAuthoritative &&
            (prev?.membershipEventsCount || 0) === (next.membershipEventsCount || 0) &&
            (prev?.membersFromEventCount || 0) === (next.membersFromEventCount || 0) &&
            (prev?.membersSnapshotCreatedAt || null) === (next.membersSnapshotCreatedAt || null) &&
            !!prev?.membershipFetchTimedOutLike === !!next.membershipFetchTimedOutLike &&
            (prev?.membershipFetchSource || null) === (next.membershipFetchSource || null)
          const prevMetaId = prev?.metadata?.event?.id || null
          const nextMetaId = next.metadata?.event?.id || null
          const sameMetadata =
            prevMetaId === nextMetaId &&
            (prev?.metadata?.picture || null) === (next.metadata?.picture || null) &&
            (prev?.metadata?.name || null) === (next.metadata?.name || null) &&
            (prev?.metadata?.about || null) === (next.metadata?.about || null)
          if (isSameGroup && sameMembers && sameAdmins && sameMembership && sameMetadata) {
            return prev || next
          }

          return next
        })
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setIsLoading(false))
  }, [effectiveGroupRelay, fallbackMeta, fetchGroupDetail, groupId, isInMyGroups, pubkey])

  const groupKey = useMemo(
    () => makeGroupKey(groupId || '', effectiveGroupRelay),
    [groupId, effectiveGroupRelay]
  )
  const pendingJoinRequests = useMemo(
    () => (groupKey && joinRequests[groupKey] ? joinRequests[groupKey] : []),
    [groupKey, joinRequests]
  )
  const joinRequestCount = pendingJoinRequests.length

  const inviteData = useMemo(() => {
    return invites.find(
      (inv) =>
        inv.groupId === groupId &&
        (!effectiveGroupRelay || !inv.relay || inv.relay === effectiveGroupRelay)
    )
  }, [invites, groupId, effectiveGroupRelay])
  const inviteToken = inviteData?.token
  const hasInviteJoinData =
    !!inviteData?.token ||
    !!inviteData?.blindPeer?.publicKey ||
    (Array.isArray(inviteData?.cores) && inviteData.cores.length > 0) ||
    !!inviteData?.relayKey ||
    !!inviteData?.relayUrl

  const joinFlow = useMemo(() => {
    const id = groupId || ''
    return id ? joinFlows[id] : undefined
  }, [groupId, joinFlows])

  useEffect(() => {
    if (!groupId) return
    if (!joinFlow?.writableAt || !joinFlow?.writable) return
    const writableRefreshKey = `${groupId}|${joinFlow.relayKey || ''}|${joinFlow.mode || ''}|${joinFlow.writableAt}`
    if (lastWritableRefreshKeyRef.current === writableRefreshKey) return
    const requested = requestRelaySubscriptionRefresh({
      relayKey: joinFlow.relayKey || null,
      publicIdentifier: groupId,
      reason: 'group-page-join-writable',
      minIntervalMs: 1200,
      retryOnNoClients: true
    })
    if (!requested) return
    lastWritableRefreshKeyRef.current = writableRefreshKey
    setJoinRelayRefreshNonce((prev) => prev + 1)
  }, [
    groupId,
    joinFlow?.mode,
    joinFlow?.relayKey,
    joinFlow?.relayUrl,
    joinFlow?.writable,
    joinFlow?.writableAt,
    requestRelaySubscriptionRefresh
  ])

  const resolvedGroupRelay = useMemo(() => {
    return effectiveGroupRelay ? resolveRelayUrl(effectiveGroupRelay) : undefined
  }, [effectiveGroupRelay, resolveRelayUrl])

  const [pinnedGroupRelay, setPinnedGroupRelay] = useState<string | null>(null)

  useEffect(() => {
    setPinnedGroupRelay(null)
    lastWritableRefreshKeyRef.current = null
    hydrateCursorResetKeyRef.current = null
  }, [groupKey])

  const isTokenizedRelayUrl = (relay?: string) => {
    if (!relay) return false
    try {
      const parsed = new URL(relay)
      return parsed.searchParams.has('token')
    } catch (_err) {
      return /[?&]token=/.test(relay)
    }
  }

  const isLocalRelayProxyUrl = (relay?: string) => {
    if (!relay) return false
    try {
      const parsed = new URL(relay)
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    } catch (_err) {
      return /^wss?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(relay)
    }
  }

  const tokenizedResolvedGroupRelay = useMemo(() => {
    return isTokenizedRelayUrl(resolvedGroupRelay) ? resolvedGroupRelay : undefined
  }, [resolvedGroupRelay])

  useEffect(() => {
    if (!tokenizedResolvedGroupRelay) return
    setPinnedGroupRelay((prev) =>
      prev === tokenizedResolvedGroupRelay ? prev : tokenizedResolvedGroupRelay
    )
  }, [tokenizedResolvedGroupRelay])

  const fallbackGroupRelay = useMemo(
    () => resolvedGroupRelay || effectiveGroupRelay || undefined,
    [effectiveGroupRelay, resolvedGroupRelay]
  )

  const activeGroupRelay = pinnedGroupRelay || tokenizedResolvedGroupRelay || fallbackGroupRelay
  const relayRequiresAuth = workerRelayEntryForGroup?.requiresAuth === true
  const relayHasAuthToken =
    isTokenizedRelayUrl(activeGroupRelay) ||
    isTokenizedRelayUrl(resolvedGroupRelay) ||
    isTokenizedRelayUrl(workerRelayEntryForGroup?.connectionUrl)
  const relayCandidateForGating =
    activeGroupRelay ||
    resolvedGroupRelay ||
    effectiveGroupRelay ||
    workerRelayEntryForGroup?.connectionUrl
  const shouldWaitForAuthRelay = Boolean(groupId && relayRequiresAuth && !relayHasAuthToken)
  const shouldWaitForLocalRelayReady = Boolean(
    groupId && isElectron() && isLocalRelayProxyUrl(relayCandidateForGating) && !relayServerReady
  )
  const publishReadyRelay =
    shouldWaitForAuthRelay || shouldWaitForLocalRelayReady
      ? undefined
      : activeGroupRelay || resolvedGroupRelay || effectiveGroupRelay

  useEffect(() => {
    if (!isComposerOpen) return
    if (publishReadyRelay) return
    setIsComposerOpen(false)
  }, [isComposerOpen, publishReadyRelay])

  const closedJoinPendingStorageKey = useMemo(
    () =>
      toClosedGroupJoinPendingStorageKey({
        pubkey,
        groupId,
        relay: activeGroupRelay || resolvedGroupRelay || effectiveGroupRelay || null
      }),
    [activeGroupRelay, effectiveGroupRelay, groupId, pubkey, resolvedGroupRelay]
  )

  useEffect(() => {
    if (!groupId || typeof window === 'undefined') {
      setClosedJoinRequestPending(false)
      return
    }
    try {
      setClosedJoinRequestPending(window.localStorage.getItem(closedJoinPendingStorageKey) === '1')
    } catch (_err) {
      setClosedJoinRequestPending(false)
    }
  }, [closedJoinPendingStorageKey, groupId])

  const markClosedJoinRequestPending = React.useCallback(() => {
    if (!groupId) return
    setClosedJoinRequestPending(true)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(closedJoinPendingStorageKey, '1')
    } catch (_err) {
      // best effort
    }
  }, [closedJoinPendingStorageKey, groupId])

  const clearClosedJoinRequestPending = React.useCallback(() => {
    setClosedJoinRequestPending(false)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(closedJoinPendingStorageKey)
    } catch (_err) {
      // best effort
    }
  }, [closedJoinPendingStorageKey])

  const shouldGateGroupSubRequests = Boolean(
    groupId &&
      (shouldWaitForAuthRelay ||
        shouldWaitForLocalRelayReady ||
        (!activeGroupRelay && BIG_RELAY_URLS.length === 0))
  )
  const shouldWarmHydrateLocalGroupNotes = Boolean(groupId && isInMyGroups)

  const groupSubRequests = useMemo(
    (): TFeedSubRequest[] => {
      if (!groupId) return []

      const filter = {
        '#h': [groupId],
        kinds: GROUP_PAGE_FEED_ALL_KINDS
      }
      const requests: TFeedSubRequest[] = []

      if (shouldWarmHydrateLocalGroupNotes) {
        requests.push({
          source: 'local',
          filter
        })
      }

      if (shouldGateGroupSubRequests) {
        return requests
      }

      requests.push({
        source: 'relays',
        urls: activeGroupRelay ? [activeGroupRelay] : BIG_RELAY_URLS,
        filter,
        warmHydrateFromLocalCache: shouldWarmHydrateLocalGroupNotes && Boolean(activeGroupRelay),
        relaySinceOverlapSeconds: 10
      })

      return requests
    },
    [
      groupId,
      activeGroupRelay,
      shouldGateGroupSubRequests,
      shouldWarmHydrateLocalGroupNotes,
      joinRelayRefreshNonce
    ]
  )
  const hasGroupRelaySubRequest = useMemo(
    () => groupSubRequests.some((request) => request.source === 'relays'),
    [groupSubRequests]
  )

  const groupFileSubRequests = useMemo(
    () =>
      groupId
        ? shouldGateGroupSubRequests
          ? []
          : [
              {
                source: 'relays' as const,
                urls: activeGroupRelay ? [activeGroupRelay] : BIG_RELAY_URLS,
                filter: {
                  '#h': [groupId],
                  kinds: [1063]
                }
              }
            ]
        : [],
    [groupId, activeGroupRelay, shouldGateGroupSubRequests, joinRelayRefreshNonce]
  )

  useEffect(() => {
    setGroupFileCount(undefined)
  }, [groupId, activeGroupRelay])

  useEffect(() => {
    if (!groupId || !activeGroupRelay || !hasGroupRelaySubRequest) return
    const warmupKey = `${groupId}|${activeGroupRelay}`
    if (groupRelayWarmupKeyRef.current === warmupKey) return
    groupRelayWarmupKeyRef.current = warmupKey
    let active = true
    client
      .loadMoreTimeline(groupSubRequests, {
        '#h': [groupId],
        kinds: [9000, 9001, ...GROUP_PAGE_FEED_TIMELINE_KINDS],
        limit: 1
      })
      .then((_events) => {
        if (!active) return
      })
      .catch((error) => {
        if (!active) return
        console.warn('[GroupPage] warm relay fetch failed', {
          groupId,
          relay: activeGroupRelay,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    return () => {
      active = false
    }
  }, [groupId, activeGroupRelay, groupSubRequests, hasGroupRelaySubRequest])

  const isHyperpipeGroup = useMemo(() => {
    const tags = detail?.metadata?.event?.tags
    return Array.isArray(tags) && tags.some((t) => t[0] === 'i' && t[1] === 'hyperpipe:relay')
  }, [detail?.metadata?.event?.tags])

  const decodeNpub = (value?: string) => {
    if (!value || !value.startsWith('npub')) return undefined
    try {
      const decoded = nip19.decode(value)
      return decoded.type === 'npub' ? (decoded.data as string) : undefined
    } catch {
      return undefined
    }
  }

  const isCreator = useMemo(() => {
    if (!pubkey) return false
    const idPart = groupId?.split(':')?.[0]
    const idPubkey = decodeNpub(idPart)
    const dTagPubkey =
      decodeNpub(detail?.metadata?.event?.tags?.find?.((t) => t[0] === 'd')?.[1]) ||
      decodeNpub(fallbackMeta?.event?.tags?.find?.((t) => t[0] === 'd')?.[1])
    const metaPubkey = detail?.metadata?.event?.pubkey || fallbackMeta?.event?.pubkey
    return metaPubkey === pubkey || idPubkey === pubkey || dTagPubkey === pubkey
  }, [pubkey, groupId, detail?.metadata?.event, fallbackMeta])

  useEffect(() => {
    if (!groupId) return
    if (joinFlow?.phase !== 'success') return
    fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true })
      .then((nextDetail) => {
        if (!nextDetail) return
        setDetail((prev) => {
          if (!prev) return nextDetail
          const prevMembers = normalizeComparablePubkeys((prev.members || []) as string[])
          const incomingMembers = normalizeComparablePubkeys((nextDetail.members || []) as string[])
          const prevAdmins = normalizeComparablePubkeys(
            ((prev.admins || []).map((admin) => String(admin?.pubkey || '').trim()).filter(Boolean)) as string[]
          )
          const incomingAdmins = normalizeComparablePubkeys(
            ((nextDetail.admins || []).map((admin) => String(admin?.pubkey || '').trim()).filter(Boolean)) as string[]
          )
          const shouldKeepPrevMembers =
            prevMembers.length > 0 &&
            incomingMembers.length < prevMembers.length &&
            !nextDetail.membershipAuthoritative &&
            (nextDetail.membershipFetchTimedOutLike || incomingMembers.length === 0)
          const shouldKeepPrevForSuspiciousAdminDowngrade = isSuspiciousAdminOnlySelfDetailDowngrade({
            prevMembers,
            nextMembers: incomingMembers,
            prevAdmins,
            nextAdmins: incomingAdmins,
            prevMetadataPubkey: prev.metadata?.event?.pubkey,
            nextMetadataPubkey: nextDetail.metadata?.event?.pubkey,
            pubkey,
            membershipAuthoritative: nextDetail.membershipAuthoritative,
            membershipFetchSource: nextDetail.membershipFetchSource || null,
            membershipEventsCount: nextDetail.membershipEventsCount || 0
          })
          if (shouldKeepPrevForSuspiciousAdminDowngrade) {
            return {
              ...nextDetail,
              members: prev.members || [],
              membershipAuthoritative: false,
              membershipStatus: prev.membershipStatus || nextDetail.membershipStatus
            }
          }
          if (!shouldKeepPrevMembers) return nextDetail
          return {
            ...nextDetail,
            members: prev.members || [],
            membershipStatus: prev.membershipStatus || nextDetail.membershipStatus
          }
        })
      })
      .catch(() => {})
  }, [effectiveGroupRelay, fetchGroupDetail, groupId, joinFlow?.phase, pubkey])

  const handleJoin = async () => {
    if (!groupId) return
    try {
      if (showZeroPeerJoinWarning) {
        toast.warning(t('No usable peers are currently online. Join may fail until a peer or gateway comes online.'))
      }
      const metadataHints = toJoinFlowHintFields(detail?.metadata)
      const inviteHints = toJoinFlowHintFields(inviteData)
      const relayUrlForJoin = resolvedGroupRelay || effectiveGroupRelay || null
      const inviteRelayKey = inviteData?.relayKey || null
      const relayKey = relayKeyForGroup || inviteRelayKey || null
      const metadataHostPeers = Array.isArray(metadataHints.hostPeerKeys)
        ? metadataHints.hostPeerKeys
        : []
      const inviteHostPeers = Array.isArray(inviteHints.hostPeerKeys)
        ? inviteHints.hostPeerKeys
        : []
      const mergedHostPeerKeys = Array.from(
        new Set([...metadataHostPeers, ...inviteHostPeers].map((entry) => String(entry || '').trim()).filter(Boolean))
      )
      const metadataLeaseReplicaPeers = Array.isArray(metadataHints.leaseReplicaPeerKeys)
        ? metadataHints.leaseReplicaPeerKeys
        : []
      const inviteLeaseReplicaPeers = Array.isArray(inviteHints.leaseReplicaPeerKeys)
        ? inviteHints.leaseReplicaPeerKeys
        : []
      const mergedLeaseReplicaPeerKeys = Array.from(
        new Set(
          [...metadataLeaseReplicaPeers, ...inviteLeaseReplicaPeers]
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        )
      )
      const writerIssuerPubkey =
        inviteHints.writerIssuerPubkey ||
        metadataHints.writerIssuerPubkey ||
        undefined
      const discoveryTopic =
        inviteHints.discoveryTopic ||
        metadataHints.discoveryTopic ||
        undefined
      const shouldUseWorkerJoin =
        isElectron() &&
        (isHyperpipeGroup || hasInviteJoinData || !!relayKeyForGroup || !!groupId?.includes(':'))

      if (inviteRelayKey && relayKeyForGroup && inviteRelayKey !== relayKeyForGroup) {
        console.warn('[GroupPage] Invite relayKey differs from resolved relay key', {
          groupId,
          inviteRelayKey: String(inviteRelayKey).slice(0, 16),
          relayKeyForGroup: String(relayKeyForGroup).slice(0, 16)
        })
      }
      if (isOpenGroup === false && !inviteToken) {
        if (membershipStatus !== 'pending' && !closedJoinRequestPending) {
          await sendJoinRequest(groupId, effectiveGroupRelay)
          setDetail((prev) => (prev ? { ...prev, membershipStatus: 'pending' } : prev))
          markClosedJoinRequestPending()
        }
        return
      }

      if (shouldUseWorkerJoin && inviteToken && sendToWorker && pubkey) {
        sendToWorker({
          type: 'update-auth-data',
          data: { relayKey, publicIdentifier: groupId, pubkey, token: inviteToken }
        }).catch(() => {})
      }

      if (shouldUseWorkerJoin) {
        await startJoinFlow(groupId, {
          fileSharing: isOpenGroup,
          isOpen: isOpenGroup,
          openJoin: openJoinAllowed,
          token: inviteToken,
          relayKey,
          relayUrl: relayUrlForJoin,
          gatewayId:
            inviteHints.gatewayId
            || inviteData?.gatewayId
            || metadataHints.gatewayId
            || undefined,
          gatewayOrigin:
            inviteHints.gatewayOrigin
            || inviteData?.gatewayOrigin
            || metadataHints.gatewayOrigin
            || undefined,
          directJoinOnly:
            inviteHints.directJoinOnly === true
            || inviteData?.directJoinOnly === true
            || metadataHints.directJoinOnly === true
            || undefined,
          discoveryTopic,
          hostPeerKeys: mergedHostPeerKeys.length ? mergedHostPeerKeys : undefined,
          leaseReplicaPeerKeys: mergedLeaseReplicaPeerKeys.length ? mergedLeaseReplicaPeerKeys : undefined,
          writerIssuerPubkey,
          writerLeaseEnvelope: inviteHints.writerLeaseEnvelope || undefined,
          gatewayAccess: inviteData?.gatewayAccess || undefined,
          blindPeer: inviteData?.blindPeer,
          cores: inviteData?.cores,
          writerCore: inviteData?.writerCore,
          writerCoreHex: inviteData?.writerCoreHex,
          autobaseLocal: inviteData?.autobaseLocal,
          writerSecret: inviteData?.writerSecret,
          fastForward: inviteData?.fastForward || undefined
        })
        return
      }

      await sendJoinRequest(groupId, effectiveGroupRelay, inviteToken)
      setDetail((prev) => (prev ? { ...prev, membershipStatus: 'pending' } : prev))
    } catch (err) {
      const message = formatJoinFlowErrorMessage({
        error: err instanceof Error ? err.message : String(err)
      })
      setError(message)
      toast.error(message)
    }
  }

  const handleSaveMetadata = async (data: TGroupMetadataForm) => {
    if (!groupId) return
    setIsSavingMeta(true)
    try {
      await updateMetadata(groupId, data, effectiveGroupRelay)
      toast.success(t('Metadata updated'))
      // Optimistic local update
      setDetail((prev) => {
        if (!prev?.metadata) return prev
        return {
          ...prev,
          metadata: {
            ...prev.metadata,
            name: data.name ?? prev.metadata.name,
            about: data.about ?? prev.metadata.about,
            picture: data.picture ?? prev.metadata.picture,
            isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : prev.metadata.isOpen,
            isPublic: typeof data.isPublic === 'boolean' ? data.isPublic : prev.metadata.isPublic
          }
        }
      })
      setIsMetadataDialogOpen(false)
      // Refresh detail
      fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true }).then(setDetail)
    } catch (err) {
      toast.error(t('Failed to update metadata'))
      setError((err as Error).message)
    } finally {
      setIsSavingMeta(false)
    }
  }

  const handleLeaveClick = () => {
    setLeaveSaveRelaySnapshot(true)
    setLeaveSaveSharedFiles(true)
    setIsLeaveDialogOpen(true)
  }

  const handleLeaveConfirm = async () => {
    if (!groupId) return
    setIsLeavingGroup(true)
    const toastId = toast.loading('Leaving group...', {
      description: 'Archiving/removing local data and updating group membership events.'
    })
    try {
      const result = await leaveGroup(groupId, effectiveGroupRelay, {
        saveRelaySnapshot: leaveSaveRelaySnapshot,
        saveSharedFiles: leaveSaveSharedFiles
      })
      clearClosedJoinRequestPending()
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              membershipStatus: 'not-member',
              members: (prev.members || []).filter((member) => member !== pubkey)
            }
          : prev
      )
      setIsLeaveDialogOpen(false)

      if (result.queuedRetry) {
        toast.success('Left locally, sync pending', {
          id: toastId,
          description:
            "Local leave is complete. We'll retry publishing your leave updates (9022/10009) in the background."
        })
        const popKey = `${groupId}|${pubkey || ''}`
        if (autoPopKeyRef.current !== popKey) {
          autoPopKeyRef.current = popKey
          window.setTimeout(() => pop(), 0)
        }
        return
      }

      if (!leaveSaveRelaySnapshot && !leaveSaveSharedFiles) {
        toast.success('Group data removed', {
          id: toastId,
          description: 'You left the group and removed all local relay and shared file data.'
        })
        const popKey = `${groupId}|${pubkey || ''}`
        if (autoPopKeyRef.current !== popKey) {
          autoPopKeyRef.current = popKey
          window.setTimeout(() => pop(), 0)
        }
        return
      }

      const statusDescription = (() => {
        if (leaveSaveRelaySnapshot && leaveSaveSharedFiles) {
          return 'Relay snapshot archived. Shared files kept locally.'
        }
        if (leaveSaveRelaySnapshot && !leaveSaveSharedFiles) {
          return 'Relay snapshot archived. Shared files removed from this device.'
        }
        return 'Relay snapshot removed. Shared files kept locally.'
      })()
      const recoveryDescription =
        result.recoveredCount > 0 || result.failedCount > 0
          ? `Recovered ${result.recoveredCount} files, ${result.failedCount} failed.`
          : null
      toast.success('You left the group', {
        id: toastId,
        description: recoveryDescription
          ? `${statusDescription} ${recoveryDescription}`
          : statusDescription
      })
      const popKey = `${groupId}|${pubkey || ''}`
      if (autoPopKeyRef.current !== popKey) {
        autoPopKeyRef.current = popKey
        window.setTimeout(() => pop(), 0)
      }
    } catch (err) {
      setError((err as Error).message)
      toast.error('Failed to leave group', {
        id: toastId,
        description: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setIsLeavingGroup(false)
    }
  }

  const dismissAdminLeaveNotice = React.useCallback(() => {
    if (groupId && adminLeaveNotice?.eventId) {
      localStorageService.markDismissedGroupAdminLeaveEvent(
        `${groupId}:${adminLeaveNotice.eventId}`,
        pubkey
      )
    }
    setAdminLeaveNotice(null)
  }, [adminLeaveNotice?.eventId, groupId, pubkey])

  const baseDetail = useMemo(
    () =>
      detail ||
      (fallbackMeta
        ? {
            metadata: fallbackMeta,
            admins: [],
            members: [],
            membershipStatus: 'not-member' as const,
            membershipAuthoritative: false,
            membershipEventsCount: 0,
            membersFromEventCount: 0,
            membersSnapshotCreatedAt: null,
            membershipFetchTimedOutLike: false,
            membershipFetchSource: 'group-relay' as const
          }
        : null),
    [detail, fallbackMeta]
  )
  let membershipStatus = baseDetail?.membershipStatus ?? 'not-member'
  if (isInMyGroups) {
    membershipStatus = 'member'
  }
  const membersWithSelf = useMemo(() => {
    const withSelf = new Set(baseDetail?.members || [])
    if (membershipStatus === 'member' && pubkey) {
      withSelf.add(pubkey)
    }
    return Array.from(withSelf)
  }, [baseDetail?.members, membershipStatus, pubkey])
  const mockMembersConfig = useMemo(() => {
    if (process.env.NODE_ENV !== 'development') return null
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (!params.has('mockMembers')) return null

    let parsed: string[] | null = null
    const raw = params.get('mockMembers')
    if (raw) {
      try {
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          parsed = data.filter((m) => typeof m === 'string' && m.length > 10)
        }
      } catch (err) {
        console.warn('[GroupPage] mockMembers parse failed, using defaults', err)
      }
    }

    const normalizeMockMember = (m: string) => {
      try {
        const decoded = nip19.decode(m)
        if (decoded.type === 'npub') return decoded.data as string
        if (
          decoded.type === 'nprofile' &&
          typeof decoded.data === 'object' &&
          'pubkey' in decoded.data
        ) {
          return (decoded.data as any).pubkey as string
        }
      } catch {
        // fall through to returning raw value
      }
      return m
    }

    const defaultMembers = [
      pubkey ?? 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ]
    const members = Array.from(
      new Set(
        (parsed?.length ? parsed : defaultMembers)
          .map(normalizeMockMember)
          .filter((m) => !!m && m.length > 10)
      )
    )
    const admins = members[1] ? [{ pubkey: members[1] }] : []
    return { members, admins }
  }, [pubkey])

  const effectiveDetail = useMemo(() => {
    if (!baseDetail) return null
    const detailWithSelf = { ...baseDetail, membershipStatus, members: membersWithSelf }
    if (!mockMembersConfig) return detailWithSelf
    return {
      ...detailWithSelf,
      members: mockMembersConfig.members,
      admins: mockMembersConfig.admins,
      membershipStatus: 'member' as const
    }
  }, [baseDetail, membershipStatus, membersWithSelf, mockMembersConfig])
  const isOpenGroup = effectiveDetail?.metadata?.isOpen !== false
  const effectiveMembershipStatus =
    membershipStatus === 'not-member' && !isOpenGroup && !inviteToken && closedJoinRequestPending
      ? ('pending' as const)
      : membershipStatus

  useEffect(() => {
    if (!closedJoinRequestPending) return
    if (
      inviteToken ||
      isOpenGroup ||
      effectiveMembershipStatus === 'member' ||
      effectiveMembershipStatus === 'removed'
    ) {
      clearClosedJoinRequestPending()
    }
  }, [
    clearClosedJoinRequestPending,
    closedJoinRequestPending,
    effectiveMembershipStatus,
    inviteToken,
    isOpenGroup
  ])

  const isMember = effectiveMembershipStatus === 'member'
  const isJoinFlowBusy =
    joinFlow?.phase === 'starting' ||
    joinFlow?.phase === 'request' ||
    joinFlow?.phase === 'verify' ||
    joinFlow?.phase === 'complete'
  const canRequestToJoinClosedGroup = !isMember && !isOpenGroup && !inviteToken
  const hasSubmittedClosedGroupJoinRequest =
    canRequestToJoinClosedGroup && effectiveMembershipStatus === 'pending'
  const inviteOpenJoin = !!inviteData && !inviteToken && inviteData.fileSharing !== false
  const openJoinAllowed = inviteOpenJoin || effectiveDetail?.metadata?.isOpen === true
  const groupPresenceInput = useMemo(() => {
    if (!groupId) return null
    const metadataHints = toJoinFlowHintFields(effectiveDetail?.metadata)
    const inviteHints = toJoinFlowHintFields(inviteData)
    return {
      groupId,
      relay: effectiveGroupRelay,
      gatewayId: metadataHints.gatewayId || inviteHints.gatewayId || null,
      gatewayOrigin: metadataHints.gatewayOrigin || inviteHints.gatewayOrigin || null,
      directJoinOnly:
        metadataHints.directJoinOnly === true || inviteHints.directJoinOnly === true,
      discoveryTopic: metadataHints.discoveryTopic || inviteHints.discoveryTopic || null,
      hostPeerKeys: normalizePubkeyList([
        ...(metadataHints.hostPeerKeys || []),
        ...(inviteHints.hostPeerKeys || [])
      ]),
      leaseReplicaPeerKeys: normalizePubkeyList([
        ...(metadataHints.leaseReplicaPeerKeys || []),
        ...(inviteHints.leaseReplicaPeerKeys || [])
      ])
    }
  }, [effectiveDetail?.metadata, effectiveGroupRelay, groupId, inviteData])
  const groupPresence = useGroupPresence(groupPresenceInput, {
    enabled: !!groupId,
    ttlMs: GROUP_PAGE_PRESENCE_TTL_MS,
    priority: 2
  })
  const showZeroPeerJoinWarning =
    !isMember &&
    groupPresence.status === 'ready' &&
    Number.isFinite(groupPresence.count) &&
    Number(groupPresence.count) === 0
  const inviteMemberSet = useMemo(
    () => new Set((effectiveDetail?.members || []).filter((member) => !!member)),
    [effectiveDetail?.members]
  )
  const inviteCandidateProfiles = useMemo(
    () => inviteProfiles.filter((profile) => !inviteMemberSet.has(profile.pubkey)),
    [inviteProfiles, inviteMemberSet]
  )

  const isAdmin =
    !!pubkey && (isCreator || !!effectiveDetail?.admins?.some((admin) => admin.pubkey === pubkey))

  const adminLeaveCandidatePubkeys = useMemo(() => {
    const pubkeys = normalizePubkeyList(
      (effectiveDetail?.admins || []).map((admin) => admin.pubkey)
    )
    if (effectiveDetail?.metadata?.event?.pubkey) {
      pubkeys.push(effectiveDetail.metadata.event.pubkey)
    }
    return normalizePubkeyList(pubkeys)
  }, [effectiveDetail?.admins, effectiveDetail?.metadata?.event?.pubkey])

  useEffect(() => {
    if (!groupId || !isMember || adminLeaveNotice) return
    const timer = window.setInterval(() => {
      setAdminLeavePollTick((prev) => prev + 1)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [adminLeaveNotice, groupId, isMember])

  useEffect(() => {
    if (!groupId || !isMember) return

    let cancelled = false
    const relayUrls = Array.from(
      new Set([...(activeGroupRelay ? [activeGroupRelay] : []), ...BIG_RELAY_URLS])
    )
    ;(async () => {
      const shadowRef = await buildPrivateGroupLeaveShadowRef({
        groupId,
        relayKey: workerRelayEntryForGroup?.relayKey || null,
        publicIdentifier: workerRelayEntryForGroup?.publicIdentifier || groupId
      })
      const leaveFilters: Array<{ '#h': string[]; kinds: number[]; limit: number }> = [
        {
          kinds: [9022],
          '#h': [groupId],
          limit: 200
        }
      ]
      if (shadowRef) {
        leaveFilters.push({
          kinds: [9022],
          '#h': [shadowRef],
          limit: 200
        })
      }
      const adminSnapshotFilters: Array<{
        '#d'?: string[]
        '#h'?: string[]
        kinds: number[]
        limit: number
      }> = [
        {
          kinds: [39001],
          '#d': [groupId],
          limit: 200
        },
        {
          kinds: [39001],
          '#h': [groupId],
          limit: 200
        }
      ]
      const [leaveBatches, adminSnapshotBatches] = await Promise.all([
        Promise.all(
          leaveFilters.map((filter) => client.fetchEvents(relayUrls, filter).catch(() => []))
        ),
        Promise.all(
          adminSnapshotFilters.map((filter) =>
            client.fetchEvents(relayUrls, filter).catch(() => [])
          )
        )
      ])
      const dedupeById = (events: NostrEvent[]) => {
        const seenIds = new Set<string>()
        return events.filter((event) => {
          if (!event?.id) return true
          if (seenIds.has(event.id)) return false
          seenIds.add(event.id)
          return true
        })
      }
      const events = dedupeById(leaveBatches.flat())
      const adminSnapshotEvents = dedupeById(adminSnapshotBatches.flat())
      const historicalAdminPubkeys = normalizePubkeyList(
        adminSnapshotEvents.flatMap((event) =>
          event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1])
        )
      )
      const adminPubkeys = new Set(
        normalizePubkeyList([...adminLeaveCandidatePubkeys, ...historicalAdminPubkeys])
      )
      if (adminPubkeys.size === 0) return
      if (cancelled) return
      const latestAdminLeave = events
        .filter((event) => adminPubkeys.has(event.pubkey))
        .sort((a, b) => b.created_at - a.created_at)[0]
      if (!latestAdminLeave) return
      if (latestAdminLeave.pubkey === pubkey) return
      const eventKey = `${groupId}:${latestAdminLeave.id}`
      if (localStorageService.isGroupAdminLeaveEventDismissed(eventKey, pubkey)) return
      setAdminLeaveNotice({
        eventId: latestAdminLeave.id,
        pubkey: latestAdminLeave.pubkey
      })
    })().catch(() => {})

    return () => {
      cancelled = true
    }
  }, [
    activeGroupRelay,
    adminLeaveCandidatePubkeys,
    adminLeavePollTick,
    groupId,
    isMember,
    pubkey,
    workerRelayEntryForGroup?.publicIdentifier,
    workerRelayEntryForGroup?.relayKey
  ])

  const groupMemberPreview = useMemo(
    () => (groupId ? getGroupMemberPreview(groupId, effectiveGroupRelay) : null),
    [effectiveGroupRelay, getGroupMemberPreview, groupId]
  )
  const canonicalMembers = useMemo(() => {
    const previewMembers = normalizePubkeyList(groupMemberPreview?.members || [])
    if (previewMembers.length > 0) return previewMembers
    const detailMembers = normalizePubkeyList(effectiveDetail?.members || [])
    if (detailMembers.length > 0) return detailMembers
    if (isInMyGroups) return detailMembers
    return normalizePubkeyList(inviteData?.authorizedMemberPubkeys || [])
  }, [
    effectiveDetail?.members,
    groupMemberPreview?.members,
    inviteData?.authorizedMemberPubkeys,
    isInMyGroups
  ])
  const summaryMembers = canonicalMembers
  const summaryFacepileMembers = summaryMembers.slice(0, 5)

  const adminPubkeys = useMemo(
    () => normalizePubkeyList((effectiveDetail?.admins || []).map((admin) => admin.pubkey)),
    [effectiveDetail?.admins]
  )
  const primaryAdminPubkey = adminPubkeys[0]
  const additionalAdminCount = Math.max(0, adminPubkeys.length - 1)

  useEffect(() => {
    if (!groupId || !isAdmin) return
    loadJoinRequests(groupId, effectiveGroupRelay)
  }, [effectiveGroupRelay, groupId, isAdmin, loadJoinRequests])

  /*
   * Dev-only JoinSimulator disabled to avoid automatic registration in app builds.
   * Re-enable by uncommenting and restoring the import from @/devtools/joinWorkflowSimulator.
   */
  // useEffect(() => {
  //   if (!groupId) return
  //   registerJoinWorkflowSimulator({
  //     groupId,
  //     relay: effectiveGroupRelay,
  //     startJoinFlow,
  //     sendJoinRequest,
  //     approveJoinRequest,
  //     rejectJoinRequest,
  //     sendInvites,
  //     loadJoinRequests
  //   })
  // }, [
  //   approveJoinRequest,
  //   effectiveGroupRelay,
  //   groupId,
  //   loadJoinRequests,
  //   rejectJoinRequest,
  //   sendInvites,
  //   sendJoinRequest,
  //   startJoinFlow
  // ])

  const relayKeyForGroup = useMemo(() => {
    if (!groupId || !relays?.length) return undefined
    const candidates = new Set<string>()
    candidates.add(groupId)
    candidates.add(groupId.replace(':', '/'))
    candidates.add(groupId.replace('/', ':'))
    const match = relays.find(
      (r) =>
        (r.publicIdentifier && candidates.has(r.publicIdentifier)) ||
        (r.relayKey && candidates.has(r.relayKey))
    )
    return match?.relayKey
  }, [groupId, relays])

  useEffect(() => {
    if (!groupId) return
    const inviteRelayKey = inviteData?.relayKey || null
    const relayKey = relayKeyForGroup || inviteRelayKey || null
    const refreshKey = `${groupId}|${relayKey || ''}`
    if (lastRouteSubscriptionRefreshRef.current === refreshKey) return
    const requested = requestRelaySubscriptionRefresh({
      relayKey,
      publicIdentifier: groupId,
      reason: 'group-page-route-enter',
      minIntervalMs: 1500
    })
    if (!requested) return
    lastRouteSubscriptionRefreshRef.current = refreshKey
  }, [
    groupId,
    inviteData?.relayKey,
    relayKeyForGroup,
    requestRelaySubscriptionRefresh
  ])

  useEffect(() => {
    if (!groupId) return
    const relayKey = relayKeyForGroup || inviteData?.relayKey || joinFlow?.relayKey || null
    const hydrateKey = `${groupId}|${relayKey || ''}`
    if (hydrateCursorResetKeyRef.current === hydrateKey) return
    hydrateCursorResetKeyRef.current = hydrateKey

    const timer = window.setTimeout(() => {
      const requested = requestRelaySubscriptionRefresh({
        relayKey,
        publicIdentifier: groupId,
        reason: 'group-page-hydrate',
        minIntervalMs: 0,
        retryOnNoClients: true
      })
      if (requested) {
        setJoinRelayRefreshNonce((prev) => prev + 1)
      }
    }, 450)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    groupId,
    inviteData?.relayKey,
    joinFlow?.relayKey,
    relayKeyForGroup,
    requestRelaySubscriptionRefresh
  ])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    if (typeof window === 'undefined') return
    if (!groupId) return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('closedJoinSim')) return
    registerClosedJoinSimulator({
      groupId,
      relay: effectiveGroupRelay || null,
      relayUrl: resolvedGroupRelay || effectiveGroupRelay || null,
      relayKeyForGroup: relayKeyForGroup || null,
      inviteData,
      isOpenGroup,
      startJoinFlow,
      sendJoinRequest,
      loadJoinRequests,
      approveJoinRequest,
      sendInvites
    })
  }, [
    approveJoinRequest,
    effectiveGroupRelay,
    groupId,
    inviteData,
    isOpenGroup,
    loadJoinRequests,
    relayKeyForGroup,
    resolvedGroupRelay,
    sendInvites,
    sendJoinRequest,
    startJoinFlow
  ])

  const groupDisplayName =
    effectiveDetail?.metadata?.name || fallbackMeta?.name || groupId || t('Group')
  const groupPicture = effectiveDetail?.metadata?.picture || fallbackMeta?.picture
  const groupTitle = (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="truncate">{groupDisplayName}</span>
    </span>
  )

  const relayUrlToCopy = activeGroupRelay || resolvedGroupRelay || effectiveGroupRelay

  const filteredMembers = useMemo(() => {
    const term = memberSearch.trim().toLowerCase()
    const members = canonicalMembers
    if (!term) return members
    return members.filter((m) => {
      const normalized = m.toLowerCase()
      let npub: string | null = null
      try {
        npub = nip19.npubEncode(m)
      } catch {
        npub = null
      }
      return normalized.includes(term) || (npub ? npub.toLowerCase().includes(term) : false)
    })
  }, [canonicalMembers, memberSearch])

  const canInviteMembers = isOpenGroup || isAdmin

  const handleCopyRelayUrl = async () => {
    if (!relayUrlToCopy) return
    try {
      await navigator.clipboard.writeText(relayUrlToCopy)
      setCopiedRelayUrl(true)
      setTimeout(() => setCopiedRelayUrl(false), 2000)
    } catch (err) {
      toast.error(t('Failed to copy to clipboard'))
      console.error('[GroupPage] failed to copy relay URL', err)
    }
  }

  const handleInviteToggle = (pubkey: string) => {
    setSelectedInvitees((prev) =>
      prev.includes(pubkey) ? prev.filter((p) => p !== pubkey) : [...prev, pubkey]
    )
  }

  const handleInviteSubmit = async () => {
    if (!groupId || !selectedInvitees.length) return
    setIsSendingInvite(true)
    try {
      await sendInvites(groupId, selectedInvitees, effectiveGroupRelay, {
        isOpen: isOpenGroup,
        name: effectiveDetail?.metadata?.name,
        about: effectiveDetail?.metadata?.about,
        picture: effectiveDetail?.metadata?.picture,
        authorizedMemberPubkeys: canonicalMembers
      })
      toast.success(t('Invites sent'))
      setSelectedInvitees([])
      setInviteSearch('')
      setIsInviteDialogOpen(false)
    } catch (err) {
      toast.error(t('Failed to send invites'))
      setError((err as Error).message)
    } finally {
      setIsSendingInvite(false)
    }
  }

  const handleGrantAdmin = React.useCallback(
    async (targetPubkey: string) => {
      if (!groupId) return
      try {
        await grantAdmin(groupId, targetPubkey, effectiveGroupRelay)
        toast.success(t('Admin permissions granted'))
      } catch (err) {
        toast.error(t('Failed to grant admin permissions'))
        setError((err as Error).message)
      }
    },
    [effectiveGroupRelay, grantAdmin, groupId, t]
  )

  const handleReportUser = React.useCallback((targetPubkey: string) => {
    setReportTarget(targetPubkey)
  }, [])

  const handleMutePrivately = React.useCallback(
    (targetPubkey: string) => {
      mutePrivately(targetPubkey)
    },
    [mutePrivately]
  )

  const handleMutePublicly = React.useCallback(
    (targetPubkey: string) => {
      mutePublicly(targetPubkey)
    },
    [mutePublicly]
  )

  const handleApproveJoinRequest = React.useCallback(
    async (request: TJoinRequest) => {
      if (!groupId) return
      const targetPubkey = request.pubkey
      setJoinRequestAction({ pubkey: targetPubkey, action: 'approve' })
      try {
        await approveJoinRequest(groupId, targetPubkey, effectiveGroupRelay, request.created_at)
        toast.success(t('Invite sent'))
        await loadJoinRequests(groupId, effectiveGroupRelay)
      } catch (err) {
        toast.error(t('Failed to send invite'))
        setError((err as Error).message)
      } finally {
        setJoinRequestAction(null)
      }
    },
    [approveJoinRequest, effectiveGroupRelay, groupId, loadJoinRequests, t]
  )

  const handleRejectJoinRequest = React.useCallback(
    async (request: TJoinRequest) => {
      if (!groupId) return
      const targetPubkey = request.pubkey
      setJoinRequestAction({ pubkey: targetPubkey, action: 'reject' })
      try {
        await rejectJoinRequest(groupId, targetPubkey, effectiveGroupRelay, request.created_at)
        toast.success(t('Join request rejected'))
        await loadJoinRequests(groupId, effectiveGroupRelay)
      } catch (err) {
        toast.error(t('Failed to reject join request'))
        setError((err as Error).message)
      } finally {
        setJoinRequestAction(null)
      }
    },
    [effectiveGroupRelay, groupId, loadJoinRequests, rejectJoinRequest, t]
  )

  const handleRemoveMember = React.useCallback(
    async (targetPubkey: string) => {
      if (!groupId || !isAdmin) return
      try {
        await removeUser(groupId, targetPubkey, effectiveGroupRelay)
        const ts = Date.now()
        const relayKey = relayKeyForGroup
        const identifier = relayKey || groupId
        if (sendToWorker && identifier) {
          sendToWorker({
            type: 'update-members',
            data: {
              relayKey,
              publicIdentifier: groupId,
              member_removes: [{ pubkey: targetPubkey, ts }]
            }
          }).catch(() => {})
          sendToWorker({
            type: 'remove-auth-data',
            data: {
              relayKey,
              publicIdentifier: groupId,
              pubkey: targetPubkey
            }
          }).catch(() => {})
        }
        try {
          const relayUrlKey = resolvedGroupRelay || effectiveGroupRelay || groupId
          await relayMembershipService.removeMember(relayUrlKey, targetPubkey)
        } catch (_err) {
          // cache update best-effort
        }
        setDetail((prev) => {
          if (!prev) return prev
          const nextMembers = (prev.members || []).filter((m) => m !== targetPubkey)
          const nextStatus = targetPubkey === pubkey ? ('removed' as const) : prev.membershipStatus
          return { ...prev, members: nextMembers, membershipStatus: nextStatus }
        })
        toast.success(t('Member removed'))
      } catch (err) {
        toast.error(t('Failed to remove member'))
        setError((err as Error).message)
      }
    },
    [
      effectiveGroupRelay,
      groupId,
      isAdmin,
      pubkey,
      relayKeyForGroup,
      removeUser,
      resolvedGroupRelay,
      sendToWorker,
      t
    ]
  )

  const memberRows = useMemo(
    () =>
      filteredMembers.map((member) => (
        <MemoizedMemberRow
          key={member}
          memberPubkey={member}
          isSelf={member === pubkey}
          showGrantAdmin={isAdmin && member !== pubkey}
          canMute={member !== pubkey}
          nostrProfile={nostrProfile}
          pubkey={pubkey}
          onGrantAdmin={handleGrantAdmin}
          onReportUser={handleReportUser}
          onMutePrivately={handleMutePrivately}
          onMutePublicly={handleMutePublicly}
          onRemove={handleRemoveMember}
          t={t}
        />
      )),
    [
      filteredMembers,
      handleGrantAdmin,
      handleRemoveMember,
      handleMutePrivately,
      handleMutePublicly,
      handleReportUser,
      isAdmin,
      nostrProfile,
      pubkey,
      t
    ]
  )

  const joinRequestRows = useMemo(
    () =>
      pendingJoinRequests.map((req) => (
        <JoinRequestRow
          key={req.event.id}
          request={req}
          approving={
            joinRequestAction?.pubkey === req.pubkey && joinRequestAction.action === 'approve'
          }
          rejecting={
            joinRequestAction?.pubkey === req.pubkey && joinRequestAction.action === 'reject'
          }
          onApprove={handleApproveJoinRequest}
          onReject={handleRejectJoinRequest}
          t={t}
        />
      )),
    [handleApproveJoinRequest, handleRejectJoinRequest, joinRequestAction, pendingJoinRequests, t]
  )

  const content = (
    <SecondaryPageLayout ref={ref} index={index} title={groupTitle}>
      {isLoading ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('Loading...')}
        </div>
      ) : error ? (
        <div className="text-red-500 px-4 py-3">{error}</div>
      ) : !effectiveDetail || !groupId ? (
        <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
          <Users className="w-6 h-6" />
          {t('Group not found')}
        </div>
      ) : (
        <div className="space-y-4 pb-6">
          <Card className="overflow-hidden border-0 shadow-none">
            <CardContent className="p-4 space-y-4">
              <div className="flex gap-3 items-center">
                {effectiveDetail.metadata?.picture && (
                  <img
                    src={effectiveDetail.metadata.picture}
                    alt={effectiveDetail.metadata.name}
                    className="w-12 h-12 rounded-lg object-cover shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-2xl font-semibold truncate">
                      {effectiveDetail.metadata?.name || groupId}
                    </div>
                    <div className="flex items-center gap-2 justify-start flex-wrap shrink-0">
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="titlebar-icon"
                          onClick={() => setIsMetadataDialogOpen(true)}
                          title={t('Edit metadata')}
                        >
                          <Settings className="w-5 h-5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="titlebar-icon"
                        onClick={handleCopyRelayUrl}
                        disabled={!relayUrlToCopy}
                        title={t('Copy URL')}
                      >
                        {copiedRelayUrl ? (
                          <Check className="w-5 h-5" />
                        ) : (
                          <Copy className="w-5 h-5" />
                        )}
                      </Button>
                      {isMember && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleLeaveClick}
                          disabled={isLeavingGroup}
                        >
                          <LogOut className="w-4 h-4 mr-2" />
                          {t('Leave')}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {effectiveDetail.metadata?.about && (
                <div className="text-sm text-muted-foreground whitespace-pre-line break-words w-full">
                  {effectiveDetail.metadata.about}
                </div>
              )}
              {(summaryMembers.length > 0 || groupPresence.status === 'scanning' || groupPresence.status === 'ready') && (
                <div className="w-full flex flex-wrap items-center gap-2">
                  {summaryMembers.length > 0 ? (
                    <div className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1">
                      <div className="flex -space-x-1.5">
                        {summaryFacepileMembers.map((memberPubkey) => (
                          <div
                            key={memberPubkey}
                            className="inline-flex h-6 w-6 overflow-hidden rounded-full ring-1 ring-background"
                          >
                            <UserAvatar
                              userId={memberPubkey}
                              size="small"
                              className="h-6 w-6 rounded-full"
                            />
                          </div>
                        ))}
                      </div>
                      <span className="text-xs font-semibold text-muted-foreground">
                        {summaryMembers.length}{' '}
                        {summaryMembers.length === 1 ? t('member') : t('members')}
                      </span>
                    </div>
                  ) : null}
                  <GroupPresenceChip count={groupPresence.count} status={groupPresence.status} t={t} />
                </div>
              )}
              <div className="overflow-x-auto sm:overflow-visible w-full">
                <div className="flex w-max gap-8 pb-2 sm:w-full sm:flex-wrap sm:pb-0">
                  {primaryAdminPubkey && (
                    <div className="space-y-2 w-fit">
                      <div className="text-sm font-semibold text-muted-foreground">
                        {t('Admin')}
                      </div>
                      <div className="flex gap-2 items-center">
                        <UserAvatar userId={primaryAdminPubkey} size="small" />
                        <Username
                          userId={primaryAdminPubkey}
                          className="font-semibold text-nowrap"
                        />
                        {additionalAdminCount > 0 && (
                          <span className="text-xs font-semibold text-muted-foreground">
                            +{additionalAdminCount}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="space-y-2 w-fit">
                    <div className="text-sm font-semibold text-muted-foreground">
                      {t('Membership')}
                    </div>
                    <div className="flex items-center">
                      <Badge variant="secondary">{isOpenGroup ? t('Open') : t('Closed')}</Badge>
                    </div>
                  </div>
                  <div className="space-y-2 w-fit">
                    <div className="text-sm font-semibold text-muted-foreground">
                      {t('Visibility')}
                    </div>
                    <div className="flex items-center">
                      <Badge variant="secondary">
                        {effectiveDetail.metadata?.isPublic === false ? t('Private') : t('Public')}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
              <div className="w-full">
                {showZeroPeerJoinWarning ? (
                  <div className="mb-3 inline-flex w-full items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {t(
                        'No usable peers are currently online. Join may fail until a peer or gateway comes online.'
                      )}
                    </span>
                  </div>
                ) : null}
                {isMember ? (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => setIsComposerOpen(true)}
                    disabled={!publishReadyRelay}
                  >
                    {t('New Post')}
                  </Button>
                ) : canRequestToJoinClosedGroup ? (
                  <Button
                    className="w-full"
                    onClick={handleJoin}
                    disabled={hasSubmittedClosedGroupJoinRequest || isJoinFlowBusy}
                  >
                    {hasSubmittedClosedGroupJoinRequest
                      ? t('Join request submitted')
                      : t('Request to Join Group')}
                  </Button>
                ) : (
                  <Button className="w-full" onClick={handleJoin} disabled={isJoinFlowBusy}>
                    {isJoinFlowBusy ? t('Joining…') : t('Join Group')}
                  </Button>
                )}
              </div>
              {isJoinFlowBusy && joinFlow && (
                <HyperpipeJoinFlowProgress phase={joinFlow.phase} />
              )}
            </CardContent>
          </Card>

          {isMember && (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as 'notes' | 'files' | 'members' | 'requests')}
              className="w-full"
            >
              <div className="border-b border-t">
                <TabsList className="w-full justify-start h-auto p-0 bg-transparent px-4">
                  <TabsTrigger
                    value="notes"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Notes')}
                  </TabsTrigger>
                  <TabsTrigger
                    value="members"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Members')}
                    {canonicalMembers.length ? ` (${canonicalMembers.length})` : ''}
                  </TabsTrigger>
                  <TabsTrigger
                    value="files"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                  >
                    {t('Files')}
                    {typeof groupFileCount === 'number' ? ` (${groupFileCount})` : ''}
                  </TabsTrigger>
                  {isAdmin && (
                    <TabsTrigger
                      value="requests"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                    >
                      {t('Join Requests')}
                      {joinRequestCount ? ` (${joinRequestCount})` : ''}
                    </TabsTrigger>
                  )}
                </TabsList>
              </div>
              <TabsContent value="notes" forceMount className="mt-0">
                <NormalFeed
                  subRequests={groupSubRequests}
                  isMainFeed={false}
                  debugActiveTab={activeTab}
                  debugLabel={groupId ? `GroupPage:${groupId}` : 'GroupPage:unknown'}
                />
              </TabsContent>
              <TabsContent value="files" forceMount className="mt-0">
                <GroupFilesList
                  groupId={groupId}
                  subRequests={groupFileSubRequests}
                  timelineLabel={
                    groupId ? `f-fetch-events-group-files-${groupId}` : 'f-fetch-events-group-files'
                  }
                  onCountChange={setGroupFileCount}
                />
              </TabsContent>
              <TabsContent value="members" className="mt-0">
                <div className="space-y-4">
                  <div className="px-4 py-3 border-b flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        value={memberSearch}
                        onChange={(e) => setMemberSearch(e.target.value)}
                        placeholder={t('Search users...') as string}
                        className="pl-9"
                      />
                    </div>
                    {canInviteMembers && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 shrink-0 rounded-lg"
                        onClick={() => setIsInviteDialogOpen(true)}
                        title={t('Invite members')}
                      >
                        <UserPlus className="w-5 h-5" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">{memberRows}</div>
                </div>
              </TabsContent>
              {isAdmin && (
                <TabsContent value="requests" className="mt-0">
                  <div className="space-y-4">
                    <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">
                        {t('Pending join requests')}
                        {joinRequestCount ? ` (${joinRequestCount})` : ''}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => groupId && loadJoinRequests(groupId, effectiveGroupRelay)}
                      >
                        {t('Refresh')}
                      </Button>
                    </div>
                    {joinRequestsError && (
                      <div className="text-red-500 px-4 text-sm">{joinRequestsError}</div>
                    )}
                    {joinRequestRows.length === 0 && !joinRequestsError ? (
                      <div className="text-sm text-muted-foreground px-4 py-3">
                        {t('No pending requests')}
                      </div>
                    ) : (
                      <div className="space-y-2">{joinRequestRows}</div>
                    )}
                  </div>
                </TabsContent>
              )}
            </Tabs>
          )}
        </div>
      )}
    </SecondaryPageLayout>
  )

  return (
    <>
      {content}
      {groupId && (
        <PostEditor
          open={isComposerOpen}
          setOpen={setIsComposerOpen}
          groupContext={{
            groupId,
            relay: publishReadyRelay,
            name: effectiveDetail?.metadata?.name,
            picture: groupPicture
          }}
          openFrom={publishReadyRelay ? [publishReadyRelay] : undefined}
        />
      )}
      {reportEvent && (
        <ReportDialog
          event={reportEvent}
          isOpen={!!reportTarget}
          closeDialog={() => setReportTarget(null)}
        />
      )}
      <Dialog
        open={isInviteDialogOpen}
        onOpenChange={(open) => {
          setIsInviteDialogOpen(open)
          if (!open) {
            setSelectedInvitees([])
            setInviteSearch('')
          }
        }}
      >
        <DialogContent className="sm:max-w-xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{t('Invite members')}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-3">
            <div className="relative px-0.5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                placeholder={t('Search users...') as string}
                className="pl-9"
              />
            </div>
            <div className="h-64 overflow-y-auto overflow-x-hidden space-y-2 pr-1">
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
            {selectedInvitees.length > 0 && (
              <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto pr-1">
                {selectedInvitees.map((pk) => (
                  <Button
                    key={pk}
                    variant="secondary"
                    size="sm"
                    className="flex max-w-full items-center gap-2"
                    onClick={() => handleInviteToggle(pk)}
                  >
                    <UserAvatar userId={pk} size="xSmall" />
                    <Username userId={pk} className="truncate max-w-[8rem] min-w-0" />
                    <span className="text-xs text-muted-foreground">{t('Remove')}</span>
                  </Button>
                ))}
              </div>
            )}
            <Button
              onClick={handleInviteSubmit}
              disabled={!selectedInvitees.length || isSendingInvite}
              className="w-full"
            >
              {isSendingInvite && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('Invite')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={isMetadataDialogOpen} onOpenChange={setIsMetadataDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Edit group')}</DialogTitle>
          </DialogHeader>
          <GroupMetadataEditor
            initial={{
              name: detail?.metadata?.name,
              about: detail?.metadata?.about,
              picture: detail?.metadata?.picture,
              isOpen: detail?.metadata?.isOpen,
              isPublic: detail?.metadata?.isPublic
            }}
            isOpen={isMetadataDialogOpen}
            onSave={handleSaveMetadata}
            onCancel={() => setIsMetadataDialogOpen(false)}
            saving={isSavingMeta}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={isLeaveDialogOpen}
        onOpenChange={(open) => !isLeavingGroup && setIsLeaveDialogOpen(open)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Leave group?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose what to keep on this device before leaving.
            </p>
            <div className="space-y-4 rounded-md border p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="leave-save-relay-snapshot"
                  checked={leaveSaveRelaySnapshot}
                  onCheckedChange={(value) => setLeaveSaveRelaySnapshot(value === true)}
                  disabled={isLeavingGroup}
                />
                <div className="space-y-1">
                  <label
                    htmlFor="leave-save-relay-snapshot"
                    className="text-sm font-medium cursor-pointer"
                  >
                    Save relay database snapshot
                  </label>
                  <p className="text-xs text-muted-foreground">
                    A copy is archived locally, then the active relay database is removed.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="leave-save-shared-files"
                  checked={leaveSaveSharedFiles}
                  onCheckedChange={(value) => setLeaveSaveSharedFiles(value === true)}
                  disabled={isLeavingGroup}
                />
                <div className="space-y-1">
                  <label
                    htmlFor="leave-save-shared-files"
                    className="text-sm font-medium cursor-pointer"
                  >
                    Save shared files in Files page
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Keep local copies of this group's shared files after you leave.
                  </p>
                </div>
              </div>
            </div>
            <p className="text-xs text-destructive">
              Unchecked items are permanently removed from this device.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setIsLeaveDialogOpen(false)}
                disabled={isLeavingGroup}
              >
                Cancel
              </Button>
              <Button onClick={handleLeaveConfirm} disabled={isLeavingGroup}>
                {isLeavingGroup ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Leaving group...
                  </>
                ) : (
                  'Leave group'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!adminLeaveNotice} onOpenChange={(open) => !open && dismissAdminLeaveNotice()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Group admin left</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              An admin has left this group. New members may have limited read/write access on this
              relay.
            </p>
            <p className="text-sm text-muted-foreground">
              For full control and stability, start a new group.
            </p>
            <div className="flex justify-end">
              <Button onClick={dismissAdminLeaveNotice}>Understood</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
})

GroupPage.displayName = 'GroupPage'

export default GroupPage
