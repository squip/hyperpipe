import PostRelaySelector from '@/components/PostEditor/PostRelaySelector'
import UserAvatar from '@/components/UserAvatar'
import Nip05 from '@/components/Nip05'
import Username from '@/components/Username'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useSearchProfiles } from '@/hooks/useSearchProfiles'
import type { GroupRelayTarget, RelayDisplayMeta } from '@/lib/relay-targets'
import { cn } from '@/lib/utils'
import { ArrowLeft, ArrowRight, Check, Search, Upload, UserPlus } from 'lucide-react'
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

export type CreateChatModalPayload = {
  title: string
  description: string
  members: string[]
  imageFile: File | null
  relayUrls: string[]
}

type CreateChatStepId = 'details' | 'members' | 'relays'

const CREATE_CHAT_STEPS: Array<{
  id: CreateChatStepId
  label: string
  description: string
}> = [
  {
    id: 'details',
    label: 'Details',
    description: 'Name the chat and optionally add context.'
  },
  {
    id: 'members',
    label: 'Members',
    description: 'Choose who should be invited to the conversation.'
  },
  {
    id: 'relays',
    label: 'Relays',
    description: 'Review the setup and choose where the chat should publish.'
  }
]

function normalizeCreateChatPubkey(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed.toLowerCase()
  return null
}

