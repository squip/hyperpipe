import { TDraftEvent } from '@/types'
import { MediaUploadResult } from '@/services/media-upload.service'
import { Event as NostrEvent } from '@nostr/tools/wasm'

export type GroupFileSortKey = 'fileName' | 'uploadedAt' | 'uploadedBy' | 'size' | 'mime'
  | 'group'

export type GroupFileRecord = {
  eventId: string
  event: NostrEvent
  url: string
  groupId: string
  groupRelay: string | null
  groupName: string | null
  fileName: string
  mime: string | null
  size: number | null
  uploadedAt: number
  uploadedBy: string
  sha256: string | null
  dim: string | null
  alt: string | null
  summary: string | null
}

const MIME_EXTENSION_FALLBACKS: Record<string, string> = {
  'application/gzip': 'gz',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'video/quicktime': 'mov'
}

function readTag(tags: string[][], name: string) {
  return tags.find((tag) => tag[0] === name)?.[1]
}

function toOptionalString(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized : null
}

function readFiniteNumber(value: string | null | undefined) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getUrlFileName(url: string) {
  try {
    const parsed = new URL(url)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '').trim()
    return name || null
  } catch {
    const name = url.split('?')[0].split('#')[0].split('/').filter(Boolean).pop()?.trim()
    return name || null
  }
}

