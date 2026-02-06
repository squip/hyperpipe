import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { useGroups } from '@/providers/GroupsProvider'
import { TPageRef } from '@/types'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Loader2, Users, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useSecondaryPage } from '@/PageManager'
import { toGroup } from '@/lib/link'
import GroupCreateDialog from '@/components/GroupCreateDialog'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import { useNostr } from '@/providers/NostrProvider'
import { useFetchProfile } from '@/hooks'
import { toast } from 'sonner'

type TTab = 'discover' | 'my' | 'invites'

const makeGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)
const GROUP_FACEPILE_REFRESH_INTERVAL_MS = 60 * 1000
const GROUP_FACEPILE_REFRESH_JITTER_MS = 10 * 1000

function GroupFacepile({ groupId, relay, show }: { groupId: string; relay?: string; show: boolean }) {
  const { t } = useTranslation()
  const { followList } = useNostr()
  const { getGroupMemberPreview, refreshGroupMemberPreview, groupMemberPreviewVersion } = useGroups()
  const { getRelayPeerCount } = useWorkerBridge()
  const [members, setMembers] = useState<string[] | null>(null)

  useEffect(() => {
    if (!show) {
      setMembers(null)
      return
    }
    let cancelled = false
    const cached = getGroupMemberPreview(groupId, relay)
    if (cached) {
      setMembers(cached.members)
      console.info('[GroupFacepile] cache read', {
        groupId,
        relay: relay || null,
        membersCount: cached.members.length,
        source: cached.source,
        authoritative: cached.authoritative,
        previewVersion: groupMemberPreviewVersion
      })
    }

    const load = async (force = false) => {
      try {
        const memberList = await refreshGroupMemberPreview(groupId, relay, {
          force,
          reason: force ? 'groups-page-facepile-interval' : 'groups-page-facepile-init'
        })
        if (!cancelled) {
          const latest = getGroupMemberPreview(groupId, relay)
          const shouldPreferLatest =
            !!latest &&
            latest.authoritative &&
            latest.members.length >= memberList.length
          const appliedMembers = shouldPreferLatest ? latest.members : memberList
          setMembers(appliedMembers)
          console.info('[GroupFacepile] applied preview', {
            groupId,
            relay: relay || null,
            membersCount: appliedMembers.length,
            force,
            preferredAuthoritativeCache: shouldPreferLatest,
            previewVersion: groupMemberPreviewVersion
          })
        }
      } catch (_err) {
        if (!cancelled) setMembers(cached?.members || [])
      }
    }

    load(!cached)
    let timer: number | null = null
    const scheduleRefresh = () => {
      const jitter = Math.floor(Math.random() * GROUP_FACEPILE_REFRESH_JITTER_MS)
      timer = window.setTimeout(async () => {
        if (cancelled) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          scheduleRefresh()
          return
        }
        await load(false)
        scheduleRefresh()
      }, GROUP_FACEPILE_REFRESH_INTERVAL_MS + jitter)
    }
    scheduleRefresh()

    return () => {
      cancelled = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [getGroupMemberPreview, groupId, relay, refreshGroupMemberPreview, show, groupMemberPreviewVersion])

  const sortedMembers = useMemo(() => {
    if (!members || !members.length) return []
    const list = [...members]
    list.sort((a, b) => {
      const aFollow = followList.includes(a)
      const bFollow = followList.includes(b)
      if (aFollow !== bFollow) return aFollow ? -1 : 1
      return 0
    })
    return list.slice(0, 3)
  }, [members, followList])

  if (!show || !members || members.length === 0 || sortedMembers.length === 0) return null

  const memberCountLabel = `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(
    members.length
  )} ${t('Members')}`
  const peerCount = getRelayPeerCount(groupId) || getRelayPeerCount(relay)
  const peerLabel =
    peerCount > 0 ? `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(peerCount)} ${t('online')}` : null

  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
      <div className="flex -space-x-2">
        {sortedMembers.map((pubkey) => (
          <div
            key={pubkey}
            className="h-5 w-5 rounded-full ring-2 ring-background overflow-hidden bg-muted"
          >
            <SimpleUserAvatar userId={pubkey} size="small" className="h-full w-full rounded-full" />
          </div>
        ))}
      </div>
      <div className="text-xs font-medium whitespace-nowrap truncate">
        {memberCountLabel}
        {peerLabel ? ` • ${peerLabel}` : ''}
      </div>
    </div>
  )
}

function InviteMembersBadge({ memberPubkeys }: { memberPubkeys?: string[] }) {
  const { t } = useTranslation()
  const normalized = useMemo(
    () =>
      Array.from(
        new Set((Array.isArray(memberPubkeys) ? memberPubkeys : []).map((pk) => String(pk || '').trim()).filter(Boolean))
      ),
    [memberPubkeys]
  )

  if (!normalized.length) return null
  const preview = normalized.slice(0, 3)
  const label = `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(normalized.length)} ${t('Members')}`

  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
      <div className="flex -space-x-2">
        {preview.map((pubkey) => (
          <div key={pubkey} className="h-5 w-5 rounded-full ring-2 ring-background overflow-hidden bg-muted">
            <SimpleUserAvatar userId={pubkey} size="small" className="h-full w-full rounded-full" />
          </div>
        ))}
      </div>
      <div className="text-xs font-medium whitespace-nowrap truncate">{label}</div>
    </div>
  )
}

