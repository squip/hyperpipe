import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, ChevronDown, ExternalLink, Globe, ShieldCheck, Upload, X } from 'lucide-react'

import { useFetchProfile } from '@/hooks/useFetchProfile'
import { formatPubkey, generateImageByPubkey } from '@/lib/pubkey'
import { simplifyUrl } from '@/lib/url'
import { cn } from '@/lib/utils'
import {
  getCreateGroupProgressLabel,
  getCreateGroupProgressTitle,
  getCreateGroupProgressValue,
  type CreateGroupProgressState
} from '@/lib/workflow-progress-ui'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import type { GatewayOperatorIdentity } from '@/services/electron-ipc.service'

import Uploader from '@/components/PostEditor/Uploader'
import WorkflowProgress from '@/components/WorkflowProgress'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

type AuthorizedGateway = {
  gatewayId: string
  publicUrl: string
  displayName: string
  region: string
  authMethod: string
  memberDelegationMode: string
  operatorPubkey: string
  operatorIdentity: GatewayOperatorIdentity | null
}

function normalizeVerifiedOperatorPubkey(
  operatorIdentity?: GatewayOperatorIdentity | null
): string {
  if (!operatorIdentity || typeof operatorIdentity !== 'object') return ''
  return typeof operatorIdentity.pubkey === 'string'
    ? operatorIdentity.pubkey.trim().toLowerCase()
    : ''
}

function gatewayTitle(gateway: AuthorizedGateway): string {
  return gateway.displayName || simplifyUrl(gateway.publicUrl) || gateway.gatewayId
}

function gatewaySecondary(gateway: AuthorizedGateway): string {
  const simplifiedUrl = simplifyUrl(gateway.publicUrl)
  return gateway.region ? `${gateway.region} • ${simplifiedUrl}` : simplifiedUrl
}

function GatewayModeOption({
  icon,
  title,
  subtitle,
  isSelected
}: {
  icon: ReactNode
  title: string
  subtitle: string
  isSelected: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-medium">{title}</div>
          {isSelected && <Check className="h-4 w-4 text-primary" />}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  )
}

