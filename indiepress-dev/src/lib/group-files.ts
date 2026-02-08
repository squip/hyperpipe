import { TDraftEvent } from '@/types'
import { MediaUploadResult } from '@/services/media-upload.service'

function readTag(tags: string[][], name: string) {
  return tags.find((tag) => tag[0] === name)?.[1]
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

    const rTag = ['r', url, 'hypertuna:drive']
    if (!hasTag(draftEvent.tags, rTag)) {
      draftEvent.tags.push(rTag)
    }

    const imetaTag = ['imeta', ...tags.map(([name, value]) => `${name} ${value}`)]
    if (imetaTag.length > 1 && !hasImetaForUrl(draftEvent.tags, url)) {
      draftEvent.tags.push(imetaTag)
    }
  }

  const driveTag = ['i', 'hypertuna:drive']
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

  const tags: string[][] = [['url', url], ['h', groupId], ['i', 'hypertuna:drive']]
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

  const service = readTag(upload.tags, 'service') || (metadata?.source === 'group-hyperdrive' ? 'hypertuna-hyperdrive' : null)
  if (service) tags.push(['service', service])

  const content = metadata?.fileName || ''

  return {
    kind: 1063,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000)
  }
}
