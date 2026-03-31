import Note from '@/components/Note'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn, isTouchDevice } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createCommentDraftEvent,
  createPollDraftEvent,
  createShortTextNoteDraftEvent,
  deleteDraftEventCache
} from '@/lib/draft-event'
import {
  appendGroupAttachmentTagsToDraft,
  createGroupFileMetadataDraftEvent,
  getGroupHyperdriveUploads
} from '@/lib/group-files'
import { useNostr } from '@/providers/NostrProvider'
import { useReply } from '@/providers/ReplyProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import postEditorCache from '@/services/post-editor-cache.service'
import { MediaUploadContext, MediaUploadResult } from '@/services/media-upload.service'
import { TPollCreateData } from '@/types'
import {
  buildGroupRelayDisplayMetaMap,
  buildGroupRelayTargets,
  getRelayIdentity,
  resolvePublishRelayUrls,
  type GroupRelayTarget
} from '@/lib/relay-targets'
import { ImageUp, ListTodo, LoaderCircle, Settings, Smile, X } from 'lucide-react'
import { Event } from '@jsr/nostr__tools/wasm'
import * as kinds from '@jsr/nostr__tools/kinds'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import EmojiPickerDialog from '../EmojiPickerDialog'
import Mentions from './Mentions'
import PollEditor from './PollEditor'
import PostOptions from './PostOptions'
import PostRelaySelector from './PostRelaySelector'
import PostTextarea, { TPostTextareaHandle } from './PostTextarea'
import Preview from './PostTextarea/Preview'
import Uploader from './Uploader'

type FailedUpload = {
  key: string
  fileName: string
  error: string
}

function getUploadFailureKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export default function PostContent({
  defaultContent = '',
  parentEvent,
  close,
  openFrom,
  groupContext,
  renderSections
}: {
  defaultContent?: string
  parentEvent?: Event
  close: () => void
  openFrom?: string[]
  groupContext?: {
    groupId: string
    relay?: string
    name?: string
    picture?: string
  }
  renderSections: (sections: {
    header: React.ReactNode | null
    body: React.ReactNode
    footer: React.ReactNode
  }) => React.ReactNode
}) {
  const { t } = useTranslation()
  const { pubkey, publish, checkLogin } = useNostr()
  const { addReplies } = useReply()
  const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()
  const { refreshRelaySubscriptions } = useWorkerBridge()
  const [text, setText] = useState('')
  const textareaRef = useRef<TPostTextareaHandle>(null)
  const [posting, setPosting] = useState(false)
  const [uploadProgresses, setUploadProgresses] = useState<
    { file: File; progress: number; cancel: () => void }[]
  >([])
  const [showMoreOptions, setShowMoreOptions] = useState(false)
  const [addClientTag, setAddClientTag] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [isNsfw, setIsNsfw] = useState(false)
  const [isPoll, setIsPoll] = useState(false)
  const [isProtectedEvent, setIsProtectedEvent] = useState(false)
  const [additionalRelayUrls, setAdditionalRelayUrls] = useState<string[]>([])
  const [pollCreateData, setPollCreateData] = useState<TPollCreateData>({
    isMultipleChoice: false,
    options: ['', ''],
    endsAt: undefined,
    relays: []
  })
  const [uploadedResults, setUploadedResults] = useState<MediaUploadResult[]>([])
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([])
  const [minPow, setMinPow] = useState(0)
  const allowEmoji = useMemo(() => !isTouchDevice(), [])
  const [view, setView] = useState<'edit' | 'preview'>('edit')
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
  const groupRelayDisplayMeta = useMemo(
    () => buildGroupRelayDisplayMetaMap(groupRelayTargets),
    [groupRelayTargets]
  )
  const groupRelayIdsByIdentity = useMemo(() => {
    const groupIdsByIdentity = new Map<string, Set<string>>()
    groupRelayTargets.forEach((target) => {
      const relayIdentity = target.relayIdentity || getRelayIdentity(target.relayUrl)
      if (!relayIdentity) return
      const existing = groupIdsByIdentity.get(relayIdentity) || new Set<string>()
      existing.add(target.groupId)
      groupIdsByIdentity.set(relayIdentity, existing)
    })
    return groupIdsByIdentity
  }, [groupRelayTargets])
  const groupUploadContext = useMemo<MediaUploadContext | undefined>(() => {
    if (!groupContext?.groupId) return undefined
    return {
      target: 'group-hyperdrive',
      groupId: groupContext.groupId,
      relayUrl: groupContext.relay,
      parentKind:
        parentEvent && parentEvent.kind !== kinds.ShortTextNote
          ? 1111
          : kinds.ShortTextNote
    }
  }, [groupContext?.groupId, groupContext?.relay, parentEvent])
  const uploadAccept = groupContext?.groupId
    ? 'image/*,video/*,audio/*,.html,text/html'
    : 'image/*,video/*,audio/*'
  const isFirstRender = useRef(true)
  const hasBlockingUploadFailures = !!groupContext?.groupId && failedUploads.length > 0
  const canPost = useMemo(() => {
    return (
      !!pubkey &&
      !!text &&
      !posting &&
      !uploadProgresses.length &&
      !hasBlockingUploadFailures &&
      (!isPoll || pollCreateData.options.filter((option) => !!option.trim()).length >= 2) &&
      (!isProtectedEvent || additionalRelayUrls.length > 0) &&
      (!groupContext || !!groupContext.groupId)
    )
  }, [
    pubkey,
    text,
    posting,
    uploadProgresses,
    hasBlockingUploadFailures,
    isPoll,
    pollCreateData,
    isProtectedEvent,
    additionalRelayUrls,
    groupContext
  ])

  const resolveRelayPublishTargets = async (relayUrls: string[]) => {
    return await resolvePublishRelayUrls({
      relayUrls,
      resolveRelayUrl,
      groupRelayTargets,
      refreshGroupRelay: async (groupId) => {
        await refreshRelaySubscriptions({
          publicIdentifier: groupId,
          reason: 'post-editor-relay-publish',
          timeoutMs: 12_000
        })
      }
    })
  }

  const appendSelectedGroupHTags = (
    draftEvent: { tags?: string[][] },
    relayUrls: string[]
  ) => {
    if (!relayUrls.length || groupRelayIdsByIdentity.size === 0) return

    const targetGroupIds = new Set<string>()
    relayUrls.forEach((relayUrl) => {
      const relayIdentity =
        getRelayIdentity(resolveRelayUrl(relayUrl) || relayUrl) || getRelayIdentity(relayUrl)
      if (!relayIdentity) return
      const groupIds = groupRelayIdsByIdentity.get(relayIdentity)
      if (!groupIds) return
      groupIds.forEach((groupId) => targetGroupIds.add(groupId))
    })

    if (targetGroupIds.size === 0) return

    draftEvent.tags = draftEvent.tags || []
    targetGroupIds.forEach((groupId) => {
      if (!draftEvent.tags?.some((tag) => tag[0] === 'h' && tag[1] === groupId)) {
        draftEvent.tags?.push(['h', groupId])
      }
    })
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      const cachedSettings = postEditorCache.getPostSettingsCache({
        defaultContent,
        parentEvent
      })
      if (cachedSettings) {
        setIsNsfw(cachedSettings.isNsfw ?? false)
        setIsPoll(cachedSettings.isPoll ?? false)
        setPollCreateData(
          cachedSettings.pollCreateData ?? {
            isMultipleChoice: false,
            options: ['', ''],
            endsAt: undefined,
            relays: []
          }
        )
        setAddClientTag(cachedSettings.addClientTag ?? false)
      }
      return
    }
    postEditorCache.setPostSettingsCache(
      { defaultContent, parentEvent },
      {
        isNsfw,
        isPoll,
        pollCreateData,
        addClientTag
      }
    )
  }, [defaultContent, parentEvent, isNsfw, isPoll, pollCreateData, addClientTag])

  const post = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    checkLogin(async () => {
      if (hasBlockingUploadFailures) {
        toast.error(t('Resolve failed uploads before posting. Retry upload or remove failed files.'))
        return
      }
      if (!canPost) return

      setPosting(true)
      try {
        const draftEvent =
          parentEvent && parentEvent.kind !== kinds.ShortTextNote
            ? await createCommentDraftEvent(text, parentEvent, mentions, {
                addClientTag,
                protectedEvent: isProtectedEvent,
                isNsfw
              })
            : isPoll
              ? await createPollDraftEvent(pubkey!, text, mentions, pollCreateData, {
                  addClientTag,
                  isNsfw
                })
              : await createShortTextNoteDraftEvent(text, mentions, {
                  parentEvent,
                  addClientTag,
                  protectedEvent: isProtectedEvent,
                  isNsfw
                })

        if (groupContext?.groupId) {
          draftEvent.tags = draftEvent.tags || []
          if (!draftEvent.tags.some((tag) => tag[0] === 'h' && tag[1] === groupContext.groupId)) {
            draftEvent.tags.push(['h', groupContext.groupId])
          }
          appendGroupAttachmentTagsToDraft(draftEvent, uploadedResults)
          const groupFileDrafts = getGroupHyperdriveUploads(uploadedResults)
            .map((upload) => createGroupFileMetadataDraftEvent(upload, groupContext.groupId))
            .filter((event): event is NonNullable<ReturnType<typeof createGroupFileMetadataDraftEvent>> => Boolean(event))

          if (groupFileDrafts.length > 0) {
            for (const fileDraft of groupFileDrafts) {
              await publishGroupFileMetadataWithRetry(fileDraft)
            }
          }
        }

        if (!groupContext) {
          appendSelectedGroupHTags(
            draftEvent,
            additionalRelayUrls.length > 0 ? additionalRelayUrls : openFrom || []
          )
        }

        let relayUrlsForProtectedPublish = additionalRelayUrls
        if (!groupContext && additionalRelayUrls.length > 0) {
          relayUrlsForProtectedPublish = await resolveRelayPublishTargets(additionalRelayUrls)
        }

        let groupContextRelayUrls: string[] = []
        if (groupContext?.relay) {
          groupContextRelayUrls = await resolveRelayPublishTargets([groupContext.relay])
        }

        const newEvent = await publish(draftEvent, {
          specifiedRelayUrls: groupContextRelayUrls.length
            ? groupContextRelayUrls
            : isProtectedEvent
              ? relayUrlsForProtectedPublish
              : undefined,
          additionalRelayUrls: isPoll ? pollCreateData.relays : relayUrlsForProtectedPublish,
          minPow
        })
        postEditorCache.clearPostCache({ defaultContent, parentEvent })
        deleteDraftEventCache(draftEvent)
        addReplies([newEvent])
        setUploadedResults([])
        setFailedUploads([])
        close()
      } catch (error) {
        const errors = error instanceof AggregateError ? error.errors : [error]
        errors.forEach((err) => {
          toast.error(
            `${t('Failed to post')}: ${err instanceof Error ? err.message : String(err)}`,
            { duration: 10_000 }
          )
          console.error(err)
        })
        return
      } finally {
        setPosting(false)
      }
      toast.success(t('Post successful'), { duration: 2000 })
    })
  }

  const handlePollToggle = () => {
    if (parentEvent) return

    setIsPoll((prev) => !prev)
  }

  const handleUploadStart = (file: File, cancel: () => void) => {
    setUploadProgresses((prev) => [...prev, { file, progress: 0, cancel }])
  }

  const handleUploadProgress = (file: File, progress: number) => {
    setUploadProgresses((prev) =>
      prev.map((item) => (item.file === file ? { ...item, progress } : item))
    )
  }

  const handleUploadEnd = (file: File) => {
    setUploadProgresses((prev) => prev.filter((item) => item.file !== file))
  }

  const handleUploadSuccess = (result: MediaUploadResult, file?: File) => {
    if (file) {
      const key = getUploadFailureKey(file)
      setFailedUploads((prev) => prev.filter((item) => item.key !== key))
    }
    setUploadedResults((prev) => {
      if (!result?.url) return prev
      if (prev.some((item) => item.url === result.url)) return prev
      return [...prev, result]
    })
  }

  const handleUploadError = (file: File, error: Error) => {
    if (!groupContext?.groupId) return
    const key = getUploadFailureKey(file)
    const next: FailedUpload = {
      key,
      fileName: file.name || t('Unknown file'),
      error: error?.message || t('Upload failed')
    }
    setFailedUploads((prev) => {
      const index = prev.findIndex((item) => item.key === key)
      if (index === -1) return [...prev, next]
      const copy = [...prev]
      copy[index] = next
      return copy
    })
  }

  const dismissFailedUpload = (key: string) => {
    setFailedUploads((prev) => prev.filter((item) => item.key !== key))
  }

  const publishGroupFileMetadataWithRetry = async (draftEvent: NonNullable<ReturnType<typeof createGroupFileMetadataDraftEvent>>) => {
    if (!groupContext?.relay) {
      throw new Error('Missing group relay URL for group file metadata publish')
    }
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const groupRelayUrls = await resolveRelayPublishTargets([groupContext.relay])
        if (!groupRelayUrls.length) {
          throw new Error('Unable to resolve group relay publish URL')
        }
        await publish(draftEvent, {
          specifiedRelayUrls: groupRelayUrls,
          additionalRelayUrls: groupRelayUrls
        })
        return
      } catch (error) {
        lastError = error
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  const groupDisplayName = groupContext?.name || groupContext?.groupId
  const groupInitials = (groupDisplayName || 'GR').slice(0, 2).toUpperCase()

  const header = parentEvent ? null : (
    <div className="flex items-center justify-between gap-2">
      <Tabs value={view} onValueChange={(v) => setView(v as 'edit' | 'preview')}>
        <TabsList>
          <TabsTrigger value="edit">{t('Edit')}</TabsTrigger>
          <TabsTrigger value="preview">{t('Preview')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {groupContext?.groupId && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          <span className="shrink-0">{t('Posting to group relay for')}</span>
          <div className="flex items-center gap-2 min-w-0">
            <Avatar className="h-6 w-6 shrink-0">
              {groupContext.picture && (
                <AvatarImage src={groupContext.picture} alt={groupDisplayName} />
              )}
              <AvatarFallback className="text-[10px] font-semibold">{groupInitials}</AvatarFallback>
            </Avatar>
            <span className="truncate font-semibold text-foreground">{groupDisplayName}</span>
          </div>
        </div>
      )}
    </div>
  )

  const body = (
    <div className="flex flex-col gap-2 flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden">
      {parentEvent && (
        <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border bg-muted/40">
          <div className="p-2 sm:p-3 pointer-events-none">
            <Note size="small" event={parentEvent} hideParentNotePreview />
          </div>
        </div>
      )}
      {view === 'edit' ? (
        <>
          <PostTextarea
            ref={textareaRef}
            text={text}
            setText={setText}
            defaultContent={defaultContent}
            parentEvent={parentEvent}
            onSubmit={() => post()}
            className={isPoll ? 'min-h-20' : 'min-h-52'}
            onUploadStart={handleUploadStart}
            onUploadProgress={handleUploadProgress}
            onUploadEnd={handleUploadEnd}
            onUploadSuccess={(file, result) => handleUploadSuccess(result, file)}
            onUploadError={handleUploadError}
            uploadContext={groupUploadContext}
            hidePreviewToggle
          />
          {isPoll && (
            <PollEditor
              pollCreateData={pollCreateData}
              setPollCreateData={setPollCreateData}
              setIsPoll={setIsPoll}
            />
          )}
        </>
      ) : (
        <Preview
          content={text}
          className={cn(
            'border rounded-lg p-3 min-h-52 bg-background max-w-full overflow-x-hidden break-words [overflow-wrap:anywhere]',
            isPoll ? 'min-h-20' : 'min-h-52'
          )}
        />
      )}
      {uploadProgresses.length > 0 &&
        uploadProgresses.map(({ file, progress, cancel }, index) => (
          <div key={`${file.name}-${index}`} className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-muted-foreground mb-1">
                {file.name ?? t('Uploading...')}
              </div>
              <div className="h-0.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                cancel?.()
                handleUploadEnd(file)
              }}
              className="text-muted-foreground hover:text-foreground"
              title={t('Cancel')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      {hasBlockingUploadFailures && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
          <div className="text-xs text-destructive mb-2">
            {t('Some uploads failed. Retry upload or remove failed files before posting.')}
          </div>
          <div className="space-y-2">
            {failedUploads.map((item) => (
              <div key={item.key} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{item.fileName}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{item.error}</div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => dismissFailedUpload(item.key)}
                >
                  {t('Remove')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <PostOptions
        posting={posting}
        show={showMoreOptions}
        addClientTag={addClientTag}
        setAddClientTag={setAddClientTag}
        isNsfw={isNsfw}
        setIsNsfw={setIsNsfw}
        minPow={minPow}
        setMinPow={setMinPow}
      />
    </div>
  )

  const footer = (
    <div className="space-y-2">
      {!isPoll && !groupContext && (
        <PostRelaySelector
          setIsProtectedEvent={setIsProtectedEvent}
          setAdditionalRelayUrls={setAdditionalRelayUrls}
          parentEvent={parentEvent}
          openFrom={openFrom}
          extraRelayUrls={groupRelayTargets.map((target) => target.relayUrl)}
          relayDisplayMeta={groupRelayDisplayMeta}
        />
      )}
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Uploader
            onUploadSuccess={(result, file) => {
              textareaRef.current?.appendText(result.url, true)
              handleUploadSuccess(result, file)
            }}
            onUploadError={handleUploadError}
            onUploadStart={handleUploadStart}
            onUploadEnd={handleUploadEnd}
            onProgress={handleUploadProgress}
            accept={uploadAccept}
            uploadContext={groupUploadContext}
          >
            <Button variant="ghost" size="icon">
              <ImageUp />
            </Button>
          </Uploader>
          {allowEmoji && (
            <EmojiPickerDialog
              onEmojiClick={(emoji) => {
                if (!emoji) return
                textareaRef.current?.insertEmoji(emoji)
              }}
            >
              <Button variant="ghost" size="icon">
                <Smile />
              </Button>
            </EmojiPickerDialog>
          )}
          {!parentEvent && (
            <Button
              variant="ghost"
              size="icon"
              title={t('Create Poll')}
              className={isPoll ? 'bg-accent' : ''}
              onClick={handlePollToggle}
            >
              <ListTodo />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={showMoreOptions ? 'bg-accent' : ''}
            onClick={() => setShowMoreOptions((pre) => !pre)}
          >
            <Settings />
          </Button>
        </div>
        <div className="flex gap-2 items-center">
          <Mentions
            content={text}
            parentEvent={parentEvent}
            mentions={mentions}
            setMentions={setMentions}
          />
          <div className="flex gap-2 items-center max-sm:hidden">
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                close()
              }}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!canPost} onClick={post}>
              {posting && <LoaderCircle className="animate-spin" />}
              {parentEvent ? t('Reply') : t('Post')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex gap-2 items-center justify-around sm:hidden">
        <Button
          className="w-full"
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button className="w-full" type="submit" disabled={!canPost} onClick={post}>
          {posting && <LoaderCircle className="animate-spin" />}
          {parentEvent ? t('Reply') : t('Post')}
        </Button>
      </div>
    </div>
  )

  return renderSections({ header, body, footer })
}
