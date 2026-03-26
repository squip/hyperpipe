import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useFetchHtmlAnalysis } from '@/hooks/useFetchHtmlAnalysis'
import { cn } from '@/lib/utils'
import { electronIpc } from '@/services/electron-ipc.service'
import webService from '@/services/web.service'
import { Code, ExternalLink, FileCode2, Globe, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function openHtmlSourceFallback(source: string, title: string) {
  const popup = window.open('', '_blank', 'noopener,noreferrer')
  if (!popup) return false

  popup.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        font-family: SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace;
        background: #0b1020;
        color: #e5edf5;
      }
      header {
        position: sticky;
        top: 0;
        padding: 12px 16px;
        background: rgba(11, 16, 32, 0.96);
        border-bottom: 1px solid rgba(229, 237, 245, 0.12);
      }
      pre {
        margin: 0;
        padding: 16px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <header>${escapeHtml(title)}</header>
    <pre>${escapeHtml(source)}</pre>
  </body>
</html>`)
  popup.document.close()
  return true
}

export default function HtmlFilePreviewCard({
  url,
  fileName,
  summary,
  className
}: {
  url: string
  fileName: string
  summary?: string | null
  className?: string
}) {
  const {
    title,
    description,
    image,
    htmlSource,
    declaredExternalOrigins,
    hasMetaPreview,
    isLoading
  } = useFetchHtmlAnalysis(url)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [viewingCode, setViewingCode] = useState(false)

  const resolvedTitle = title || fileName || 'HTML document'
  const resolvedDescription =
    description || summary || 'HTML document stored on your Hyperpipe file system.'
  const externalOrigins = declaredExternalOrigins || []

  const handleConfirmOpen = async () => {
    try {
      setOpening(true)
      if (electronIpc.isElectron()) {
        const response = await electronIpc.openHtmlViewerWindow(url, resolvedTitle)
        if (!response?.success) {
          throw new Error(response?.error || 'Failed to open HTML file')
        }
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      setConfirmOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open HTML file')
    } finally {
      setOpening(false)
    }
  }

  const handleViewCode = async () => {
    try {
      setViewingCode(true)
      const analysis = htmlSource ? { htmlSource } : await webService.fetchHtmlAnalysis(url)
      const source = analysis.htmlSource
      if (!source) {
        throw new Error('Unable to load HTML source for this file')
      }

      if (electronIpc.isElectron()) {
        const response = await electronIpc.openHtmlSourceViewer({
          title: resolvedTitle,
          source,
          url
        })
        if (!response?.success) {
          throw new Error(response?.error || 'Failed to open source viewer')
        }
        return
      }

      if (!openHtmlSourceFallback(source, resolvedTitle)) {
        throw new Error('Failed to open source viewer')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open source viewer')
    } finally {
      setViewingCode(false)
    }
  }

  return (
    <>
      <div className={cn('relative overflow-hidden rounded-lg border bg-muted/10', className)}>
        <div className="absolute right-3 top-3 z-10 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="bg-background/90 shadow-sm backdrop-blur"
            onClick={(event) => {
              event.stopPropagation()
              setConfirmOpen(true)
            }}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="bg-background/90 shadow-sm backdrop-blur"
            onClick={(event) => {
              event.stopPropagation()
              void handleViewCode()
            }}
            disabled={viewingCode}
          >
            {viewingCode ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Code className="mr-1.5 h-3.5 w-3.5" />
            )}
            View code
          </Button>
        </div>

        {image ? (
          <div className="relative h-48 w-full overflow-hidden bg-muted/30">
            <img src={image} alt={resolvedTitle} className="h-full w-full object-cover" loading="lazy" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/30 to-transparent" />
          </div>
        ) : (
          <div className="flex h-40 w-full items-center justify-center bg-gradient-to-br from-muted/60 via-background to-muted/30">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-background/70 shadow-sm">
                <FileCode2 className="h-7 w-7 text-muted-foreground" />
              </div>
              <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                HTML Preview
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2 p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            {hasMetaPreview ? 'HTML document' : isLoading ? 'Loading HTML preview' : 'HTML document'}
          </div>
          <div className="text-base font-semibold leading-snug">{resolvedTitle}</div>
          <div className="text-sm text-muted-foreground">
            {isLoading && !hasMetaPreview ? 'Scanning HTML metadata...' : resolvedDescription}
          </div>
          <div className="truncate text-xs text-muted-foreground">{url}</div>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open HTML file?</AlertDialogTitle>
            <AlertDialogDescription>
              This document will render in an isolated popup window with standard browser security.
              External requests listed below are a best-effort static scan of the HTML source.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="font-medium">{resolvedTitle}</div>
              <div className="mt-1 break-all text-xs text-muted-foreground">{url}</div>
            </div>
            {externalOrigins.length > 0 ? (
              <div className="space-y-2">
                <div className="font-medium">Detected external origins</div>
                <div className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/10 p-3">
                  {externalOrigins.map((origin) => (
                    <div key={origin} className="break-all text-xs text-muted-foreground">
                      {origin}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/10 p-3 text-xs text-muted-foreground">
                No external origins were detected in the HTML source during the static scan.
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={opening}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmOpen()} disabled={opening}>
              {opening ? 'Opening…' : 'Continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
