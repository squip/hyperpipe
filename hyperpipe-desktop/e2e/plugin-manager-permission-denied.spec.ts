import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __emitPluginPermissionDenied?: () => void
  }
}

test('plugin manager shows denied-action card after permission-denied event', async ({ page }) => {
  await page.addInitScript(() => {
    const pluginId = 'com.test.permission-denied'
    const pluginVersion = '1.0.0'
    const listeners = {
      workerMessage: new Set<(message: unknown) => void>()
    }
    let includeDeniedAudit = false

    const pluginDescriptor = {
      id: pluginId,
      name: 'Permission Test Plugin',
      version: pluginVersion,
      tier: 'restricted',
      status: 'enabled',
      enabled: true,
      approvedVersion: pluginVersion,
      rejectedVersion: null,
      rejectedAt: null,
      permissions: ['renderer.nav', 'renderer.route', 'p2p.session'],
      contributions: {
        navItems: [],
        routes: [],
        mediaFeatures: []
      },
      installedAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000
    }

    const registerListener = (
      key: 'workerMessage',
      callback: ((payload: unknown) => void) | undefined
    ) => {
      if (typeof callback !== 'function') return () => {}
      listeners[key].add(callback)
      return () => {
        listeners[key].delete(callback)
      }
    }

    const emitListener = (key: 'workerMessage', payload: unknown) => {
      for (const callback of Array.from(listeners[key])) {
        try {
          callback(payload)
        } catch (_) {}
      }
    }

    const noopSuccess = async () => ({ success: true })
    const noopListener = () => () => {}

    const electronApi = new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, prop) {
          const method = String(prop)

          if (method === 'listPlugins') {
            return async () => ({ success: true, plugins: [pluginDescriptor] })
          }
          if (method === 'getPluginAudit') {
            return async (payload: { pluginId?: string } = {}) => {
              if (payload?.pluginId !== pluginId || !includeDeniedAudit) {
                return { success: true, entries: [] }
              }
              return {
                success: true,
                entries: [
                  {
                    ts: Date.now(),
                    action: 'worker-command-denied',
                    level: 'warn',
                    details: {
                      commandType: 'media-start-recording',
                      reason: 'missing-permission',
                      requiredPermission: 'media.record'
                    }
                  }
                ]
              }
            }
          }
          if (method === 'discoverMarketplacePlugins') {
            return async () => ({ success: true, listings: [], relays: [], warnings: [] })
          }
          if (method === 'getPluginUIContributions') {
            return async () => ({ success: true, plugins: [], routes: [], navItems: [], collisions: [] })
          }
          if (method === 'onWorkerMessage') {
            return (callback: (payload: unknown) => void) => registerListener('workerMessage', callback)
          }
          if (method === 'onWorkerError') return noopListener
          if (method === 'onWorkerExit') return noopListener
          if (method === 'onWorkerStdout') return noopListener
          if (method === 'onWorkerStderr') return noopListener
          if (method === 'onMediaEvent') return noopListener
          if (method === 'onPluginEvent') return noopListener
          if (method === 'getGatewayStatus') return async () => ({ success: true, status: null })
          if (method === 'getGatewayLogs') return async () => ({ success: true, logs: [] })
          if (method === 'getPublicGatewayConfig') return async () => ({ success: true, config: {} })
          if (method === 'getPublicGatewayStatus') return async () => ({ success: true, status: null })
          if (method === 'readConfig') return async () => ({ success: true, data: {} })
          if (method === 'readGatewaySettings') return async () => ({ success: true, data: {} })
          if (method === 'readPublicGatewaySettings') return async () => ({ success: true, data: {} })
          if (method === 'getStoragePath') return async () => '/tmp/hyperpipe-e2e'
          if (method === 'getLogFilePath') return async () => '/tmp/hyperpipe-e2e/desktop-console.log'
          if (method === 'readFileBuffer') {
            return async () => ({ success: false, error: 'Not available in e2e mock', data: new ArrayBuffer(0) })
          }
          if (method === 'requireModule') return () => ({})
          if (method === 'importModule') return async () => ({})
          if (method.startsWith('on')) return noopListener
          return noopSuccess
        }
      }
    )

    ;(window as Window & { electronAPI?: unknown }).electronAPI = electronApi
    window.localStorage.setItem('hyperpipe_worker_autostart_enabled', 'false')
    window.__emitPluginPermissionDenied = () => {
      includeDeniedAudit = true
      emitListener('workerMessage', {
        type: 'plugin-permission-denied',
        pluginId,
        command: 'media-start-recording'
      })
    }
  })

  await page.goto('/settings/plugins')

  await expect(page.getByText('Installed Plugins')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Permission Test Plugin')).toBeVisible()
  await expect(page.getByText('Plugin management is available only in the desktop app.')).toHaveCount(0)
  await expect(page.getByText('Recent denied plugin actions')).toHaveCount(0)

  await page.evaluate(() => {
    window.__emitPluginPermissionDenied?.()
  })

  await expect(page.getByText('Recent denied plugin actions')).toBeVisible()
  await expect(page.getByText('media-start-recording')).toBeVisible()
  await expect(page.getByText('Required permission: media.record')).toBeVisible()
  await expect(page.getByText('Manifest is missing "media.record".')).toBeVisible()
})