function InviteSenderLabel({ userId }: { userId: string }) {
  const { profile } = useFetchProfile(userId)
  const fallback = `${userId.slice(0, 8)}...${userId.slice(-4)}`
  const label = profile?.shortName || profile?.metadata?.name || fallback
  return <span className="text-xs font-medium truncate max-w-[220px]">{label}</span>
}

const GroupsPage = forwardRef<TPageRef>((_, ref) => {
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current!)
  const { t } = useTranslation()
  const {
    discoveryGroups,
    invites,
    myGroupList,
    refreshDiscovery,
    refreshInvites,
    dismissInvite,
    markInviteAccepted,
    isLoadingDiscovery,
    discoveryError,
    invitesError,
    resolveRelayUrl
  } = useGroups()
  const { startJoinFlow, sendToWorker } = useWorkerBridge()
  const { pubkey } = useNostr()
  const [tab, setTab] = useState<TTab>('discover')
  const [search, setSearch] = useState('')
  const { push } = useSecondaryPage()
  const [showCreate, setShowCreate] = useState(false)
  const [joiningInviteId, setJoiningInviteId] = useState<string | null>(null)

  const inviteGroupIds = useMemo(() => new Set(invites.map((inv) => inv.groupId)), [invites])
  const filteredDiscovery = discoveryGroups.filter((g) => {
    const isMember = myGroupList.some((entry) => entry.groupId === g.id)
    const invited = inviteGroupIds.has(g.id)
    if (g.isPublic === false && !isMember && !invited) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return g.name.toLowerCase().includes(q) || (g.about ?? '').toLowerCase().includes(q)
  })

  const renderGroupCard = (groupId: string, relay?: string) => {
    const meta = discoveryGroups.find(
      (g) => g.id === groupId && (relay ? g.relay === relay : true)
    )
    const name = meta?.name || groupId
    const about = meta?.about
    const membersText = meta?.tags?.length ? `${meta.tags.length} tags` : null
    const picture = meta?.picture
    const initials = (name || 'GR').slice(0, 2).toUpperCase()

    return (
      <Card
        key={makeGroupKey(groupId, relay)}
        className="cursor-pointer transition-colors hover:bg-accent/50 overflow-hidden"
        onClick={() => {
          push(toGroup(groupId, relay))
        }}
      >
        <CardContent className="p-4 flex gap-3 items-start">
          <Avatar className="h-11 w-11 shrink-0">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="text-sm font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-lg truncate">{name}</div>
              <GroupFacepile
                groupId={groupId}
                relay={relay}
                show={meta?.isPublic !== false || myGroupList.some((entry) => entry.groupId === groupId)}
              />
            </div>
            {about && <div className="text-sm text-muted-foreground line-clamp-2">{about}</div>}
            {membersText && <div className="text-xs text-muted-foreground">{membersText}</div>}
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderDiscover = () => {
    if (isLoadingDiscovery) {
      return (
        <div className="flex flex-col items-center gap-3 text-muted-foreground py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
          <div>{t('Loading...')}</div>
        </div>
      )
    }
    if (discoveryError) {
      return (
        <div className="text-sm text-red-500">
          {t('Failed to load groups')}: {discoveryError}
        </div>
      )
    }
    if (!discoveryGroups.length) {
      return <div className="text-muted-foreground">{t('No groups found')}</div>
    }
    return (
      <div className="space-y-3">
        {filteredDiscovery.map((g) => renderGroupCard(g.id, g.relay))}
      </div>
    )
  }

  const renderMyGroups = () => {
    if (!myGroupList.length) {
      return <div className="text-muted-foreground">{t('No groups yet')}</div>
    }
    return (
      <div className="space-y-3">
        {myGroupList.map((entry) => renderGroupCard(entry.groupId, entry.relay))}
      </div>
    )
  }

  const handleUseInvite = async (inv: (typeof invites)[number]) => {
    if (!inv) return
    if (joiningInviteId) return
    const relayUrl = inv.relayUrl ?? (inv.relay ? resolveRelayUrl(inv.relay) : null) ?? inv.relay ?? null
    const relayKey = inv.relayKey ?? null
    const openJoin = !inv.token && inv.fileSharing !== false
    setJoiningInviteId(inv.event.id)
    try {
      console.info('[GroupsPage] Use invite', {
        groupId: inv.groupId,
        inviteId: inv.event?.id || null,
        openJoin,
        hasToken: !!inv.token,
        fileSharing: inv.fileSharing !== false,
        relayKey: relayKey ? String(relayKey).slice(0, 16) : null,
        relayUrl: relayUrl ? String(relayUrl).slice(0, 80) : null,
        hasBlindPeer: !!inv.blindPeer?.publicKey,
        coreRefsCount: Array.isArray(inv.cores) ? inv.cores.length : 0,
        hasWriterCore: !!inv.writerCore,
        hasWriterCoreHex: !!inv.writerCoreHex,
        hasAutobaseLocal: !!inv.autobaseLocal,
        writerSecretLen: inv.writerSecret ? String(inv.writerSecret).length : 0,
        hasFastForward: !!inv.fastForward
      })
      if (sendToWorker && pubkey && inv.token) {
        sendToWorker({
          type: 'update-auth-data',
          data: {
            relayKey,
            publicIdentifier: inv.groupId,
            pubkey,
            token: inv.token
          }
        }).catch(() => {})
      }

      await startJoinFlow(inv.groupId, {
        fileSharing: inv.fileSharing !== false,
        openJoin,
        token: inv.token,
        relayKey,
        relayUrl,
        blindPeer: inv.blindPeer,
        cores: inv.cores,
        writerCore: inv.writerCore,
        writerCoreHex: inv.writerCoreHex,
        autobaseLocal: inv.autobaseLocal,
        writerSecret: inv.writerSecret,
        fastForward: inv.fastForward || undefined
      })

      markInviteAccepted(inv.event.id, inv.groupId)
      push(toGroup(inv.groupId, relayUrl || inv.relay))
    } catch (err) {
      console.error('Failed to start join flow from invite', err)
      toast.error(t('Failed to start join flow'))
    } finally {
      setJoiningInviteId(null)
    }
  }

  const handleDismissInvite = (inv: (typeof invites)[number]) => {
    if (!inv?.event?.id) return
    dismissInvite(inv.event.id)
  }

  const renderInvites = () => {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {invites.length ? t('Invites') : t('No invites')}
          </div>
          <Button variant="ghost" size="sm" onClick={() => refreshInvites()}>
            <Loader2 className="w-4 h-4 mr-2" />
            {t('Refresh')}
          </Button>
        </div>
        {invitesError && <div className="text-sm text-red-500">{invitesError}</div>}
        {invites.map((inv) => (
          <div key={inv.event.id} className="space-y-1">
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted/70 px-2 py-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-muted-foreground shrink-0">{t('from')}</span>
                <div className="h-7 w-7 rounded-full overflow-hidden shrink-0">
                  <SimpleUserAvatar userId={inv.event.pubkey} size="small" className="h-7 w-7 rounded-full" />
                </div>
                <InviteSenderLabel userId={inv.event.pubkey} />
              </div>
              <FormattedTimestamp timestamp={inv.event.created_at} className="text-xs text-muted-foreground shrink-0" />
            </div>
            <Card className="overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <Avatar className="h-10 w-10 shrink-0">
                      {inv.groupPicture && <AvatarImage src={inv.groupPicture} alt={inv.groupName || inv.name || inv.groupId} />}
                      <AvatarFallback className="text-xs font-semibold">
                        {(inv.groupName || inv.name || inv.groupId || 'GR').slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="font-semibold truncate max-w-[260px]">
                        {inv.groupName || inv.name || inv.groupId}
                      </div>
                      <div className="mt-1">
                        <InviteMembersBadge memberPubkeys={inv.authorizedMemberPubkeys} />
                      </div>
                      {inv.relay && (
                        <div className="text-xs text-muted-foreground truncate max-w-[260px] mt-1">
                          {inv.relay}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 ml-auto shrink-0 flex-wrap">
                    <Button variant="outline" size="sm" onClick={() => handleDismissInvite(inv)}>
                      <X className="w-4 h-4 mr-1" />
                      {t('Dismiss')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={joiningInviteId === inv.event.id}
                      onClick={() => handleUseInvite(inv)}
                    >
                      {joiningInviteId === inv.event.id ? t('Joining…') : t('Use invite')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    )
  }

  return (
    <PrimaryPageLayout
      pageName="groups"
      ref={layoutRef}
      titlebar={<GroupsPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('Search groups...') as string}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button variant="ghost" size="icon" onClick={() => refreshDiscovery()}>
            <Loader2 className="w-4 h-4" />
          </Button>
          <Button onClick={() => setShowCreate(true)}>{t('Create')}</Button>
        </div>
        <Tabs value={tab} onValueChange={(val) => setTab(val as TTab)}>
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="discover">{t('Discover')}</TabsTrigger>
            <TabsTrigger value="my">{t('My Groups')}</TabsTrigger>
            <TabsTrigger value="invites">{t('Invites')}</TabsTrigger>
          </TabsList>
          <TabsContent value="discover" className="mt-4">
            {renderDiscover()}
          </TabsContent>
          <TabsContent value="my" className="mt-4">
            {renderMyGroups()}
          </TabsContent>
          <TabsContent value="invites" className="mt-4">
            {renderInvites()}
          </TabsContent>
        </Tabs>
      </div>
      <GroupCreateDialog open={showCreate} onOpenChange={setShowCreate} />
    </PrimaryPageLayout>
  )
})

GroupsPage.displayName = 'GroupsPage'

export default GroupsPage

function GroupsPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center h-full pl-3 [&_svg]:text-muted-foreground">
      <Users />
      <div className="text-lg font-semibold" style={{ fontSize: 'var(--title-font-size, 18px)' }}>
        {t('Groups')}
      </div>
    </div>
  )
}
