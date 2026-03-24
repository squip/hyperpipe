import { AlertTriangle, Loader2, Puzzle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { electronIpc } from '@/services/electron-ipc.service'
import type { PluginRouteContribution } from './types'

function normalizeTimeout(value?: number): number {
  if (!Number.isFinite(value)) return 15_000
  return Math.max(3_000, Math.min(Number(value), 60_000))
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asTimeoutMs(value: unknown, fallback = 12_000): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1_000, Math.min(Number(value), 60_000))
}

type PluginBridgeRequest = {
  __htpluginBridge: true
  kind: 'request'
  requestId: string
  action: 'media-command' | 'worker-command' | 'plugin-invoke'
  payload?: Record<string, unknown>
}

type PluginBridgeResponse = {
  __htpluginBridge: true
  kind: 'response'
  requestId: string
  success: boolean
  data?: unknown
  error?: string | null
}

type PluginBridgeEvent = {
  __htpluginBridge: true
  kind: 'event'
  eventType: string
  payload?: unknown
}

function isPluginBridgeRequest(value: unknown): value is PluginBridgeRequest {
  const entry = asObject(value)
  if (!entry) return false
  if (entry.__htpluginBridge !== true) return false
  if (entry.kind !== 'request') return false
  const requestId = asString(entry.requestId)
  const action = asString(entry.action)
  if (!requestId) return false
  return action === 'media-command' || action === 'worker-command' || action === 'plugin-invoke'
}