function GatewayOptionPreview({
  gateway,
  isSelected,
  compact = false
}: {
  gateway: AuthorizedGateway
  isSelected: boolean
  compact?: boolean
}) {
  const verifiedOperatorPubkey = normalizeVerifiedOperatorPubkey(gateway.operatorIdentity)
  const { profile } = useFetchProfile(verifiedOperatorPubkey || undefined)
  const operatorName = verifiedOperatorPubkey
    ? profile?.shortName?.trim() || formatPubkey(verifiedOperatorPubkey)
    : ''
  const operatorImage = verifiedOperatorPubkey
    ? profile?.metadata?.picture || generateImageByPubkey(verifiedOperatorPubkey)
    : ''

  return (
    <div className="flex min-w-0 items-center gap-3">
      {verifiedOperatorPubkey ? (
        <Avatar className={cn(compact ? 'h-9 w-9' : 'h-10 w-10', 'shrink-0 ring-1 ring-border/70')}>
          <AvatarImage src={operatorImage} alt={operatorName || gatewayTitle(gateway)} />
          <AvatarFallback>{(operatorName || 'G').slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      ) : (
        <div
          className={cn(
            compact ? 'h-9 w-9' : 'h-10 w-10',
            'flex shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground'
          )}
        >
          <Globe className="h-4 w-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-medium">{gatewayTitle(gateway)}</div>
          {verifiedOperatorPubkey && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              <ShieldCheck className="h-3 w-3" />
              Verified
            </span>
          )}
          {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </div>
        <div className="truncate text-xs text-muted-foreground">{gatewaySecondary(gateway)}</div>
        {verifiedOperatorPubkey && (
          <div className="truncate text-xs text-muted-foreground">{operatorName}</div>
        )}
      </div>
    </div>
  )
}

function SelectedGatewayDetails({ gateway }: { gateway: AuthorizedGateway }) {
  const verifiedOperatorPubkey = normalizeVerifiedOperatorPubkey(gateway.operatorIdentity)
  const { profile } = useFetchProfile(verifiedOperatorPubkey || undefined)
  const operatorName = verifiedOperatorPubkey
    ? profile?.shortName?.trim() || formatPubkey(verifiedOperatorPubkey)
    : ''
  const operatorImage = verifiedOperatorPubkey
    ? profile?.metadata?.picture || generateImageByPubkey(verifiedOperatorPubkey)
    : ''

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          {verifiedOperatorPubkey ? (
            <Avatar className="h-11 w-11 shrink-0 ring-1 ring-border/70">
              <AvatarImage src={operatorImage} alt={operatorName || gatewayTitle(gateway)} />
              <AvatarFallback>{(operatorName || 'G').slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
          ) : (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground">
              <Globe className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{gatewayTitle(gateway)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {gatewaySecondary(gateway)}
            </div>
            {verifiedOperatorPubkey && (
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                <span className="truncate">{operatorName}</span>
              </div>
            )}
          </div>
        </div>
        <a
          href={gateway.publicUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  )
}

export default function GroupCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { createHyperpipeRelayGroup } = useGroups()
  const { publicGatewayStatus } = useWorkerBridge()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [gatewaySelection, setGatewaySelection] = useState<string>('direct')
  const [manualGatewayOrigin, setManualGatewayOrigin] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [gatewayPickerOpen, setGatewayPickerOpen] = useState(false)
  const [createProgress, setCreateProgress] = useState<CreateGroupProgressState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const authorizedGateways = useMemo(() => {
    const rows = Array.isArray((publicGatewayStatus as any)?.authorizedGateways)
      ? ((publicGatewayStatus as any).authorizedGateways as Array<Record<string, unknown>>)
      : []
    return rows
      .map((row) => {
        const gatewayId =
          typeof row.gatewayId === 'string' ? row.gatewayId.trim().toLowerCase() : ''
        const publicUrl = typeof row.publicUrl === 'string' ? row.publicUrl.trim() : ''
        const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : ''
        const region = typeof row.region === 'string' ? row.region.trim() : ''
        const authMethod = typeof row.authMethod === 'string' ? row.authMethod.trim() : ''
        const memberDelegationMode =
          typeof row.memberDelegationMode === 'string' ? row.memberDelegationMode.trim() : ''
        const operatorPubkey =
          typeof row.operatorPubkey === 'string' ? row.operatorPubkey.trim() : ''
        const operatorIdentity =
          row.operatorIdentity && typeof row.operatorIdentity === 'object'
            ? (row.operatorIdentity as GatewayOperatorIdentity)
            : null
        const isExpired = row.isExpired === true
        if (!gatewayId || !publicUrl || isExpired) return null
        return {
          gatewayId,
          publicUrl,
          displayName,
          region,
          authMethod,
          memberDelegationMode,
          operatorPubkey,
          operatorIdentity
        }
      })
      .filter((row): row is AuthorizedGateway => !!row)
  }, [publicGatewayStatus])

  const normalizeHttpOrigin = (value: string): string | null => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return null
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.origin
    } catch {
      return null
    }
  }

  const selectedGateway = useMemo(() => {
    if (!gatewaySelection.startsWith('gateway:')) return null
    return (
      authorizedGateways.find((gateway) => `gateway:${gateway.gatewayId}` === gatewaySelection) ||
      null
    )
  }, [authorizedGateways, gatewaySelection])

  const matchedManualGateway = useMemo(() => {
    const manualOrigin = normalizeHttpOrigin(manualGatewayOrigin)
    if (!manualOrigin) return null
    return (
      authorizedGateways.find(
        (gateway) => normalizeHttpOrigin(gateway.publicUrl) === manualOrigin
      ) || null
    )
  }, [authorizedGateways, manualGatewayOrigin])

  useEffect(() => {
    if (open) return
    setCreateProgress(null)
    setSaveError(null)
  }, [open])

  const progressTitle = getCreateGroupProgressTitle(createProgress?.phase)
  const progressDetail = getCreateGroupProgressLabel(createProgress?.phase)
  const progressValue = getCreateGroupProgressValue(createProgress?.phase)
  const showProgressSection = Boolean(createProgress || saveError)

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSaving) return
    if (!nextOpen) {
      setGatewayPickerOpen(false)
    }
    onOpenChange(nextOpen)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    setIsSaving(true)
    setSaveError(null)
    try {
      let gatewayOrigin: string | null = null
      let gatewayId: string | null = null
      let gatewayAuthMethod: string | null = null
      let gatewayDelegation: string | null = null
      let gatewaySponsorPubkey: string | null = null
      let directJoinOnly = false

      if (gatewaySelection === 'direct') {
        directJoinOnly = true
      } else if (gatewaySelection === 'manual') {
        gatewayOrigin = normalizeHttpOrigin(manualGatewayOrigin)
        if (!gatewayOrigin) {
          toast.error(t('Enter a valid gateway URL'))
          setIsSaving(false)
          return
        }
      } else if (gatewaySelection.startsWith('gateway:')) {
        const selected = authorizedGateways.find(
          (gateway) => `gateway:${gateway.gatewayId}` === gatewaySelection
        )
        if (!selected) {
          toast.error(t('Selected gateway is unavailable or not approved'))
          setIsSaving(false)
          return
        }
        gatewayId = selected.gatewayId
        gatewayOrigin = normalizeHttpOrigin(selected.publicUrl)
        gatewayAuthMethod = selected.authMethod || null
        gatewayDelegation = selected.memberDelegationMode || null
        gatewaySponsorPubkey = selected.operatorPubkey || null
      }

      if (gatewaySelection === 'manual' && gatewayOrigin) {
        const approvedManual = authorizedGateways.find(
          (gateway) => normalizeHttpOrigin(gateway.publicUrl) === gatewayOrigin
        )
        if (!approvedManual) {
          toast.error(t('Manual gateway URL is not approved for this account'))
          setIsSaving(false)
          return
        }
        gatewayId = approvedManual.gatewayId
        gatewayAuthMethod = approvedManual.authMethod || null
        gatewayDelegation = approvedManual.memberDelegationMode || null
        gatewaySponsorPubkey = approvedManual.operatorPubkey || null
      }

      await createHyperpipeRelayGroup(
        {
          name: name.trim(),
          about: about.trim(),
          isPublic,
          isOpen,
          picture: picture.trim() || undefined,
          fileSharing: true,
          gatewayOrigin,
          gatewayId,
          gatewayAuthMethod,
          gatewayDelegation,
          gatewaySponsorPubkey,
          directJoinOnly
        },
        {
          onProgress: (state) => {
            if (state.phase === 'error') {
              setSaveError(state.error || t('Failed to create group'))
              return
            }
            setSaveError(null)
            setCreateProgress(state)
          }
        }
      )
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
      setName('')
      setAbout('')
      setPicture('')
      setGatewaySelection('direct')
      setManualGatewayOrigin('')
      setGatewayPickerOpen(false)
      setCreateProgress(null)
      setSaveError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message)
      toast.error(t('Failed to create group'), {
        description: message
      })
      console.error(err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl"
        withoutClose={isSaving}
        onEscapeKeyDown={isSaving ? (event) => event.preventDefault() : undefined}
        onInteractOutside={isSaving ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('New Group')}</DialogTitle>
          <DialogDescription>
            {t('Set your group details, cover image, and join access before publishing it.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className={cn('space-y-4', isSaving && 'pointer-events-none opacity-60')}>
            <div className="space-y-2">
              <Label>{t('Group Name')}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('Enter group name') as string}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {t('Description')} ({t('optional')})
              </Label>
              <Textarea
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder={t('Enter group description') as string}
                rows={3}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {t('Cover Image')} ({t('optional')})
              </Label>
              <Tabs defaultValue="upload" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="url" disabled={isSaving}>
                    URL
                  </TabsTrigger>
                  <TabsTrigger value="upload" disabled={isSaving}>
                    {t('Upload')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="url" className="space-y-2">
                  <Input
                    value={picture}
                    onChange={(e) => setPicture(e.target.value)}
                    placeholder="https://..."
                    disabled={isSaving}
                  />
                </TabsContent>
                <TabsContent value="upload" className="space-y-2">
                  {isSaving ? (
                    <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-lg border-2 border-dashed">
                      {!picture && (
                        <div className="p-6 text-center">
                          <Upload className="mx-auto mb-2 h-8 w-8 opacity-50" />
                          <p className="text-sm text-muted-foreground">
                            {t('Click to upload an image')}
                          </p>
                        </div>
                      )}
                      {picture && (
                        <img src={picture} alt="Preview" className="h-full w-full object-cover" />
                      )}
                    </div>
                  ) : (
                    <Uploader accept="image/*" onUploadSuccess={({ url }) => setPicture(url)}>
                      <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-lg border-2 border-dashed transition-colors hover:bg-accent/50">
                        {!picture && (
                          <div className="p-6 text-center">
                            <Upload className="mx-auto mb-2 h-8 w-8 opacity-50" />
                            <p className="text-sm text-muted-foreground">
                              {t('Click to upload an image')}
                            </p>
                          </div>
                        )}
                        {picture && (
                          <>
                            <img
                              src={picture}
                              alt="Preview"
                              className="h-full w-full object-cover"
                            />
                            <Button
                              variant="destructive"
                              size="icon"
                              className="absolute right-2 top-2"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPicture('')
                              }}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </Uploader>
                  )}
                </TabsContent>
              </Tabs>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('Public Group')}</Label>
                <div className="text-xs text-muted-foreground">
                  {t('Anyone can discover this group')}
                </div>
              </div>
              <Switch checked={isPublic} onCheckedChange={setIsPublic} disabled={isSaving} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('Open Membership')}</Label>
                <div className="text-xs text-muted-foreground">
                  {t('Anyone can join and invite others')}
                </div>
              </div>
              <Switch checked={isOpen} onCheckedChange={setIsOpen} disabled={isSaving} />
            </div>
            <div className="space-y-2">
              <Label>{t('Public Gateway')}</Label>
              <Popover open={gatewayPickerOpen} onOpenChange={setGatewayPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={gatewayPickerOpen}
                    className="h-auto w-full justify-between px-3 py-3 text-left"
                    disabled={isSaving}
                  >
                    <div className="min-w-0 flex-1">
                      {selectedGateway ? (
                        <GatewayOptionPreview
                          gateway={selectedGateway}
                          isSelected={false}
                          compact
                        />
                      ) : gatewaySelection === 'manual' ? (
                        <GatewayModeOption
                          icon={<Globe className="h-4 w-4" />}
                          title={t('Manual gateway URL') as string}
                          subtitle={
                            manualGatewayOrigin.trim()
                              ? simplifyUrl(manualGatewayOrigin.trim())
                              : (t('Use an approved gateway origin manually') as string)
                          }
                          isSelected={false}
                        />
                      ) : (
                        <GatewayModeOption
                          icon={<Globe className="h-4 w-4" />}
                          title={t('Direct-join only (no gateway)') as string}
                          subtitle={t('Keep this group off the public gateway network') as string}
                          isSelected={false}
                        />
                      )}
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] p-0">
                  <Command className="max-h-80">
                    <CommandList scrollAreaClassName="max-h-80">
                      <CommandGroup heading={t('Gateway mode') as string}>
                        <CommandItem
                          value="direct"
                          onSelect={() => {
                            setGatewaySelection('direct')
                            setGatewayPickerOpen(false)
                          }}
                          className="py-3"
                        >
                          <GatewayModeOption
                            icon={<Globe className="h-4 w-4" />}
                            title={t('Direct-join only (no gateway)') as string}
                            subtitle={t('Keep this group off the public gateway network') as string}
                            isSelected={gatewaySelection === 'direct'}
                          />
                        </CommandItem>
                        <CommandItem
                          value="manual"
                          onSelect={() => {
                            setGatewaySelection('manual')
                            setGatewayPickerOpen(false)
                          }}
                          className="py-3"
                        >
                          <GatewayModeOption
                            icon={<Globe className="h-4 w-4" />}
                            title={t('Manual gateway URL') as string}
                            subtitle={t('Enter an approved gateway URL manually') as string}
                            isSelected={gatewaySelection === 'manual'}
                          />
                        </CommandItem>
                      </CommandGroup>
                      {!!authorizedGateways.length && <CommandSeparator />}
                      {!!authorizedGateways.length && (
                        <CommandGroup heading={t('Approved gateways') as string}>
                          {authorizedGateways.map((gateway) => (
                            <CommandItem
                              key={gateway.gatewayId}
                              value={`${gatewayTitle(gateway)} ${gateway.publicUrl} ${normalizeVerifiedOperatorPubkey(gateway.operatorIdentity)}`}
                              onSelect={() => {
                                setGatewaySelection(`gateway:${gateway.gatewayId}`)
                                setGatewayPickerOpen(false)
                              }}
                              className="py-3"
                            >
                              <GatewayOptionPreview
                                gateway={gateway}
                                isSelected={gatewaySelection === `gateway:${gateway.gatewayId}`}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {gatewaySelection === 'manual' && (
                <Input
                  value={manualGatewayOrigin}
                  onChange={(event) => setManualGatewayOrigin(event.target.value)}
                  placeholder="https://gateway.example.com"
                  disabled={isSaving}
                />
              )}
              {gatewaySelection === 'manual' && matchedManualGateway && (
                <SelectedGatewayDetails gateway={matchedManualGateway} />
              )}
              <div className="text-xs text-muted-foreground">
                {authorizedGateways.length
                  ? t(
                      'Only gateways that already approved this account for hosting are shown here.'
                    )
                  : t(
                      'No approved gateways available yet. You can still create a direct-join-only group.'
                    )}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(
                  'This gateway assignment is stored on group metadata and used for relay-specific join/mirror routing.'
                )}
              </div>
            </div>
          </div>
          {showProgressSection && (
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
              <WorkflowProgress
                title={progressTitle}
                detail={progressDetail}
                value={progressValue}
              />
              {saveError && <div className="text-sm text-red-500">{saveError}</div>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={isSaving}>
              {t('Cancel')}
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? t('Creating...') : t('Create Group')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
