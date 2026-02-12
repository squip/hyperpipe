import { Button } from '@/components/ui/button'
import PostRelaySelector from './PostRelaySelector'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { createLongFormDraftEvent } from '@/lib/draft-event'
import {
  appendGroupAttachmentTagsToDraft,
  createGroupFileMetadataDraftEvent,
  getGroupHyperdriveUploads
} from '@/lib/group-files'
import { useNostr } from '@/providers/NostrProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import postEditorCache from '@/services/post-editor-cache.service'
import { MediaUploadContext, MediaUploadResult } from '@/services/media-upload.service'
import { Event } from '@nostr/tools/wasm'
import { useEffect, useMemo, useState, MouseEvent, ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoaderCircle } from 'lucide-react'
import { randomString } from '@/lib/random'
import * as nip19 from '@nostr/tools/nip19'
import { TDraftEvent } from '@/types'
import {
  buildGroupRelayDisplayMetaMap,
  buildGroupRelayTargets,
  getRelayIdentity,
  resolvePublishRelayUrls,
  type GroupRelayTarget
} from '@/lib/relay-targets'
import ArticleMarkdownEditor, { MetadataSnapshot } from './ArticleMarkdownEditor'

type FailedUpload = {
  key: string
  fileName: string
  error: string
}

function getUploadFailureKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export default function ArticleContent({
  close,
  openFrom,
  existingEvent,
  extraTags = [],
  onPublish,
  renderSections = ({ header, body, footer }) => (
    <>
      {header}
      {body}
      {footer}
    </>
  ),
  groupContext
}: {
  close: () => void
  openFrom?: string[]
  existingEvent?: Event
  extraTags?: string[][]
  onPublish?: (draftEvent: TDraftEvent, options: { isDraft: boolean; relayUrls: string[] }) => Promise<void>
  renderSections?: (sections: {
    header?: React.ReactNode
    body: React.ReactNode
    footer: React.ReactNode
  }) => React.ReactNode
  groupContext?: {
    groupId: string
    relay?: string
    name?: string
    picture?: string
  }
}) {
  const { t } = useTranslation()
  const { publish, checkLogin } = useNostr()
  const { myGroupList, discoveryGroups, getProvisionalGroupMetadata, resolveRelayUrl } = useGroups()
  const { refreshRelaySubscriptions } = useWorkerBridge()
  const [title, setTitle] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [summary, setSummary] = useState('')
  const [image, setImage] = useState('')
  const [hashtagsText, setHashtagsText] = useState('')
  const [content, setContent] = useState('')
  const [bodyContent, setBodyContent] = useState('')
  const [editorJson, setEditorJson] = useState<any>(null)
  const [publishedAt, setPublishedAt] = useState<number | undefined>(undefined)
  const [posting, setPosting] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [, setIsProtectedEvent] = useState(false)
  const [additionalRelayUrls, setAdditionalRelayUrls] = useState<string[]>([])
  const [uploadProgresses, setUploadProgresses] = useState<
    { file: File; progress: number; cancel: () => void }[]
  >([])
  const [uploadedResults, setUploadedResults] = useState<MediaUploadResult[]>([])
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([])
  const [metadataSnapshot, setMetadataSnapshot] = useState<MetadataSnapshot | null>(null)
  const [cacheHydrated, setCacheHydrated] = useState(false)
  const [templateResetKey, setTemplateResetKey] = useState(0)
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
      parentKind: 30023
    }
  }, [groupContext?.groupId, groupContext?.relay])
  const groupDisplayName = groupContext?.name || groupContext?.groupId
  const groupInitials = (groupDisplayName || 'GR').slice(0, 2).toUpperCase()
  const hasBlockingUploadFailures = !!groupContext?.groupId && failedUploads.length > 0

  const cacheKey = useMemo(
    () => `article-editor:${existingEvent?.id ?? 'new'}`,
    [existingEvent?.id]
  )

  useEffect(() => {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        setTitle(parsed.title ?? '')
        setIdentifier(parsed.identifier ?? randomString(12))
        setSummary(parsed.summary ?? '')
        setImage(parsed.image ?? '')
        setHashtagsText(parsed.hashtagsText ?? '')
        setContent(parsed.content ?? '')
        setBodyContent(parsed.bodyContent ?? parsed.content ?? '')
        setEditorJson(parsed.editorJson ?? null)
        setPublishedAt(parsed.publishedAt ?? undefined)
        setMetadataSnapshot(parsed.metadataSnapshot ?? null)
        setCacheHydrated(true)
        return
      } catch (e) {
        console.error('Failed to parse article editor cache', e)
      }
    }

    if (!existingEvent) {
      setIdentifier(randomString(12))
      return
    }
    const getTag = (name: string) => existingEvent.tags.find((tag) => tag[0] === name)?.[1] ?? ''
    const pubAt = getTag('published_at')
    const pubAtNum = pubAt ? parseInt(pubAt) : undefined
    setTitle(getTag('title') || '')
    setIdentifier(getTag('d') || randomString(12))
    setSummary(getTag('summary') || '')
    setImage(getTag('image') || '')
    if (pubAtNum && !Number.isNaN(pubAtNum)) {
      setPublishedAt(pubAtNum)
    }
    const hashTags = existingEvent.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1])
    if (hashTags.length) {
      setHashtagsText(hashTags.join(', '))
    }
    const incomingContent = existingEvent.content || ''
    setContent(incomingContent)
    setBodyContent(incomingContent)
    setMetadataSnapshot(null)
    setCacheHydrated(true)
  }, [existingEvent, cacheKey])

  useEffect(() => {
    if (!metadataSnapshot) return
    if (metadataSnapshot.hasMetadataBlock) {
      setTitle(metadataSnapshot.title ?? '')
      setSummary(metadataSnapshot.summary ?? '')
      setImage(metadataSnapshot.coverDismissed ? '' : metadataSnapshot.image ?? '')
    } else if (metadataSnapshot.dismissed) {
      setTitle('')
      setSummary('')
      setImage('')
    }
  }, [metadataSnapshot])

  useEffect(() => {
    const shouldClearCache =
      ((!content?.trim() && !editorJson) || metadataSnapshot?.isTemplatePristine === true)

    if (shouldClearCache) {
      localStorage.removeItem(cacheKey)
      setCacheHydrated(true)
      return
    }

    const payload = {
      title,
      identifier,
      summary,
      image,
      hashtagsText,
      content,
      bodyContent,
      editorJson,
      publishedAt,
      metadataSnapshot
    }
    try {
      localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch (e) {
      console.error('Failed to cache article editor state', e)
    }
  }, [
    title,
    identifier,
    summary,
    image,
    hashtagsText,
    content,
    bodyContent,
    publishedAt,
    cacheKey,
    editorJson,
    metadataSnapshot
  ])

  const canPublish = useMemo(() => {
    const effectiveBody = bodyContent || content
    const hasContent = !!effectiveBody.trim() && metadataSnapshot?.isTemplatePristine !== true
    return (
      !!identifier.trim() &&
      hasContent &&
      !posting &&
      !savingDraft &&
      !uploadProgresses.length &&
      !hasBlockingUploadFailures
    )
  }, [
    identifier,
    bodyContent,
    content,
    posting,
    savingDraft,
    uploadProgresses.length,
    metadataSnapshot,
    hasBlockingUploadFailures
  ])

  const hashtags = useMemo(
    () =>
      hashtagsText
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    [hashtagsText]
  )

  const deriveTitle = () => {
    const base = bodyContent || content
    const lines = base.split('\n').map((l) => l.trim()).filter(Boolean)
    const firstLine = lines[0] ?? ''
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
    const fallback = cleaned || content.replace(/[#*_`>]/g, ' ').trim()
    const normalized = fallback || t('Untitled article') || 'Untitled article'
    return normalized.slice(0, 120)
  }

  const resolvedMetadata = useMemo(() => {
    if (metadataSnapshot?.dismissed) {
      return { title: undefined, summary: undefined, image: undefined }
    }
    if (metadataSnapshot?.hasMetadataBlock) {
      return {
        title: metadataSnapshot.title,
        summary: metadataSnapshot.summary,
        image: metadataSnapshot.coverDismissed ? undefined : metadataSnapshot.image
      }
    }
    if (existingEvent) {
      return {
        title: title || '',
        summary,
        image
      }
    }
    return { title, summary, image }
  }, [metadataSnapshot, existingEvent, title, summary, image])

  const shouldInsertTemplate = useMemo(() => {
    if (existingEvent) return false
    const hasMeaningfulCache =
      Boolean(content?.trim?.()) || Boolean(editorJson) || Boolean(bodyContent?.trim?.())
    if (templateResetKey > 0) {
      if (metadataSnapshot?.hasMetadataBlock) return false
      return true
    }
    if (metadataSnapshot?.hasMetadataBlock) return false
    if (hasMeaningfulCache) return false
    return true
  }, [existingEvent, content, bodyContent, editorJson, metadataSnapshot, templateResetKey])

  const handleClearEditor = useCallback(() => {
    setTitle('')
    setSummary('')
    setImage('')
    setContent('')
    setBodyContent('')
    setEditorJson(null)
    setMetadataSnapshot(null)
    setHashtagsText('')
    setIdentifier(randomString(12))
    setPublishedAt(undefined)
    try {
      localStorage.removeItem(cacheKey)
    } catch (_e) {
      /* ignore */
    }
    setTemplateResetKey((prev) => prev + 1)
  }, [cacheKey])

  const buildDraft = (isDraft: boolean) => {
    const dismissedMetadata = metadataSnapshot?.dismissed
    const fallbackTitle = (title || '').trim() || deriveTitle()
    const resolvedTitle =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.title !== undefined
          ? resolvedMetadata.title?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : fallbackTitle
    const resolvedSummary =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.summary !== undefined
          ? resolvedMetadata.summary?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : summary.trim() || undefined
    const resolvedImage =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.image !== undefined
          ? resolvedMetadata.image?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : image.trim() || undefined

    const body = bodyContent || content
    const base = createLongFormDraftEvent(
      {
        title: resolvedTitle,
        content: body,
        summary: resolvedSummary,
        image: resolvedImage,
        identifier: identifier.trim(),
        hashtags,
        publishedAt: isDraft ? undefined : publishedAt ?? Math.floor(Date.now() / 1000),
        extraTags
      },
      {
        isDraft,
        existingEvent
      }
    )
    postEditorCache.clearPostCache({ defaultContent: 'article' })
    return base
  }

  const resolveRelayPublishTargets = async (relayUrls: string[]) => {
    return await resolvePublishRelayUrls({
      relayUrls,
      resolveRelayUrl,
      groupRelayTargets,
      refreshGroupRelay: async (groupId) => {
        await refreshRelaySubscriptions({
          publicIdentifier: groupId,
          reason: 'article-editor-relay-publish',
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

  const publishDraft = async (isDraft: boolean) => {
    await checkLogin(async () => {
      if (hasBlockingUploadFailures) {
        toast.error(t('Resolve failed uploads before posting. Retry upload or remove failed files.'))
        return
      }
      if (!canPublish) return
      if (isDraft) {
        setSavingDraft(true)
      } else {
        setPosting(true)
      }
      try {
        const draftEvent = buildDraft(isDraft)
        if (groupContext?.groupId) {
          draftEvent.tags = draftEvent.tags || []
          if (!draftEvent.tags.some((t) => t[0] === 'h' && t[1] === groupContext.groupId)) {
            draftEvent.tags.push(['h', groupContext.groupId])
          }
          appendGroupAttachmentTagsToDraft(draftEvent, uploadedResults)
          if (!isDraft) {
            const groupFileDrafts = getGroupHyperdriveUploads(uploadedResults)
              .map((upload) => createGroupFileMetadataDraftEvent(upload, groupContext.groupId))
              .filter((event): event is NonNullable<ReturnType<typeof createGroupFileMetadataDraftEvent>> => Boolean(event))
            if (groupFileDrafts.length > 0) {
              for (const fileDraft of groupFileDrafts) {
                await publishGroupFileMetadataWithRetry(fileDraft)
              }
            }
          }
        }
        let newEvent
        const relayUrlsForPublish =
          additionalRelayUrls.length > 0
            ? additionalRelayUrls
            : groupContext?.relay
              ? [groupContext.relay]
              : openFrom || []
        if (!groupContext) {
          appendSelectedGroupHTags(draftEvent, relayUrlsForPublish)
        }
        const resolvedRelayUrls = relayUrlsForPublish.length
          ? await resolveRelayPublishTargets(relayUrlsForPublish)
          : []

        if (onPublish) {
          await onPublish(draftEvent, { isDraft, relayUrls: resolvedRelayUrls })
        } else {
          newEvent = await publish(draftEvent, {
            specifiedRelayUrls: resolvedRelayUrls.length ? resolvedRelayUrls : undefined,
            additionalRelayUrls: resolvedRelayUrls
          })
        }
        let description: string | undefined
        try {
          const dTag = (newEvent as Event | undefined)?.tags.find((tag) => tag[0] === 'd')?.[1] || identifier
          if (newEvent) {
            const naddr = nip19.naddrEncode({
              kind: 30023,
              pubkey: (newEvent as Event).pubkey,
              identifier: dTag,
              relays: []
            })
            description = naddr
          }
        } catch (e) {
          console.warn('Failed to encode naddr', e)
        }
        toast.success(isDraft ? t('Draft saved') : t('Article published'), {
          description
        })
        try {
          localStorage.removeItem(cacheKey)
        } catch (_e) {
          /* ignore */
        }
        setUploadedResults([])
        setFailedUploads([])
        close()
        return newEvent
      } catch (error) {
        const errors = error instanceof AggregateError ? error.errors : [error]
        errors.forEach((err) => {
          toast.error(
            `${t('Failed to post')}: ${err instanceof Error ? err.message : String(err)}`,
            { duration: 10_000 }
          )
          console.error(err)
        })
      } finally {
        setSavingDraft(false)
        setPosting(false)
      }
    })
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

  const publishGroupFileMetadataWithRetry = async (
    draftEvent: NonNullable<ReturnType<typeof createGroupFileMetadataDraftEvent>>
  ) => {
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

  const [toolbar, setToolbar] = useState<ReactNode | null>(null)
  const handleRenderToolbar = useCallback((node: ReactNode) => {
    setToolbar(node)
  }, [])

  const body = (
    <div className="flex flex-col gap-2 flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden">
      {!cacheHydrated ? (
        <div className="text-sm text-muted-foreground">{t('Loading...')}</div>
      ) : (
        <ArticleMarkdownEditor
          value={content}
          onChange={setContent}
          onBodyChange={setBodyContent}
          initialJson={editorJson}
          onJsonChange={setEditorJson}
          onMetadataChange={setMetadataSnapshot}
          initialMetadata={metadataSnapshot?.dismissed ? undefined : metadataSnapshot ?? undefined}
          shouldInsertTemplate={shouldInsertTemplate}
          mentions={mentions}
          setMentions={setMentions}
          onUploadStart={handleUploadStart}
          onUploadEnd={handleUploadEnd}
          onUploadProgress={handleUploadProgress}
          onUploadError={handleUploadError}
          uploadContext={groupUploadContext}
          onClearEditor={handleClearEditor}
          onUploadSuccess={(result, file) => {
            setContent((prev) => `${prev}${prev ? '\n' : ''}${result.url}`)
            handleUploadSuccess(result, file)
          }}
          onEmojiSelect={(emoji) => {
            if (!emoji) return
            setContent((prev) =>
              `${prev} ${typeof emoji === 'string' ? emoji : `:${emoji.shortcode}:`}`.trim()
            )
          }}
          onSaveDraft={() => publishDraft(true)}
          renderToolbar={handleRenderToolbar}
          templateResetKey={templateResetKey}
        />
      )}
    </div>
  )

  const footer = (
    <div className="space-y-2">
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
              ×
            </button>
          </div>
        ))}
      {hasBlockingUploadFailures && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
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
      <div className="flex flex-wrap items-center gap-2 justify-between">
        {groupContext?.groupId && (
          <div className="inline-flex items-center gap-2 rounded-full bg-muted px-2 py-1">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {t('Posting to group relay for')}
            </span>
            <div className="flex items-center gap-2 min-w-0">
              <Avatar className="h-6 w-6 shrink-0">
                {groupContext.picture && (
                  <AvatarImage src={groupContext.picture} alt={groupDisplayName} />
                )}
                <AvatarFallback className="text-[10px] font-semibold">{groupInitials}</AvatarFallback>
              </Avatar>
              <span className="truncate text-sm font-semibold text-foreground">{groupDisplayName}</span>
            </div>
          </div>
        )}
        {!groupContext && (
          <PostRelaySelector
            setIsProtectedEvent={setIsProtectedEvent}
            setAdditionalRelayUrls={setAdditionalRelayUrls}
            parentEvent={existingEvent}
            openFrom={openFrom}
            extraRelayUrls={groupRelayTargets.map((target) => target.relayUrl)}
            relayDisplayMeta={groupRelayDisplayMeta}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 justify-end max-sm:hidden">
        <Button
          data-post-cancel-button
          variant="secondary"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          data-post-publish-button
          disabled={!canPublish || posting}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            publishDraft(false)
          }}
        >
          {posting && <LoaderCircle className="animate-spin mr-2 h-4 w-4" />}
          {t('Publish')}
        </Button>
      </div>
      <div className="flex gap-2 items-center justify-around sm:hidden">
        <Button
          data-post-cancel-button
          className="w-full"
          variant="secondary"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          data-post-publish-button
          className="w-full"
          disabled={!canPublish || posting}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            publishDraft(false)
          }}
        >
          {posting && <LoaderCircle className="animate-spin mr-2 h-4 w-4" />}
          {t('Publish')}
        </Button>
      </div>
    </div>
  )

  return renderSections({ header: toolbar ?? undefined, body, footer })
}
