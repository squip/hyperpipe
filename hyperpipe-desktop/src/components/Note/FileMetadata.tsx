import { cn } from '@/lib/utils'
import { Event } from '@nostr/tools/wasm'

function readTag(event: Event, name: string) {
  return event.tags.find((tag) => tag[0] === name)?.[1]
}

function formatSize(size: string | undefined) {
  if (!size) return null
  const num = Number(size)
  if (!Number.isFinite(num)) return size
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / (1024 * 1024)).toFixed(2)} MB`
}

export default function FileMetadataNote({ event, className }: { event: Event; className?: string }) {
  const url = readTag(event, 'url')
  const mimeType = (readTag(event, 'm') || '').toLowerCase()
  const size = formatSize(readTag(event, 'size'))
  const dim = readTag(event, 'dim')
  const alt = readTag(event, 'alt')
  const summary = readTag(event, 'summary')
  const isImage = mimeType.startsWith('image/')
  const isVideo = mimeType.startsWith('video/')
  const isAudio = mimeType.startsWith('audio/')

  return (
    <div className={cn('mt-2 rounded-lg border bg-muted/20 p-3 space-y-2', className)}>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {mimeType ? <span>{mimeType}</span> : null}
        {size ? <span>{size}</span> : null}
        {dim ? <span>{dim}</span> : null}
      </div>
      {isImage && url ? (
        <img src={url} alt={alt || event.content || 'Shared file'} className="max-h-80 w-full rounded-md object-contain bg-black/5" />
      ) : null}
      {isVideo && url ? (
        <video controls src={url} className="max-h-80 w-full rounded-md bg-black/5" />
      ) : null}
      {isAudio && url ? (
        <audio controls src={url} className="w-full" />
      ) : null}
      {summary ? <div className="text-sm text-muted-foreground">{summary}</div> : null}
      {event.content ? <div className="text-sm break-words">{event.content}</div> : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-primary underline break-all"
        >
          {url}
        </a>
      ) : (
        <div className="text-sm text-muted-foreground">Missing file URL</div>
      )}
    </div>
  )
}