function extractFileExtension(value?: string | null) {
  const normalized = String(value || '').trim()
  if (!normalized) return null

  const fileName = normalized.split(/[?#]/)[0].split('/').filter(Boolean).pop() || normalized
  const lastDotIndex = fileName.lastIndexOf('.')
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) return null

  const candidate = fileName.slice(lastDotIndex + 1).toLowerCase()
  return /^[a-z0-9]{1,16}$/i.test(candidate) ? candidate : null
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

export function isLoopbackGroupFileUrl(value?: string | null) {
  const normalized = toOptionalString(value)
  if (!normalized) return false

  try {
    return isLoopbackHostname(new URL(normalized).hostname)
  } catch {
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(normalized)
  }
}

export function toGroupFileHttpOrigin(value?: string | null): string | null {
  const normalized = toOptionalString(value)
  if (!normalized) return null

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

export function extractGroupFileIdFromUrl(value?: string | null) {
  const normalized = toOptionalString(value)
  if (!normalized) return null

  try {
    const parsed = new URL(normalized)
    const parts = parsed.pathname.split('/').filter(Boolean)
    return parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : null
  } catch {
    const parts = normalized.split('?')[0].split('#')[0].split('/').filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : null
  }
}

export function buildGroupFileDriveUrl(baseUrl: string, groupId: string, fileId: string) {
  const origin = toGroupFileHttpOrigin(baseUrl)
  const normalizedGroupId = toOptionalString(groupId)
  const normalizedFileId = toOptionalString(fileId)
  if (!origin || !normalizedGroupId || !normalizedFileId) return null
  return `${origin}/drive/${normalizedGroupId}/${normalizedFileId.replace(/^\/+/, '')}`
}

export function resolveGroupFileAccessUrl(args: {
  url?: string | null
  groupId?: string | null
  relayUrl?: string | null
}) {
  const url = toOptionalString(args.url)
  if (!url) return null

  if (!isLoopbackGroupFileUrl(url)) {
    return url
  }

  const fileId = extractGroupFileIdFromUrl(url)
  const nextUrl =
    fileId && args.groupId && args.relayUrl
      ? buildGroupFileDriveUrl(args.relayUrl, args.groupId, fileId)
      : null

  return nextUrl || url
}

export function normalizeGroupFileExtension(value?: string | null) {
  const normalized = String(value || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase()
  if (!normalized) return null
  if (normalized === 'unknown') return 'unknown'
  return /^[a-z0-9]{1,16}$/i.test(normalized) ? normalized : null
}

export function resolveGroupFileExtension(record: Pick<GroupFileRecord, 'fileName' | 'url' | 'mime'>) {
  const fromFileName = extractFileExtension(record.fileName)
  if (fromFileName) return fromFileName

  const fromUrl = extractFileExtension(record.url)
  if (fromUrl) return fromUrl

  const normalizedMime = toOptionalString(record.mime)?.toLowerCase() || null
  if (normalizedMime) {
    const mappedExtension = MIME_EXTENSION_FALLBACKS[normalizedMime]
    if (mappedExtension) return mappedExtension

    const mimeSubtype = normalizedMime.split('/')[1] || ''
    const normalizedSubtype = normalizeGroupFileExtension(
      mimeSubtype.replace(/^x-/, '').replace(/\+xml$/, 'xml')
    )
    if (normalizedSubtype) return normalizedSubtype
  }

  return 'unknown'
}

export function getGroupFileExtensionLabel(extension: string) {
  return extension === 'unknown' ? 'Unknown' : `.${extension}`
}

export function isGroupFileHtml(
  record: Pick<GroupFileRecord, 'fileName' | 'url' | 'mime'>
) {
  const mime = toOptionalString(record.mime)?.toLowerCase() || null
  if (mime === 'text/html') return true
  return resolveGroupFileExtension(record) === 'html'
}

function buildFallbackFileName(sha256: string | null) {
  return sha256 ? `file-${sha256.slice(0, 12)}` : 'file'
}

function deriveGroupFileName({
  url,
  alt,
  content,
  sha256
}: {
  url: string
  alt: string | null
  content: string
  sha256: string | null
}) {
  if (alt) return alt

  const trimmedContent = content.trim()
  if (trimmedContent) return trimmedContent

  const urlName = getUrlFileName(url)
  if (urlName) return urlName

  return buildFallbackFileName(sha256)
}

export function parseGroupFileRecordFromEvent(event: NostrEvent): GroupFileRecord | null {
  if (!event || event.kind !== 1063 || !Array.isArray(event.tags)) return null

  const url = toOptionalString(readTag(event.tags, 'url'))
  if (!url) return null
  const groupId = toOptionalString(readTag(event.tags, 'h')) || 'unknown'

  const mime = toOptionalString(readTag(event.tags, 'm'))?.toLowerCase() || null
  const size = readFiniteNumber(readTag(event.tags, 'size'))
  const sha256 =
    toOptionalString(readTag(event.tags, 'x')) || toOptionalString(readTag(event.tags, 'ox')) || null
  const dim = toOptionalString(readTag(event.tags, 'dim'))
  const alt = toOptionalString(readTag(event.tags, 'alt'))
  const summary = toOptionalString(readTag(event.tags, 'summary'))

  return {
    eventId: event.id,
    event,
    url,
    groupId,
    groupRelay: null,
    groupName: null,
    fileName: deriveGroupFileName({
      url,
      alt,
      content: event.content || '',
      sha256
    }),
    mime,
    size,
    uploadedAt: event.created_at || 0,
    uploadedBy: event.pubkey,
    sha256,
    dim,
    alt,
    summary
  }
}

export function withGroupFileRecordContext(
  record: GroupFileRecord,
  context?: {
    groupNameById?: Map<string, string>
    groupRelayById?: Map<string, string>
  }
): GroupFileRecord {
  if (!context) return record
  const nextGroupName = context.groupNameById?.get(record.groupId) || null
  const nextGroupRelay = context.groupRelayById?.get(record.groupId) || null
  if (nextGroupName === record.groupName && nextGroupRelay === record.groupRelay) {
    return record
  }
  return {
    ...record,
    groupName: nextGroupName,
    groupRelay: nextGroupRelay
  }
}

function normalizeForSearch(value: string | null | undefined) {
  return (value || '').trim().toLowerCase()
}

export function matchesGroupFileSearch(record: GroupFileRecord, query?: string) {
  const normalizedQuery = normalizeForSearch(query)
  if (!normalizedQuery) return true
  const searchValues = [
    record.fileName,
    record.url,
    record.mime || '',
    record.sha256 || '',
    record.alt || '',
    record.summary || '',
    record.uploadedBy,
    record.groupId,
    record.groupName || ''
  ]
  return searchValues.some((value) => normalizeForSearch(value).includes(normalizedQuery))
}

export function formatGroupFileSize(size: number | null | undefined) {
  if (!Number.isFinite(size)) return '-'
  const value = Number(size)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatGroupFileMime(mime: string | null | undefined) {
  return toOptionalString(mime)?.toLowerCase() || 'unknown'
}

function hasTag(tags: string[][], candidate: string[]) {
  return tags.some((tag) => tag.length === candidate.length && tag.every((value, i) => value === candidate[i]))
}

function hasImetaForUrl(tags: string[][], url: string) {
  return tags.some((tag) => tag[0] === 'imeta' && tag.some((part) => part === `url ${url}`))
}

export function dedupeUploadResults(results: MediaUploadResult[]) {
  const seen = new Set<string>()
  const deduped: MediaUploadResult[] = []
  for (const result of results) {
    if (!result?.url || seen.has(result.url)) continue
    seen.add(result.url)
    deduped.push(result)
  }
  return deduped
}

export function getGroupHyperdriveUploads(results: MediaUploadResult[]) {
  return dedupeUploadResults(results).filter(
    (result) => result.metadata?.source === 'group-hyperdrive'
  )
}

export function appendGroupAttachmentTagsToDraft(
  draftEvent: TDraftEvent,
  results: MediaUploadResult[]
) {
  const uploads = getGroupHyperdriveUploads(results)
  if (uploads.length === 0) return draftEvent

  draftEvent.tags = draftEvent.tags || []

  for (const upload of uploads) {
    const { url, tags } = upload
    if (!url) continue

    const rTag = ['r', url, 'hyperpipe:drive']
    if (!hasTag(draftEvent.tags, rTag)) {
      draftEvent.tags.push(rTag)
    }

    const imetaTag = ['imeta', ...tags.map(([name, value]) => `${name} ${value}`)]
    if (imetaTag.length > 1 && !hasImetaForUrl(draftEvent.tags, url)) {
      draftEvent.tags.push(imetaTag)
    }
  }

  const driveTag = ['i', 'hyperpipe:drive']
  if (!hasTag(draftEvent.tags, driveTag)) {
    draftEvent.tags.push(driveTag)
  }

  return draftEvent
}

export function createGroupFileMetadataDraftEvent(
  upload: MediaUploadResult,
  groupId: string
): TDraftEvent | null {
  const url = upload.url
  if (!url) return null

  const tags: string[][] = [['url', url], ['h', groupId], ['i', 'hyperpipe:drive']]
  const metadata = upload.metadata

  const mimeType = metadata?.mimeType || readTag(upload.tags, 'm')
  if (mimeType) tags.push(['m', mimeType.toLowerCase()])

  const sha = metadata?.sha256 || readTag(upload.tags, 'x')
  if (sha) tags.push(['x', sha])

  const ox = metadata?.originalSha256 || readTag(upload.tags, 'ox') || sha
  if (ox) tags.push(['ox', ox])

  const size =
    metadata?.size ??
    (() => {
      const value = readTag(upload.tags, 'size')
      return value ? Number(value) : undefined
    })()
  if (Number.isFinite(size)) tags.push(['size', String(size)])

  const dimTag =
    (metadata?.dim
      ? `${Math.trunc(metadata.dim.width)}x${Math.trunc(metadata.dim.height)}`
      : undefined) || readTag(upload.tags, 'dim')
  if (dimTag) tags.push(['dim', dimTag])

  const alt = metadata?.fileName || readTag(upload.tags, 'alt')
  if (alt) tags.push(['alt', alt])

  const summary = readTag(upload.tags, 'summary')
  if (summary) tags.push(['summary', summary])

  const service = readTag(upload.tags, 'service') || (metadata?.source === 'group-hyperdrive' ? 'hyperpipe-hyperdrive' : null)
  if (service) tags.push(['service', service])

  const content = metadata?.fileName || ''

  return {
    kind: 1063,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000)
  }
}
