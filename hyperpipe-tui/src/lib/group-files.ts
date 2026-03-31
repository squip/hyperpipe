import type { Event, EventTemplate } from 'nostr-tools'

export type GroupFileRecord = {
  eventId: string
  event: Event
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

function buildFallbackFileName(sha256: string | null) {
  return sha256 ? `file-${sha256.slice(0, 12)}` : 'file'
}

function deriveGroupFileName(args: {
  url: string
  alt: string | null
  content: string
  sha256: string | null
}) {
  if (args.alt) return args.alt

  const trimmedContent = args.content.trim()
  if (trimmedContent) return trimmedContent

  const urlName = getUrlFileName(args.url)
  if (urlName) return urlName

  return buildFallbackFileName(args.sha256)
}

export function parseGroupFileRecordFromEvent(event: Event): GroupFileRecord | null {
  if (!event || event.kind !== 1063 || !Array.isArray(event.tags)) return null

  const url = toOptionalString(readTag(event.tags, 'url'))
  if (!url) return null
  const groupId = toOptionalString(readTag(event.tags, 'h')) || 'unknown'

  const mime = toOptionalString(readTag(event.tags, 'm'))?.toLowerCase() || null
  const size = readFiniteNumber(readTag(event.tags, 'size'))
  const sha256 =
    toOptionalString(readTag(event.tags, 'x'))
    || toOptionalString(readTag(event.tags, 'ox'))
    || null
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

export function createGroupFileMetadataDraftEvent(input: {
  url: string
  groupId: string
  mime?: string
  sha256?: string
  ox?: string
  size?: number
  dim?: string
  alt?: string
  summary?: string
}): EventTemplate {
  const tags: string[][] = [
    ['url', input.url],
    ['h', input.groupId],
    ['i', 'hyperpipe:drive']
  ]

  if (input.mime) tags.push(['m', input.mime.toLowerCase()])
  if (input.sha256) tags.push(['x', input.sha256])
  if (input.ox || input.sha256) tags.push(['ox', input.ox || input.sha256 || ''])
  if (Number.isFinite(input.size)) tags.push(['size', String(input.size)])
  if (input.dim) tags.push(['dim', input.dim])
  if (input.alt) tags.push(['alt', input.alt])
  if (input.summary) tags.push(['summary', input.summary])

  return {
    kind: 1063,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.alt || ''
  }
}
