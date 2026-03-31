import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __referenceInstallCalls?: Array<{ pluginId?: string; version?: string }>
  }
}

type ReferencePluginDescriptor = {
  id: string
  slug: string
  name: string
  version: string
  summary: string
  majorCapability: string
  permissions: string[]
  navItemCount: number
  routeCount: number
  mediaFeatureCount: number
}

test('plugin manager installs first-party reference plugins from catalog', async ({ page }) => {
  await page.addInitScript(() => {
    const referenceCatalog: ReferencePluginDescriptor[] = [
      {
        id: 'com.hyperpipe.reference.hello-nav-page',
        slug: 'hello-nav-page',
        name: 'Hello Nav Page',
        version: '1.0.0',
        summary: 'Minimal additive sidebar + page plugin.',
        majorCapability: 'Renderer nav + route contribution',
        permissions: ['renderer.nav', 'renderer.route'],
        navItemCount: 1,
        routeCount: 1,
        mediaFeatureCount: 0
      },
      {
        id: 'com.hyperpipe.reference.p2p-audio-room',
        slug: 'p2p-audio-room',
        name: 'P2P Audio Room',
        version: '1.0.0',
        summary: 'Media/P2P control panel demonstrating session lifecycle and signaling.',
        majorCapability: 'Host media + p2p signaling APIs',
        permissions: ['renderer.nav', 'renderer.route', 'media.session', 'p2p.session', 'media.record'],
        navItemCount: 1,
        routeCount: 1,
        mediaFeatureCount: 1
      },
      {
        id: 'com.hyperpipe.reference.threejs-multiplayer-demo',
        slug: 'threejs-multiplayer-demo',
        name: 'Three.js Multiplayer Demo',
        version: '1.0.0',
        summary: 'Three.js route with simulated multiplayer state over host P2P signaling.',
        majorCapability: 'Interactive 3D route + multiplayer signaling bridge',
        permissions: ['renderer.nav', 'renderer.route', 'media.session', 'p2p.session'],
        navItemCount: 1,
        routeCount: 1,
        mediaFeatureCount: 1
      }
    ]

    const installedPlugins: Array<Record<string, unknown>> = []
    ;(window as Window & { __referenceInstallCalls?: Array<{ pluginId?: string; version?: string }> })
      .__referenceInstallCalls = []

    function asString(value: unknown) {
      return typeof value === 'string' ? value.trim() : ''
    }

    function upsertPlugin(entry: Record<string, unknown>) {
      const pluginId = asString(entry.id)
      if (!pluginId) return
      const index = installedPlugins.findIndex((plugin) => asString(plugin.id) === pluginId)
      if (index === -1) {
        installedPlugins.push(entry)
        return
      }
      installedPlugins[index] = entry
    }

    function toInstalledPlugin(referencePlugin: ReferencePluginDescriptor): Record<string, unknown> {
      return {
        id: referencePlugin.id,
        name: referencePlugin.name,
        version: referencePlugin.version,
        tier: 'restricted',
        status: 'installed',
        enabled: false,
        approvedVersion: null,
        rejectedVersion: null,
        rejectedAt: null,
        permissions: referencePlugin.permissions,
        contributions: {
          navItems: Array.from({ length: referencePlugin.navItemCount }, (_value, index) => ({
            id: `nav-${index + 1}`,
            title: `${referencePlugin.name} Nav ${index + 1}`,
            routePath: `/plugins/${referencePlugin.id}/page-${index + 1}`
          })),
          routes: Array.from({ length: referencePlugin.routeCount }, (_value, index) => ({
            id: `route-${index + 1}`,
            title: `${referencePlugin.name} Route ${index + 1}`,
            path: `/plugins/${referencePlugin.id}/page-${index + 1}`
          })),
          mediaFeatures: Array.from({ length: referencePlugin.mediaFeatureCount }, (_value, index) => ({
            id: `media-${index + 1}`,
            name: `${referencePlugin.name} Media ${index + 1}`
          }))
        },
        installedAt: Date.now(),
        updatedAt: Date.now()
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
            return async () => ({ success: true, plugins: installedPlugins })
          }
          if (method === 'listReferencePlugins') {
            return async () => ({
              success: true,
              plugins: referenceCatalog,
              warnings: []
            })
          }
          if (method === 'installReferencePlugin') {
            return async (payload: { pluginId?: string; version?: string } = {}) => {
              window.__referenceInstallCalls?.push({
                pluginId: payload?.pluginId,
                version: payload?.version
              })
              const pluginId = asString(payload?.pluginId).toLowerCase()
              const referencePlugin = referenceCatalog.find((entry) => entry.id === pluginId)
              if (!referencePlugin) {
                return {
                  success: false,
                  error: `Reference plugin not found: ${pluginId || '<empty>'}`
                }
              }
              if (payload?.version && payload.version !== referencePlugin.version) {
                return {
                  success: false,
                  error: `Version mismatch for ${pluginId}`
                }
              }
              const installedPlugin = toInstalledPlugin(referencePlugin)
              upsertPlugin(installedPlugin)
              return {
                success: true,
                plugin: installedPlugin,
                referencePlugin
              }
            }
          }
          if (method === 'discoverMarketplacePlugins') {
            return async () => ({ success: true, listings: [], relays: [], warnings: [] })
          }
          if (method === 'getPluginUIContributions') {
            return async () => ({
              success: true,
              plugins: installedPlugins,
              routes: [],
              navItems: [],
              collisions: [],
              blockedContributions: []
            })
          }
          if (method === 'getPluginAudit') {
            return async () => ({ success: true, entries: [] })
          }
          if (method.startsWith('on')) return noopListener
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
          return noopSuccess
        }
      }
    )

    ;(window as Window & { electronAPI?: unknown }).electronAPI = electronApi
    window.localStorage.setItem('hyperpipe_worker_autostart_enabled', 'false')
  })

  await page.goto('/settings/plugins')
  await expect(page.getByText('First-Party Reference Plugins')).toBeVisible({ timeout: 90_000 })

  const referencePluginNames = ['Hello Nav Page', 'P2P Audio Room', 'Three.js Multiplayer Demo']
  for (const [index, pluginName] of referencePluginNames.entries()) {
    await expect(page.getByText(pluginName)).toBeVisible()
    const referenceCard = page
      .locator('div.rounded-md.border.bg-surface-background')
      .filter({ hasText: pluginName })
      .first()
    await referenceCard.getByRole('button', { name: 'Install Reference Plugin' }).click()
    await expect
      .poll(async () => {
        return await page.evaluate(() => window.__referenceInstallCalls?.length || 0)
      })
      .toBe(index + 1)
  }

  const installCalls = await page.evaluate(() => window.__referenceInstallCalls || [])
  expect(installCalls).toHaveLength(3)
  expect(installCalls.map((entry) => entry.pluginId)).toEqual([
    'com.hyperpipe.reference.hello-nav-page',
    'com.hyperpipe.reference.p2p-audio-room',
    'com.hyperpipe.reference.threejs-multiplayer-demo'
  ])
})