export default function PluginPageHost({
  route
}: {
  route: PluginRouteContribution
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null)
  const timeoutMs = useMemo(() => normalizeTimeout(route.timeoutMs), [route.timeoutMs])

  const postToIframe = useCallback((message: PluginBridgeResponse | PluginBridgeEvent) => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow) return
    frameWindow.postMessage(message, '*')
  }, [])

  useEffect(() => {
    setLoaded(false)
    setTimedOut(false)
    setRenderedHtml(null)
    const timer = window.setTimeout(() => {
      setTimedOut(true)
    }, timeoutMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [route.id, route.path, timeoutMs])

  useEffect(() => {
    if (route.iframeSrc) return
    if (!route.pluginId) return
    if (!electronIpc.isElectron()) return
    let cancelled = false
    electronIpc
      .invokePlugin({
        pluginId: route.pluginId,
        payload: {
          type: 'render-route',
          routeId: route.id,
          routePath: route.path
        },
        timeoutMs
      })
      .then((response) => {
        if (cancelled) return
        const normalized = response as { success?: boolean; data?: { html?: string } } | null
        if (!normalized?.success) return
        const html = typeof normalized?.data?.html === 'string' ? normalized.data.html : ''
        if (!html) return
        setRenderedHtml(html)
        setLoaded(true)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [route.id, route.path, route.pluginId, route.iframeSrc, timeoutMs])

  useEffect(() => {
    if (!electronIpc.isElectron()) return
    if (!route.pluginId) return

    const onWindowMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      if (!isPluginBridgeRequest(event.data)) return

      const request = event.data
      const requestPayload = asObject(request.payload) || {}
      const respond = (response: {
        success: boolean
        data?: unknown
        error?: string | null
      }) => {
        postToIframe({
          __htpluginBridge: true,
          kind: 'response',
          requestId: request.requestId,
          success: response.success !== false,
          data: response.data,
          error: response.error || null
        })
      }

      const pluginId = asString(route.pluginId)
      if (!pluginId) {
        respond({
          success: false,
          error: 'Plugin route is missing pluginId'
        })
        return
      }

      if (request.action === 'media-command') {
        const commandType = asString(requestPayload.type)
        if (!commandType || (!commandType.startsWith('media-') && !commandType.startsWith('p2p-'))) {
          respond({
            success: false,
            error: `Unsupported media command: ${commandType || '<empty>'}`
          })
          return
        }

        electronIpc
          .mediaCommand({
            type: commandType,
            data: asObject(requestPayload.data) || {},
            timeoutMs: asTimeoutMs(requestPayload.timeoutMs, timeoutMs),
            sourceType: 'plugin',
            pluginId
          })
          .then((result) => {
            const response = asObject(result)
            respond({
              success: response?.success !== false,
              data: result,
              error: asString(response?.error) || null
            })
          })
          .catch((error) => {
            respond({
              success: false,
              error: (error as Error)?.message || 'Media command failed'
            })
          })
        return
      }

      if (request.action === 'worker-command') {
        const commandType = asString(requestPayload.type)
        const allowlisted =
          commandType.startsWith('nostr-') ||
          commandType.startsWith('media-') ||
          commandType.startsWith('p2p-')
        if (!commandType || !allowlisted) {
          respond({
            success: false,
            error: `Unsupported worker command: ${commandType || '<empty>'}`
          })
          return
        }

        electronIpc
          .sendToWorkerAwait({
            message: {
              type: commandType,
              data: asObject(requestPayload.data) || {},
              sourceType: 'plugin',
              pluginId
            },
            timeoutMs: asTimeoutMs(requestPayload.timeoutMs, timeoutMs)
          })
          .then((result) => {
            const response = asObject(result)
            respond({
              success: response?.success !== false,
              data: result,
              error: asString(response?.error) || null
            })
          })
          .catch((error) => {
            respond({
              success: false,
              error: (error as Error)?.message || 'Worker command failed'
            })
          })
        return
      }

      electronIpc
        .invokePlugin({
          pluginId,
          payload: requestPayload.payload || {},
          timeoutMs: asTimeoutMs(requestPayload.timeoutMs, timeoutMs)
        })
        .then((result) => {
          const response = asObject(result)
          respond({
            success: response?.success !== false,
            data: result,
            error: asString(response?.error) || null
          })
        })
        .catch((error) => {
          respond({
            success: false,
            error: (error as Error)?.message || 'Plugin invoke failed'
          })
        })
    }

    window.addEventListener('message', onWindowMessage)
    return () => {
      window.removeEventListener('message', onWindowMessage)
    }
  }, [postToIframe, route.pluginId, timeoutMs])

  useEffect(() => {
    if (!electronIpc.isElectron()) return
    const offMedia = electronIpc.onMediaEvent((event) => {
      postToIframe({
        __htpluginBridge: true,
        kind: 'event',
        eventType: 'media-event',
        payload: event
      })
    })
    return () => {
      offMedia()
    }
  }, [postToIframe])

  useEffect(() => {
    if (!electronIpc.isElectron()) return
    const pluginId = asString(route.pluginId)
    const offPluginEvent = electronIpc.onPluginEvent((event) => {
      const eventObj = asObject(event)
      const eventPluginId = asString(eventObj?.pluginId)
      if (!pluginId || !eventPluginId || eventPluginId !== pluginId) return
      postToIframe({
        __htpluginBridge: true,
        kind: 'event',
        eventType: asString(eventObj?.eventType) || 'plugin-event',
        payload: eventObj?.payload ?? null
      })
    })
    return () => {
      offPluginEvent()
    }
  }, [postToIframe, route.pluginId])

  if (route.iframeSrc) {
    return (
      <div className="min-h-[var(--vh)] flex flex-col bg-background">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Puzzle className="size-4" />
            <span>{route.title || route.path}</span>
            {route.pluginName && <span className="text-xs">({route.pluginName})</span>}
          </div>
          {!loaded && (
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading plugin page
            </div>
          )}
        </div>
        {timedOut && !loaded && (
          <div className="mx-4 mt-3 p-3 rounded-md border border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div>
              Plugin page is taking longer than expected to load.
              Verify the plugin route source and permissions.
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={route.iframeSrc}
          className="flex-1 w-full border-0 bg-background"
          sandbox="allow-scripts allow-forms allow-popups allow-pointer-lock"
          allow="camera; microphone; autoplay; display-capture"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          title={route.title || route.id}
        />
      </div>
    )
  }

  if (renderedHtml) {
    return (
      <div className="min-h-[var(--vh)] flex flex-col bg-background">
        <div className="px-4 py-3 border-b flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Puzzle className="size-4" />
          <span>{route.title || route.path}</span>
          {route.pluginName && <span className="text-xs">({route.pluginName})</span>}
        </div>
        <iframe
          ref={iframeRef}
          srcDoc={renderedHtml}
          className="flex-1 w-full border-0 bg-background"
          sandbox="allow-scripts allow-forms allow-popups allow-pointer-lock"
          allow="camera; microphone; autoplay; display-capture"
          title={route.title || route.id}
        />
      </div>
    )
  }

  return (
    <div className="min-h-[var(--vh)] flex flex-col items-center justify-center p-6 text-center bg-background">
      <div className="max-w-xl rounded-xl border p-6 bg-surface-background">
        <div className="inline-flex items-center justify-center size-10 rounded-full bg-primary/10 text-primary mb-3">
          <Puzzle className="size-5" />
        </div>
        <h2 className="text-xl font-semibold">{route.title || 'Plugin Page'}</h2>
        <p className="text-muted-foreground mt-2">
          {route.description || 'This plugin route is registered and reachable.'}
        </p>
        <div className="mt-4 text-xs text-muted-foreground space-y-1">
          <div>Path: {route.path}</div>
          {route.pluginName && <div>Plugin: {route.pluginName}</div>}
          {route.version && <div>Version: {route.version}</div>}
        </div>
      </div>
    </div>
  )
}