function CreateChatFieldShell({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-ring/70 focus-within:shadow-[0_0_0_1px_hsl(var(--ring)/0.2)]',
        className
      )}
    >
      {children}
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
  const [currentStep, setCurrentStep] = useState<CreateChatStepId>('details')
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
        (profile) =>
          profile.pubkey &&
          normalizeCreateChatPubkey(profile.pubkey) !==
            normalizeCreateChatPubkey(myPubkey || '')
      ),
    [inviteProfiles, myPubkey]
  )

  const normalizedInviteSearch = inviteSearch.trim()
  const showInviteResults = Boolean(normalizedInviteSearch)
  const currentStepIndex = CREATE_CHAT_STEPS.findIndex((step) => step.id === currentStep)
  const maxUnlockedStepIndex = selectedInvitees.length > 0 ? CREATE_CHAT_STEPS.length - 1 : 1
  const canAdvanceCurrentStep =
    currentStep === 'details'
      ? true
      : currentStep === 'members'
        ? selectedInvitees.length > 0
        : selectedRelayUrls.length > 0
  const canSubmit = selectedInvitees.length > 0 && selectedRelayUrls.length > 0
  const hasThumbnailPreview = Boolean(imagePreviewUrl)

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
    setCurrentStep('details')
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

  const handleNextStep = () => {
    if (currentStep === 'details') {
      setCurrentStep('members')
      return
    }
    if (currentStep === 'members' && selectedInvitees.length > 0) {
      setCurrentStep('relays')
    }
  }

  const handlePreviousStep = () => {
    if (currentStep === 'relays') {
      setCurrentStep('members')
      return
    }
    if (currentStep === 'members') {
      setCurrentStep('details')
    }
  }

  const handleCreate = async () => {
    if (!selectedInvitees.length) {
      setCurrentStep('members')
      return
    }
    if (!selectedRelayUrls.length) {
      setCurrentStep('relays')
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

  const renderStepContent = () => {
    if (currentStep === 'details') {
      return (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{t('Chat details')}</div>
            <p className="text-sm text-muted-foreground">
              {t('Give the chat a name and add any optional context you want members to see.')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-chat-title">{t('Chat title')}</Label>
            <CreateChatFieldShell>
              <Input
                id="create-chat-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('Give this chat a name') as string}
                className="h-11 rounded-xl border-0 bg-transparent px-4 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={busy}
              />
            </CreateChatFieldShell>
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-chat-description">{t('Description')}</Label>
            <CreateChatFieldShell>
              <Textarea
                id="create-chat-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('Add context for members joining this chat (optional)') as string}
                className="min-h-[120px] resize-y rounded-xl border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={busy}
              />
            </CreateChatFieldShell>
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
                    className="h-16 w-16 shrink-0 rounded-lg object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{imageFile?.name}</div>
                    <div className="text-xs text-muted-foreground">{t('Selected image')}</div>
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
      )
    }

    if (currentStep === 'members') {
      return (
        <section className="space-y-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{t('Invite members')}</div>
            <p className="text-sm text-muted-foreground">
              {t('Search for people to invite, then review the final member list below.')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-chat-invite-search">{t('Search users')}</Label>
            <CreateChatFieldShell className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="create-chat-invite-search"
                value={inviteSearch}
                onChange={(event) => setInviteSearch(event.target.value)}
                placeholder={t('Search users...') as string}
                className="h-11 rounded-xl border-0 bg-transparent pl-10 pr-4 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={busy}
              />
            </CreateChatFieldShell>
          </div>

          {showInviteResults ? (
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('Search results')}</div>
              <Card className="overflow-hidden">
                <ScrollArea className="max-h-72">
                  <CardContent className="space-y-2 p-3">
                    {isSearchingInvites ? (
                      <div className="py-3 text-sm text-muted-foreground">{t('Searching...')}</div>
                    ) : null}
                    {!isSearchingInvites && inviteCandidateProfiles.length === 0 ? (
                      <div className="py-3 text-sm text-muted-foreground">
                        {t('No users found')}
                      </div>
                    ) : null}
                    {!isSearchingInvites &&
                      inviteCandidateProfiles.map((profile) => {
                        const normalizedPubkey = normalizeCreateChatPubkey(profile.pubkey || '')
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
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-3 py-3 text-sm text-muted-foreground">
              {t('Search for users to invite')}
            </div>
          )}

          <div className="space-y-2">
            <div className="text-sm font-medium">
              {t('Selected members')} ({selectedInvitees.length})
            </div>
            {selectedInvitees.length > 0 ? (
              <Card className="overflow-hidden">
                <ScrollArea className="max-h-72">
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
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-3 py-3 text-sm text-muted-foreground">
                {t('Add at least one member to continue')}
              </div>
            )}
          </div>
        </section>
      )
    }

    return (
      <section className="space-y-5 rounded-2xl border border-border/70 bg-card/60 p-4 sm:p-5">
        <div className="space-y-1">
          <div className="text-sm font-semibold">{t('Review and relays')}</div>
          <p className="text-sm text-muted-foreground">
            {t('Confirm the chat details and choose which relays should carry this conversation.')}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border/70 bg-background px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t('Title')}
            </div>
            <div className="mt-1 truncate text-sm font-semibold">
              {title.trim() || t('Untitled chat')}
            </div>
            {description.trim() ? (
              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {description.trim()}
              </div>
            ) : null}
          </div>
          <div className="rounded-xl border border-border/70 bg-background px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t('Members')}
            </div>
            <div className="mt-1 text-sm font-semibold">{selectedInvitees.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('Selected for the first invite wave')}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 bg-background px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t('Thumbnail')}
            </div>
            <div className="mt-1 truncate text-sm font-semibold">
              {imageFile?.name || t('No image selected')}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {imageFile ? t('Ready to upload after creation') : t('Optional')}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-sm font-medium">{t('Post to relays')}</div>
            <p className="text-sm text-muted-foreground">
              {t('The selected relays will be used for the chat shell and future conversation events.')}
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-background p-3">
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
          </div>
        </div>
      </section>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(96vw,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        withoutClose={busy}
        onEscapeKeyDown={busy ? (event) => event.preventDefault() : undefined}
        onInteractOutside={busy ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5">
          <div className="space-y-1">
            <DialogTitle>{t('Create chat')}</DialogTitle>
            <DialogDescription>
              {t('Move through the setup step by step, then create the chat when everything looks right.')}
            </DialogDescription>
          </div>
          <div className="grid grid-cols-1 gap-2 pt-4 sm:grid-cols-3">
            {CREATE_CHAT_STEPS.map((step, index) => {
              const isActive = currentStep === step.id
              const isReachable = index <= maxUnlockedStepIndex
              const isComplete =
                (step.id === 'details' &&
                  Boolean(title.trim() || description.trim() || imageFile) &&
                  currentStepIndex > index) ||
                (step.id === 'members' &&
                  selectedInvitees.length > 0 &&
                  currentStepIndex > index) ||
                (step.id === 'relays' && canSubmit && currentStepIndex > index)

              return (
                <button
                  key={step.id}
                  type="button"
                  aria-current={isActive ? 'step' : undefined}
                  disabled={busy || !isReachable}
                  onClick={() => setCurrentStep(step.id)}
                  className={cn(
                    'flex min-w-0 items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                    isActive
                      ? 'border-ring/50 bg-accent/20'
                      : isReachable
                        ? 'border-border/70 bg-background hover:bg-accent/10'
                        : 'border-border/50 bg-muted/20 text-muted-foreground opacity-70'
                  )}
                >
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
                      isActive
                        ? 'border-ring/60 bg-ring/10 text-foreground'
                        : isComplete
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                          : 'border-border/70 bg-background text-muted-foreground'
                    )}
                  >
                    {isComplete ? <Check className="h-4 w-4" /> : index + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{t(step.label)}</div>
                    <div className="text-xs text-muted-foreground">{t(step.description)}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className={cn('space-y-5', busy && 'pointer-events-none opacity-60')}>
            {renderStepContent()}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-6 py-4">
          {error && currentStep === 'relays' ? (
            <div className="mb-3 text-sm text-red-500">{error}</div>
          ) : null}
          <DialogFooter className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {t('Step')} {currentStepIndex + 1} {t('of')} {CREATE_CHAT_STEPS.length}
            </div>
            <div className="flex items-center justify-end gap-2">
              {currentStep === 'details' ? (
                <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
                  {t('Cancel')}
                </Button>
              ) : (
                <Button variant="ghost" onClick={handlePreviousStep} disabled={busy}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('Back')}
                </Button>
              )}

              {currentStep !== 'relays' ? (
                <Button onClick={handleNextStep} disabled={busy || !canAdvanceCurrentStep}>
                  {t('Next')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={handleCreate} disabled={busy || !canSubmit}>
                  {busy ? t('Creating...') : t('Create chat')}
                </Button>
              )}
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
