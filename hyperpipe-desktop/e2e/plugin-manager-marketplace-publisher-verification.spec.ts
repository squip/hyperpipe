import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __marketplaceInstallPayloads?: Array<Record<string, unknown>>
    __marketplaceConfirmMessages?: string[]
  }
}

test('marketplace install requires explicit override for publisher mismatch', async ({ page }) => {
  await page.addInitScript(() => {
    const pluginId = 'com.test.publisher-mismatch'
    const pluginVersion = '1.0.0'
    const mismatchVerification = {
      status: 'mismatch',
      manifestPublisherPubkey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      listingPublisherPubkey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      canInstallByDefault: false,
      reason: 'manifest-and-listing-publisher-mismatch'
    }

    ;(window as Window & { __marketplaceInstallPayloads?: Array<Record<string, unknown>> })
      .__marketplaceInstallPayloads = []
    ;(window as Window & { __marketplaceConfirmMessages?: string[] }).__marketplaceConfirmMessages = []
    window.confirm = (message: string) => {
      window.__marketplaceConfirmMessages?.push(message)
      return true
    }

    const noopSuccess = async () => ({ success: true })
    const noopListener = () => () => {}

    const electronApi = new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, prop) {
          const method = String(prop)
          if (method === 'listPlugins') {
            return async () => ({ success: true, plugins: [] })
          }
          if (method === 'getPluginAudit') {
            return async () => ({ success: true, entries: [] })
          }
          if (method === 'getPluginUIContributions') {
            return async () => ({
              success: true,
              plugins: [],
              routes: [],
              navItems: [],
              collisions: [],
              blockedContributions: []
            })
          }
          if (method === 'discoverMarketplacePlugins') {
            return async () => ({
              success: true,
              relays: ['wss://relay.example.test'],
              warnings: [],
              listings: [
                {
                  manifest: {
                    id: pluginId,
                    name: 'Publisher Mismatch Plugin',
                    version: pluginVersion,
                    permissions: ['renderer.nav'],
                    contributions: {
                      navItems: [],
                      routes: [],
                      mediaFeatures: []
                    },
                    marketplace: {
                      publisherPubkey: mismatchVerification.manifestPublisherPubkey
                    },
                    source: {
                      bundleUrl: 'https://example.test/plugin.htplugin.tgz'
                    }
                  },
                  metadata: {
                    pubkey: mismatchVerification.listingPublisherPubkey,
                    eventId: 'event-1234'
                  },
                  verification: mismatchVerification
                }
              ]
            })
          }
          if (method === 'installMarketplacePlugin') {
            return async (payload: Record<string, unknown>) => {
              window.__marketplaceInstallPayloads?.push(payload)
              if (payload.allowPublisherMismatch !== true) {
                return {
                  success: false,
                  error: 'Publisher mismatch detected between listing and manifest.',
                  requiresOverride: true,
                  verification: mismatchVerification
                }
              }
              return {
                success: true,
                plugin: {
                  id: pluginId,
                  name: 'Publisher Mismatch Plugin',
                  version: pluginVersion
                },
                verification: mismatchVerification,
                overrideAccepted: true
              }
            }
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
          return noopSuccess
        }
      }
    )

    ;(window as Window & { electronAPI?: unknown }).electronAPI = electronApi
    window.localStorage.setItem('hyperpipe_worker_autostart_enabled', 'false')
  })

  await page.goto('/settings/plugins')
  await expect(page.getByText('Marketplace Discovery')).toBeVisible({ timeout: 90_000 })

  await page.getByRole('button', { name: 'Discover' }).click()
  await expect(page.getByText('Publisher Mismatch Plugin')).toBeVisible()
  await expect(page.getByText('Publisher Mismatch', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Default install is blocked for publisher mismatch. Override confirmation required.')
  ).toBeVisible()

  await page.getByRole('button', { name: 'Install From Listing' }).click()

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__marketplaceConfirmMessages?.length || 0)
    })
    .toBe(1)

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__marketplaceInstallPayloads?.length || 0)
    })
    .toBe(1)

  const installPayload = await page.evaluate(() => window.__marketplaceInstallPayloads?.[0] || null)
  expect(installPayload?.allowPublisherMismatch).toBe(true)
})
