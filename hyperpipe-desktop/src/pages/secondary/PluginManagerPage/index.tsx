import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import type {
  BlockedPluginContribution,
  InstalledPluginDescriptor,
  PluginArchivePreviewResponse,
  PluginAuditEntry,
  PluginAuditResponse,
  PluginContributionCollision,
  PluginLifecycleResponse,
  PluginPermission,
  PluginStatus,
  PluginUIContributionsResponse
} from '@/plugins/types'
import type {
  MarketplaceDiscoveryResponse,
  MarketplaceInstallResponse,
  MarketplaceListing,
  MarketplacePublisherVerification,
  MarketplacePublisherVerificationStatus,
  ReferencePluginDescriptor,
  ReferencePluginInstallResponse,
  ReferencePluginListResponse
} from '@/services/electron-ipc.service'
import { electronIpc } from '@/services/electron-ipc.service'
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Download,
  Loader2,
  Puzzle,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload
} from 'lucide-react'
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

type PluginListResponse = {
  success: boolean
  plugins?: InstalledPluginDescriptor[]
  error?: string
}

type ElectronFile = File & {
  path?: string
}

type PluginPermissionDenial = {
  ts: number
  commandType: string
  reason: string
  requiredPermission: string | null
}

const STATUS_VARIANT: Record<PluginStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  discovered: 'secondary',
  installed: 'secondary',
  approved: 'outline',
  enabled: 'default',
  disabled: 'outline',
  blocked: 'destructive'
}

const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  'renderer.nav': 'Add sidebar navigation entries.',
  'renderer.route': 'Register additive plugin pages.',
  'nostr.read': 'Read Nostr data through host services.',
  'nostr.publish': 'Publish Nostr events through host services.',
  'p2p.session': 'Create or join host-managed P2P sessions.',
  'media.session': 'Use host media session orchestration.',
  'media.record': 'Start and stop host recording jobs.',
  'media.transcode': 'Run host-managed transcode/export jobs.'
}

const PUBLISHER_VERIFICATION_LABELS: Record<MarketplacePublisherVerificationStatus, string> = {
  verified: 'Verified',
  unverified: 'Unverified',
  mismatch: 'Mismatch'
}

const PUBLISHER_VERIFICATION_BADGE_VARIANTS: Record<
  MarketplacePublisherVerificationStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  verified: 'default',
  unverified: 'secondary',
  mismatch: 'destructive'
}

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || value == null || value < 0) return '0 B'
  if (value < 1024) return `${value} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatDate(value?: number | null): string {
  if (!Number.isFinite(value) || !value) return 'Not set'
  return new Date(value).toLocaleString()
}

function sortPlugins(plugins: InstalledPluginDescriptor[]): InstalledPluginDescriptor[] {
  return [...plugins].sort((a, b) => {
    const labelA = `${a.name || ''}-${a.id || ''}`.toLowerCase()
    const labelB = `${b.name || ''}-${b.id || ''}`.toLowerCase()
    return labelA.localeCompare(labelB)
  })
}

function getManifestPermissions(preview: PluginArchivePreviewResponse): PluginPermission[] {
  const permissions = preview.manifest?.permissions
  return Array.isArray(permissions) ? permissions : []
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getListingManifest(listing: MarketplaceListing): Record<string, unknown> {
  return asObject(listing?.manifest) || {}
}

function getListingMetadata(listing: MarketplaceListing): Record<string, unknown> {
  return asObject(listing?.metadata) || {}
}

function getListingPermissions(listing: MarketplaceListing): PluginPermission[] {
  const manifest = getListingManifest(listing)
  const permissionsRaw = Array.isArray(manifest.permissions) ? manifest.permissions : []
  return permissionsRaw.filter((permission): permission is PluginPermission =>
    typeof permission === 'string' && permission in PERMISSION_DESCRIPTIONS
  )
}

function getListingId(listing: MarketplaceListing, index: number): string {
  const manifest = getListingManifest(listing)
  const metadata = getListingMetadata(listing)
  const pluginId = asString(manifest.id)
  const version = asString(manifest.version)
  const eventId = asString(metadata.eventId)
  return [pluginId || 'unknown', version || '0.0.0', eventId || String(index)].join(':')
}

function getListingBundleSource(listing: MarketplaceListing): string {
  const metadata = getListingMetadata(listing)
  const manifest = getListingManifest(listing)
  const sourceObj = asObject(manifest.source)
  return (
    asString(metadata.bundleUrl) ||
    asString(metadata.archiveUrl) ||
    asString(metadata.bundle_url) ||
    asString(metadata.archive_url) ||
    asString(sourceObj?.bundleUrl) ||
    asString(sourceObj?.archiveUrl) ||
    ''
  )
}

function canInstallListing(listing: MarketplaceListing): boolean {
  if (getListingBundleSource(listing)) return true
  const metadata = getListingMetadata(listing)
  const manifest = getListingManifest(listing)
  const sourceObj = asObject(manifest.source)
  const hyperdriveUrl = asString(metadata.hyperdriveUrl) || asString(sourceObj?.hyperdriveUrl)
  const sourcePath = asString(sourceObj?.path)
  if (hyperdriveUrl && sourcePath && sourcePath.endsWith('.tgz')) return true
  return false
}

function normalizePublisherVerification(
  value: unknown
): MarketplacePublisherVerification | null {
  const entry = asObject(value)
  if (!entry) return null
  const status = asString(entry.status).toLowerCase()
  if (status !== 'verified' && status !== 'unverified' && status !== 'mismatch') {
    return null
  }
  const normalizedStatus = status as MarketplacePublisherVerificationStatus
  return {
    status: normalizedStatus,
    manifestPublisherPubkey: asString(entry.manifestPublisherPubkey || entry.manifestPublisher) || null,
    listingPublisherPubkey: asString(entry.listingPublisherPubkey || entry.listingPublisher) || null,
    canInstallByDefault:
      typeof entry.canInstallByDefault === 'boolean'
        ? entry.canInstallByDefault
        : normalizedStatus !== 'mismatch',
    reason: asString(entry.reason) || undefined
  }
}

function getListingPublisherVerification(listing: MarketplaceListing): MarketplacePublisherVerification {
  const fromListing = normalizePublisherVerification((listing as Record<string, unknown>)?.verification)
  if (fromListing) return fromListing

  const metadata = getListingMetadata(listing)
  const fromMetadata = normalizePublisherVerification(metadata.publisherVerification)
  if (fromMetadata) return fromMetadata

  const manifest = getListingManifest(listing)
  const manifestPublisher = asString(asObject(manifest.marketplace)?.publisherPubkey).toLowerCase()
  const listingPublisher = asString(metadata.pubkey || metadata.publisherPubkey).toLowerCase()
  const normalizedManifest = /^[a-f0-9]{64}$/.test(manifestPublisher) ? manifestPublisher : ''
  const normalizedListing = /^[a-f0-9]{64}$/.test(listingPublisher) ? listingPublisher : ''

  if (normalizedManifest && normalizedListing) {
    if (normalizedManifest === normalizedListing) {
      return {
        status: 'verified',
        manifestPublisherPubkey: normalizedManifest,
        listingPublisherPubkey: normalizedListing,
        canInstallByDefault: true,
        reason: 'manifest-and-listing-publisher-match'
      }
    }
    return {
      status: 'mismatch',
      manifestPublisherPubkey: normalizedManifest,
      listingPublisherPubkey: normalizedListing,
      canInstallByDefault: false,
      reason: 'manifest-and-listing-publisher-mismatch'
    }
  }

  return {
    status: 'unverified',
    manifestPublisherPubkey: normalizedManifest || null,
    listingPublisherPubkey: normalizedListing || null,
    canInstallByDefault: true,
    reason: normalizedManifest || normalizedListing ? 'publisher-pubkey-invalid' : 'publisher-pubkey-missing'
  }
}

function createPublisherMismatchPrompt(verification: MarketplacePublisherVerification): string {
  return [
    'Publisher mismatch detected for this listing.',
    `Listing publisher: ${verification.listingPublisherPubkey || 'unknown'}`,
    `Manifest publisher: ${verification.manifestPublisherPubkey || 'unknown'}`,
    '',
    'By default, install is blocked on mismatch.',
    'Do you want to override and continue with install anyway?'
  ].join('\n')
}

function normalizePermissionDenial(entry: PluginAuditEntry): PluginPermissionDenial | null {
  if (!entry || entry.action !== 'worker-command-denied') return null
  const details = asObject(entry.details)
  const commandType = asString(details?.commandType || details?.command) || 'unknown-command'
  const reason = asString(details?.reason) || 'permission-denied'
  const requiredPermission = asString(details?.requiredPermission) || null
  const ts = Number.isFinite(entry.ts) ? Number(entry.ts) : Date.now()
  return {
    ts,
    commandType,
    reason,
    requiredPermission
  }
}

function getDenialRemediation(denial: PluginPermissionDenial, plugin: InstalledPluginDescriptor): string {
  if (denial.reason === 'not-approved') {
    return 'Approve the installed version before it can invoke worker or media commands.'
  }
  if (denial.reason === 'not-enabled') {
    return 'Enable the plugin after approval to allow runtime command execution.'
  }
  if (denial.reason === 'missing-permission') {
    if (denial.requiredPermission) {
      const hasPermission = Array.isArray(plugin.permissions) && plugin.permissions.includes(denial.requiredPermission as PluginPermission)
      if (!hasPermission) {
        return `Manifest is missing "${denial.requiredPermission}". Add it, publish a new package, then reinstall and approve that version.`
      }
      return `Permission "${denial.requiredPermission}" is required. Re-approve and re-enable the plugin if this version changed.`
    }
    return 'This action requires an additional permission in the plugin manifest. Publish an updated package and re-approve.'
  }
  return 'Check plugin approval state and requested permissions, then retry the action.'
}

function formatBlockedContributionReason(blocked: BlockedPluginContribution): string {
  switch (blocked.reason) {
    case 'plugin-not-approved':
      return 'Plugin version is not approved.'
    case 'plugin-not-enabled':
      return 'Plugin is currently disabled.'
    case 'missing-permission':
      return blocked.requiredPermission
        ? `Missing required permission: ${blocked.requiredPermission}.`
        : 'Missing required renderer permission.'
    case 'invalid-route-path':
      return 'Route contribution is missing a valid path.'
    case 'invalid-route-namespace':
      return 'Route path is outside the plugin namespace (/plugins/<pluginId>/...).'
    case 'invalid-nav-id':
      return 'Nav contribution is missing a valid id.'
    case 'invalid-nav-route':
      return 'Nav contribution is missing routePath.'
    case 'invalid-nav-namespace':
      return 'Nav routePath is outside the plugin namespace (/plugins/<pluginId>/...).'
    case 'route-collision':
      return blocked.conflictWith
        ? `Route collides with plugin "${blocked.conflictWith}".`
        : 'Route collides with another plugin route.'
    default:
      return 'Contribution is blocked by host policy.'
  }
}

const PluginManagerPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [plugins, setPlugins] = useState<InstalledPluginDescriptor[]>([])
  const [loadingPlugins, setLoadingPlugins] = useState(true)
  const [refreshingPlugins, setRefreshingPlugins] = useState(false)
  const [pluginError, setPluginError] = useState<string | null>(null)

  const [selectedArchivePath, setSelectedArchivePath] = useState('')
  const [selectedArchiveName, setSelectedArchiveName] = useState('')
  const [preview, setPreview] = useState<PluginArchivePreviewResponse | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [installingArchive, setInstallingArchive] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [marketplaceListings, setMarketplaceListings] = useState<MarketplaceListing[]>([])
  const [marketplaceRelays, setMarketplaceRelays] = useState<string[]>([])
  const [marketplaceWarnings, setMarketplaceWarnings] = useState<string[]>([])
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null)
  const [discoveringMarketplace, setDiscoveringMarketplace] = useState(false)
  const [installingMarketplaceKey, setInstallingMarketplaceKey] = useState<string | null>(null)
  const [marketplaceRefreshedAt, setMarketplaceRefreshedAt] = useState<number | null>(null)
  const [referencePlugins, setReferencePlugins] = useState<ReferencePluginDescriptor[]>([])
  const [referenceWarnings, setReferenceWarnings] = useState<string[]>([])
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [loadingReferencePlugins, setLoadingReferencePlugins] = useState(false)
  const [installingReferencePluginId, setInstallingReferencePluginId] = useState<string | null>(null)
  const [permissionDenialsByPlugin, setPermissionDenialsByPlugin] = useState<
    Record<string, PluginPermissionDenial[]>
  >({})
  const [loadingPermissionDenials, setLoadingPermissionDenials] = useState(false)
  const [permissionDenialError, setPermissionDenialError] = useState<string | null>(null)
  const [uiContributionCollisions, setUiContributionCollisions] = useState<PluginContributionCollision[]>([])
  const [uiBlockedContributions, setUiBlockedContributions] = useState<BlockedPluginContribution[]>([])
  const [uiContributionError, setUiContributionError] = useState<string | null>(null)

  const sortedPlugins = useMemo(() => sortPlugins(plugins), [plugins])
  const sortedReferencePlugins = useMemo(
    () =>
      [...referencePlugins].sort((a, b) => {
        const aKey = `${a.name || ''}-${a.id || ''}`.toLowerCase()
        const bKey = `${b.name || ''}-${b.id || ''}`.toLowerCase()
        return aKey.localeCompare(bKey)
      }),
    [referencePlugins]
  )
  const manifestPermissions = useMemo(() => (preview ? getManifestPermissions(preview) : []), [preview])
  const previewRouteCount = preview?.manifest?.contributions?.routes?.length || 0
  const previewNavCount = preview?.manifest?.contributions?.navItems?.length || 0
  const previewMediaCount = preview?.manifest?.contributions?.mediaFeatures?.length || 0
  const canInstallPreview = Boolean(
    selectedArchivePath &&
      preview?.success &&
      preview?.manifest &&
      preview?.archive?.path === selectedArchivePath
  )

  const fetchPluginPermissionDenials = useCallback(async (pluginId: string) => {
    const normalizedPluginId = asString(pluginId)
    if (!normalizedPluginId || !electronIpc.isElectron()) return []
    const response = (await electronIpc.getPluginAudit({
      pluginId: normalizedPluginId,
      limit: 120
    })) as PluginAuditResponse
    if (!response?.success) {
      throw new Error(response?.error || `Failed to load audit for ${normalizedPluginId}`)
    }
    const entries = Array.isArray(response.entries) ? response.entries : []
    return entries
      .map((entry) => normalizePermissionDenial(entry))
      .filter((entry): entry is PluginPermissionDenial => !!entry)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 4)
  }, [])

  const refreshPermissionDenials = useCallback(
    async (targetPlugins: InstalledPluginDescriptor[]) => {
      if (!electronIpc.isElectron()) {
        setPermissionDenialsByPlugin({})
        setPermissionDenialError(null)
        setLoadingPermissionDenials(false)
        return
      }

      const pluginIds = Array.from(
        new Set(
          (Array.isArray(targetPlugins) ? targetPlugins : [])
            .map((plugin) => asString(plugin.id))
            .filter(Boolean)
        )
      )
      if (!pluginIds.length) {
        setPermissionDenialsByPlugin({})
        setPermissionDenialError(null)
        setLoadingPermissionDenials(false)
        return
      }

      setLoadingPermissionDenials(true)
      setPermissionDenialError(null)
      const denialsByPlugin: Record<string, PluginPermissionDenial[]> = {}
      let failures = 0

      try {
        const settled = await Promise.allSettled(
          pluginIds.map(async (pluginId) => {
            const denials = await fetchPluginPermissionDenials(pluginId)
            return [pluginId, denials] as const
          })
        )

        for (const result of settled) {
          if (result.status === 'fulfilled') {
            const [pluginId, denials] = result.value
            denialsByPlugin[pluginId] = denials
            continue
          }
          failures += 1
        }
      } finally {
        setPermissionDenialsByPlugin(denialsByPlugin)
        if (failures > 0) {
          setPermissionDenialError(`Failed to load denied action history for ${failures} plugin(s).`)
        } else {
          setPermissionDenialError(null)
        }
        setLoadingPermissionDenials(false)
      }
    },
    [fetchPluginPermissionDenials]
  )

  const refreshPermissionDenialsForPlugin = useCallback(
    async (pluginId: string) => {
      const normalizedPluginId = asString(pluginId)
      if (!normalizedPluginId || !electronIpc.isElectron()) return
      try {
        const denials = await fetchPluginPermissionDenials(normalizedPluginId)
        setPermissionDenialsByPlugin((previous) => ({
          ...previous,
          [normalizedPluginId]: denials
        }))
      } catch (_) {}
    },
    [fetchPluginPermissionDenials]
  )

  const loadPlugins = useCallback(async (mode: 'initial' | 'refresh' = 'refresh') => {
    if (!electronIpc.isElectron()) {
      setPlugins([])
      setPermissionDenialsByPlugin({})
      setPermissionDenialError(null)
      setLoadingPermissionDenials(false)
      setUiContributionCollisions([])
      setUiBlockedContributions([])
      setUiContributionError(null)
      setLoadingPlugins(false)
      setRefreshingPlugins(false)
      setPluginError('Plugin management is available only in the desktop app.')
      return
    }

    if (mode === 'initial') {
      setLoadingPlugins(true)
    } else {
      setRefreshingPlugins(true)
    }

    try {
      const [pluginListResult, uiContributionsResult] = await Promise.allSettled([
        electronIpc.listPlugins(),
        electronIpc.getPluginUIContributions()
      ])

      if (pluginListResult.status !== 'fulfilled') {
        throw pluginListResult.reason
      }

      const response = pluginListResult.value as PluginListResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to load plugins')
      }
      const nextPlugins = Array.isArray(response.plugins) ? response.plugins : []
      setPlugins(nextPlugins)
      setPluginError(null)

      if (uiContributionsResult.status === 'fulfilled') {
        const uiResponse = uiContributionsResult.value as PluginUIContributionsResponse
        if (uiResponse?.success) {
          setUiContributionCollisions(Array.isArray(uiResponse.collisions) ? uiResponse.collisions : [])
          setUiBlockedContributions(
            Array.isArray(uiResponse.blockedContributions) ? uiResponse.blockedContributions : []
          )
          setUiContributionError(null)
        } else {
          setUiContributionCollisions([])
          setUiBlockedContributions([])
          setUiContributionError(uiResponse?.error || 'Failed to load contribution diagnostics')
        }
      } else {
        setUiContributionCollisions([])
        setUiBlockedContributions([])
        setUiContributionError(
          (uiContributionsResult.reason as Error)?.message || 'Failed to load contribution diagnostics'
        )
      }

      refreshPermissionDenials(nextPlugins).catch(() => {})
    } catch (error) {
      const message = (error as Error)?.message || 'Failed to load plugins'
      setPluginError(message)
    } finally {
      setLoadingPlugins(false)
      setRefreshingPlugins(false)
    }
  }, [refreshPermissionDenials])

  const loadReferencePlugins = useCallback(async () => {
    if (!electronIpc.isElectron()) {
      setReferencePlugins([])
      setReferenceWarnings([])
      setReferenceError(null)
      setLoadingReferencePlugins(false)
      return
    }

    setLoadingReferencePlugins(true)
    setReferenceError(null)
    try {
      const response = (await electronIpc.listReferencePlugins()) as ReferencePluginListResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to load first-party reference plugins')
      }
      setReferencePlugins(Array.isArray(response.plugins) ? response.plugins : [])
      setReferenceWarnings(Array.isArray(response.warnings) ? response.warnings : [])
      setReferenceError(null)
    } catch (error) {
      setReferencePlugins([])
      setReferenceWarnings([])
      setReferenceError((error as Error)?.message || 'Failed to load first-party reference plugins')
    } finally {
      setLoadingReferencePlugins(false)
    }
  }, [])

  useEffect(() => {
    loadPlugins('initial').catch(() => {})
  }, [loadPlugins])

  useEffect(() => {
    loadReferencePlugins().catch(() => {})
  }, [loadReferencePlugins])

  useEffect(() => {
    if (!electronIpc.isElectron()) return
    const offWorkerMessage = electronIpc.onWorkerMessage((message: unknown) => {
      const payload = asObject(message)
      if (!payload || asString(payload.type) !== 'plugin-permission-denied') return
      const pluginId = asString(payload.pluginId)
      if (!pluginId) return
      refreshPermissionDenialsForPlugin(pluginId).catch(() => {})
    })
    return () => {
      offWorkerMessage()
    }
  }, [refreshPermissionDenialsForPlugin])

  const inspectArchive = useCallback(async (archivePath: string) => {
    if (!archivePath) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const response = (await electronIpc.previewPluginArchive({
        archivePath
      })) as PluginArchivePreviewResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to inspect plugin package')
      }
      setPreview(response)
      toast.success('Plugin package inspected')
    } catch (error) {
      const message = (error as Error)?.message || 'Failed to inspect plugin package'
      setPreview(null)
      setPreviewError(message)
      toast.error(message)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const onArchiveFileSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] as ElectronFile | undefined
      if (!file) {
        setSelectedArchivePath('')
        setSelectedArchiveName('')
        setPreview(null)
        setPreviewError(null)
        return
      }

      const archivePath = typeof file.path === 'string' ? file.path.trim() : ''
      if (!archivePath) {
        setSelectedArchivePath('')
        setSelectedArchiveName(file.name || '')
        setPreview(null)
        setPreviewError('Selected file path is unavailable. Use desktop file picker in Electron.')
        return
      }

      setSelectedArchivePath(archivePath)
      setSelectedArchiveName(file.name || '')
      setPreview(null)
      setPreviewError(null)
      inspectArchive(archivePath).catch(() => {})
    },
    [inspectArchive]
  )

  const installSelectedArchive = useCallback(async () => {
    if (!selectedArchivePath) {
      setPreviewError('Select a plugin package before installing.')
      return
    }
    if (!canInstallPreview) {
      setPreviewError('Inspect the selected package before installing.')
      return
    }

    setInstallingArchive(true)
    setPreviewError(null)
    try {
      const response = (await electronIpc.installPluginArchive({
        archivePath: selectedArchivePath,
        source: 'settings-upload'
      })) as PluginLifecycleResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to install plugin package')
      }

      toast.success(`Installed plugin ${response?.plugin?.name || response?.plugin?.id || 'package'}`)
      setSelectedArchivePath('')
      setSelectedArchiveName('')
      setPreview(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      await loadPlugins('refresh')
    } catch (error) {
      const message = (error as Error)?.message || 'Failed to install plugin package'
      setPreviewError(message)
      toast.error(message)
    } finally {
      setInstallingArchive(false)
    }
  }, [canInstallPreview, loadPlugins, selectedArchivePath])

  const discoverMarketplace = useCallback(async () => {
    if (!electronIpc.isElectron()) return

    setDiscoveringMarketplace(true)
    setMarketplaceError(null)
    try {
      const response = (await electronIpc.discoverMarketplacePlugins({
        limit: 150
      })) as MarketplaceDiscoveryResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to discover marketplace plugins')
      }

      const listings = Array.isArray(response.listings) ? response.listings : []
      setMarketplaceListings(listings)
      setMarketplaceRelays(Array.isArray(response.relays) ? response.relays : [])
      setMarketplaceWarnings(Array.isArray(response.warnings) ? response.warnings : [])
      setMarketplaceRefreshedAt(Date.now())
      toast.success(`Marketplace discovery complete (${listings.length} listings)`)
      await loadPlugins('refresh')
    } catch (error) {
      const message = (error as Error)?.message || 'Failed to discover marketplace plugins'
      setMarketplaceError(message)
      toast.error(message)
    } finally {
      setDiscoveringMarketplace(false)
    }
  }, [loadPlugins])

  const installMarketplaceListing = useCallback(
    async (listing: MarketplaceListing, listingKey: string) => {
      if (!electronIpc.isElectron()) return
      setInstallingMarketplaceKey(listingKey)
      try {
        const verificationFromListing = getListingPublisherVerification(listing)
        let allowPublisherMismatch = false
        if (verificationFromListing.status === 'mismatch') {
          const confirmed = window.confirm(createPublisherMismatchPrompt(verificationFromListing))
          if (!confirmed) {
            toast.error('Marketplace install cancelled due to publisher mismatch.')
            return
          }
          allowPublisherMismatch = true
        }

        let response = (await electronIpc.installMarketplacePlugin({
          listing,
          allowPublisherMismatch
        })) as MarketplaceInstallResponse

        if (
          !response?.success &&
          response?.requiresOverride &&
          response?.verification?.status === 'mismatch' &&
          !allowPublisherMismatch
        ) {
          const confirmed = window.confirm(createPublisherMismatchPrompt(response.verification))
          if (!confirmed) {
            throw new Error(response?.error || 'Marketplace install blocked due to publisher mismatch')
          }
          response = (await electronIpc.installMarketplacePlugin({
            listing,
            allowPublisherMismatch: true
          })) as MarketplaceInstallResponse
        }

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to install marketplace plugin')
        }

        const pluginName = response?.plugin?.name || response?.plugin?.id || 'plugin'
        const verification = response?.verification || verificationFromListing
        const suffix =
          verification?.status === 'verified'
            ? ' (publisher verified)'
            : verification?.status === 'mismatch'
              ? ' (publisher mismatch override)'
              : ' (publisher unverified)'
        toast.success(`Installed ${pluginName} from marketplace${suffix}`)
        await loadPlugins('refresh')
      } catch (error) {
        toast.error((error as Error)?.message || 'Failed to install marketplace plugin')
      } finally {
        setInstallingMarketplaceKey(null)
      }
    },
    [loadPlugins]
  )

  const installReferencePlugin = useCallback(
    async (referencePlugin: ReferencePluginDescriptor) => {
      if (!electronIpc.isElectron()) return
      const pluginId = asString(referencePlugin?.id).toLowerCase()
      if (!pluginId) return
      setInstallingReferencePluginId(pluginId)
      setReferenceError(null)
      try {
        const response = (await electronIpc.installReferencePlugin({
          pluginId,
          version: asString(referencePlugin?.version) || undefined
        })) as ReferencePluginInstallResponse
        if (!response?.success) {
          throw new Error(response?.error || `Failed to install reference plugin ${pluginId}`)
        }
        const pluginLabel = response?.plugin?.name || response?.plugin?.id || referencePlugin.name || pluginId
        toast.success(`Installed first-party reference plugin ${pluginLabel}`)
        await Promise.all([loadPlugins('refresh'), loadReferencePlugins()])
      } catch (error) {
        const message = (error as Error)?.message || `Failed to install reference plugin ${pluginId}`
        setReferenceError(message)
        toast.error(message)
      } finally {
        setInstallingReferencePluginId(null)
      }
    },
    [loadPlugins, loadReferencePlugins]
  )

  const runPluginAction = useCallback(
    async (
      plugin: InstalledPluginDescriptor,
      action: 'approve' | 'reject' | 'enable' | 'disable' | 'uninstall'
    ) => {
      if (!electronIpc.isElectron()) return
      if (action === 'uninstall') {
        const confirmed = window.confirm(
          `Uninstall plugin "${plugin.name}" (${plugin.id}) version ${plugin.version}?`
        )
        if (!confirmed) return
      }

      const actionKey = `${plugin.id}:${action}`
      setPendingAction(actionKey)
      try {
        let response: PluginLifecycleResponse | { success: boolean; error?: string } | null = null
        if (action === 'approve') {
          response = (await electronIpc.approvePluginVersion({
            pluginId: plugin.id,
            version: plugin.version
          })) as PluginLifecycleResponse
        } else if (action === 'reject') {
          response = (await electronIpc.rejectPluginVersion({
            pluginId: plugin.id,
            version: plugin.version,
            reason: 'Rejected by user in plugin manager'
          })) as PluginLifecycleResponse
        } else if (action === 'enable') {
          response = (await electronIpc.enablePlugin({
            pluginId: plugin.id
          })) as PluginLifecycleResponse
        } else if (action === 'disable') {
          response = (await electronIpc.disablePlugin({
            pluginId: plugin.id
          })) as PluginLifecycleResponse
        } else {
          response = await electronIpc.uninstallPlugin({
            pluginId: plugin.id
          })
        }

        if (!response?.success) {
          throw new Error(response?.error || `Failed to ${action} plugin`)
        }
        const actionLabelMap: Record<typeof action, string> = {
          approve: 'Approved',
          reject: 'Rejected',
          enable: 'Enabled',
          disable: 'Disabled',
          uninstall: 'Uninstalled'
        }
        toast.success(
          `${actionLabelMap[action]} ${plugin.name || plugin.id}`
        )
        await loadPlugins('refresh')
      } catch (error) {
        toast.error((error as Error)?.message || `Failed to ${action} plugin`)
      } finally {
        setPendingAction(null)
      }
    },
    [loadPlugins]
  )

  return (
    <SecondaryPageLayout ref={ref} index={index} title={t('Plugins')}>
      <div className="px-4 py-3 space-y-4">
        {!electronIpc.isElectron() && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
            Plugin management is available only in the Electron desktop app.
          </div>
        )}

        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Install Plugin Package</h2>
              <p className="text-xs text-muted-foreground">
                Upload a <code>.htplugin.tgz</code> package, inspect manifest + permissions, then
                install.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadPlugins('refresh')}
              disabled={refreshingPlugins || loadingPlugins}
            >
              {refreshingPlugins ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>

          <div className="space-y-2">
            <label htmlFor="plugin-archive-upload" className="text-sm font-medium">
              Plugin Archive
            </label>
            <input
              id="plugin-archive-upload"
              ref={fileInputRef}
              type="file"
              accept=".htplugin.tgz,.tgz,application/gzip,application/x-gzip"
              className="block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm"
              onChange={onArchiveFileSelected}
            />
            {selectedArchiveName && (
              <div className="text-xs text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{selectedArchiveName}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!selectedArchivePath || previewLoading || installingArchive}
                onClick={() => inspectArchive(selectedArchivePath)}
              >
                {previewLoading ? <Loader2 className="animate-spin" /> : <Upload />}
                Inspect Package
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canInstallPreview || installingArchive}
                onClick={installSelectedArchive}
              >
                {installingArchive ? <Loader2 className="animate-spin" /> : <Download />}
                Install Package
              </Button>
            </div>
            {previewError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{previewError}</span>
              </div>
            )}
          </div>

          {preview?.success && preview.manifest && (
            <div className="rounded-lg border bg-surface-background p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Puzzle className="size-4" />
                <div className="font-medium">
                  {preview.manifest.name} <span className="text-muted-foreground">({preview.manifest.id})</span>
                </div>
                <Badge variant="outline">v{preview.manifest.version}</Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <div className="text-muted-foreground">Archive Size</div>
                  <div className="font-medium">{formatBytes(preview.archive?.sizeBytes)}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-muted-foreground">Archive Entries</div>
                  <div className="font-medium">{preview.archive?.entryCount || 0}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-muted-foreground">Package Files</div>
                  <div className="font-medium">{preview.packageStats?.fileCount || 0}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-muted-foreground">Package Bytes</div>
                  <div className="font-medium">{formatBytes(preview.packageStats?.totalBytes)}</div>
                </div>
              </div>
              <div className="text-xs space-y-1">
                <div className="text-muted-foreground">Contributions</div>
                <div className="font-medium">
                  {previewRouteCount} routes, {previewNavCount} nav items, {previewMediaCount} media features
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Permissions</div>
                {manifestPermissions.length ? (
                  <div className="flex flex-wrap gap-2">
                    {manifestPermissions.map((permission) => (
                      <Badge key={permission} variant="secondary" title={PERMISSION_DESCRIPTIONS[permission]}>
                        {permission}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No permissions requested.</div>
                )}
              </div>
              <div className="rounded-md border bg-background p-3 text-xs space-y-1">
                <div className="font-medium">Integrity</div>
                <div className="break-all">
                  Bundle SHA-256: <code>{preview.integrity?.computedBundleSha256 || preview.archive?.sha256}</code>
                </div>
                {preview.integrity?.bundleTarget && (
                  <div className="break-all">
                    Bundle Target: <code>{preview.integrity.bundleTarget}</code>
                  </div>
                )}
                {preview.integrity?.sourceDirectoryPresent && (
                  <div className="break-all">
                    Source SHA-256: <code>{preview.integrity?.computedSourceSha256}</code>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">First-Party Reference Plugins</h2>
              <p className="text-xs text-muted-foreground">
                Curated sample plugins that demonstrate additive pages, media/P2P APIs, and advanced route UX.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingReferencePlugins}
              onClick={() => loadReferencePlugins()}
            >
              {loadingReferencePlugins ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh Catalog
            </Button>
          </div>

          {referenceError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
              {referenceError}
            </div>
          )}
          {referenceWarnings.length > 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div className="font-medium">Reference catalog warnings</div>
              {referenceWarnings.slice(0, 5).map((warning, index) => (
                <div key={`reference-warning-${index}`}>{warning}</div>
              ))}
            </div>
          )}

          {!sortedReferencePlugins.length ? (
            <div className="rounded-md border bg-surface-background p-4 text-sm text-muted-foreground">
              {loadingReferencePlugins
                ? 'Loading first-party reference plugins...'
                : 'No first-party reference plugins are currently available.'}
            </div>
          ) : (
            <div className="space-y-3">
              {sortedReferencePlugins.map((referencePlugin) => {
                const installedPlugin = sortedPlugins.find(
                  (plugin) =>
                    plugin.id === referencePlugin.id &&
                    (!referencePlugin.version || plugin.version === referencePlugin.version)
                )
                const isInstalling = installingReferencePluginId === referencePlugin.id
                return (
                  <div
                    key={referencePlugin.id}
                    className="rounded-md border bg-surface-background p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="font-medium">{referencePlugin.name || referencePlugin.id}</div>
                        <div className="text-xs text-muted-foreground">
                          {referencePlugin.id} • v{referencePlugin.version}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {installedPlugin ? <Badge variant="outline">Installed</Badge> : null}
                        <Badge variant="secondary">First-Party</Badge>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground space-y-1">
                      <div>{referencePlugin.summary}</div>
                      <div>
                        Major capability: <span className="font-medium">{referencePlugin.majorCapability}</span>
                      </div>
                      <div>
                        Contributions: {referencePlugin.routeCount} routes, {referencePlugin.navItemCount} nav
                        items, {referencePlugin.mediaFeatureCount} media features
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">Permissions</div>
                      {referencePlugin.permissions?.length ? (
                        <div className="flex flex-wrap gap-2">
                          {referencePlugin.permissions.map((permission) => (
                            <Badge
                              key={`${referencePlugin.id}:${permission}`}
                              variant="secondary"
                              title={PERMISSION_DESCRIPTIONS[permission]}
                            >
                              {permission}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">No permissions requested.</div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={isInstalling}
                        onClick={() => installReferencePlugin(referencePlugin)}
                      >
                        {isInstalling ? <Loader2 className="animate-spin" /> : <Download />}
                        Install Reference Plugin
                      </Button>
                      {installedPlugin && (
                        <span className="text-xs text-muted-foreground">
                          Installed status: {installedPlugin.status}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Marketplace Discovery</h2>
              <p className="text-xs text-muted-foreground">
                Discover plugins from Nostr listings + Hyperdrive metadata and install directly.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={discoveringMarketplace}
              onClick={() => discoverMarketplace()}
            >
              {discoveringMarketplace ? <Loader2 className="animate-spin" /> : <CloudDownload />}
              Discover
            </Button>
          </div>

          {marketplaceRelays.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Relays: {marketplaceRelays.join(', ')}
            </div>
          )}
          {marketplaceRefreshedAt && (
            <div className="text-xs text-muted-foreground">
              Last discovery: {formatDate(marketplaceRefreshedAt)}
            </div>
          )}
          {marketplaceError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
              {marketplaceError}
            </div>
          )}
          {marketplaceWarnings.length > 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div className="font-medium">Discovery warnings</div>
              {marketplaceWarnings.slice(0, 5).map((warning, index) => (
                <div key={`marketplace-warning-${index}`}>{warning}</div>
              ))}
            </div>
          )}

          {!marketplaceListings.length ? (
            <div className="rounded-md border bg-surface-background p-4 text-sm text-muted-foreground">
              Run discovery to load marketplace listings.
            </div>
          ) : (
            <div className="space-y-3">
              {marketplaceListings.map((listing, index) => {
                const listingManifest = getListingManifest(listing)
                const listingMetadata = getListingMetadata(listing)
                const listingKey = getListingId(listing, index)
                const pluginId = asString(listingManifest.id)
                const version = asString(listingManifest.version)
                const listingName = asString(listingManifest.name) || pluginId || `Listing ${index + 1}`
                const permissions = getListingPermissions(listing)
                const contributions = asObject(listingManifest.contributions)
                const routeCount = Array.isArray(contributions?.routes) ? contributions.routes.length : 0
                const navCount = Array.isArray(contributions?.navItems) ? contributions.navItems.length : 0
                const mediaCount = Array.isArray(contributions?.mediaFeatures)
                  ? contributions.mediaFeatures.length
                  : 0
                const publisher = asString(
                  asObject(listingManifest.marketplace)?.publisherPubkey || listingMetadata.pubkey
                )
                const bundleSource = getListingBundleSource(listing)
                const recommendCount = asNumber(asObject(listingMetadata.social)?.recommendCount)
                const installCount = asNumber(asObject(listingMetadata.social)?.installCount)
                const flagCount = asNumber(asObject(listingMetadata.social)?.flagCount)
                const publisherVerification = getListingPublisherVerification(listing)
                const publisherVerificationLabel = PUBLISHER_VERIFICATION_LABELS[publisherVerification.status]
                const publisherVerificationBadgeVariant =
                  PUBLISHER_VERIFICATION_BADGE_VARIANTS[publisherVerification.status]
                const installedPlugin = sortedPlugins.find(
                  (plugin) => plugin.id === pluginId && (!version || plugin.version === version)
                )
                const canInstall = canInstallListing(listing)
                const isInstalling = installingMarketplaceKey === listingKey

                return (
                  <div key={listingKey} className="rounded-md border bg-surface-background p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="font-medium">{listingName}</div>
                        <div className="text-xs text-muted-foreground">
                          {pluginId || 'unknown-id'} {version ? `• v${version}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {installedPlugin ? <Badge variant="outline">Installed</Badge> : null}
                        <Badge variant={publisherVerificationBadgeVariant}>
                          Publisher {publisherVerificationLabel}
                        </Badge>
                        <Badge variant="secondary">Marketplace</Badge>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground space-y-1">
                      <div>
                        Contributions: {routeCount} routes, {navCount} nav items, {mediaCount} media features
                      </div>
                      <div>
                        Publisher: {publisher || 'unknown'}
                        {asString(listingMetadata.eventId)
                          ? ` • Event: ${asString(listingMetadata.eventId).slice(0, 16)}`
                          : ''}
                      </div>
                      <div>
                        Publisher verification: <span className="font-medium">{publisherVerificationLabel}</span>
                        {publisherVerification.status === 'mismatch' && (
                          <>
                            {' '}
                            • listing {publisherVerification.listingPublisherPubkey || 'unknown'} vs manifest{' '}
                            {publisherVerification.manifestPublisherPubkey || 'unknown'}
                          </>
                        )}
                      </div>
                      {(recommendCount != null || installCount != null || flagCount != null) && (
                        <div className="inline-flex items-center gap-1">
                          <Shield className="size-3" />
                          Trust signals: recommends {recommendCount ?? 0}, installs {installCount ?? 0}, flags{' '}
                          {flagCount ?? 0}
                        </div>
                      )}
                      {bundleSource && (
                        <div className="break-all">
                          Bundle: <code>{bundleSource}</code>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">Permissions</div>
                      {permissions.length ? (
                        <div className="flex flex-wrap gap-2">
                          {permissions.map((permission) => (
                            <Badge key={`${listingKey}:${permission}`} variant="secondary">
                              {permission}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">No permissions listed.</div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={!canInstall || isInstalling}
                        onClick={() => installMarketplaceListing(listing, listingKey)}
                      >
                        {isInstalling ? <Loader2 className="animate-spin" /> : <Download />}
                        Install From Listing
                      </Button>
                      {!canInstall && (
                        <div className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1">
                          <AlertTriangle className="size-3" />
                          Listing is missing archive bundle metadata.
                        </div>
                      )}
                      {canInstall && publisherVerification.status === 'mismatch' && (
                        <div className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1">
                          <AlertTriangle className="size-3" />
                          Default install is blocked for publisher mismatch. Override confirmation required.
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Contribution Policy Diagnostics</h2>
              <p className="text-xs text-muted-foreground">
                Collisions and blocked route/nav contributions from host policy evaluation.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={uiContributionCollisions.length > 0 ? 'destructive' : 'outline'}>
                Collisions: {uiContributionCollisions.length}
              </Badge>
              <Badge variant={uiBlockedContributions.length > 0 ? 'destructive' : 'outline'}>
                Blocked: {uiBlockedContributions.length}
              </Badge>
            </div>
          </div>

          {uiContributionError && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
              {uiContributionError}
            </div>
          )}

          {!uiContributionError &&
            !uiContributionCollisions.length &&
            !uiBlockedContributions.length && (
              <div className="rounded-md border bg-surface-background p-4 text-sm text-muted-foreground">
                No collisions or blocked contributions detected.
              </div>
            )}

          {uiContributionCollisions.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-destructive">Route collisions</div>
              <div className="space-y-2">
                {uiContributionCollisions.map((collision, index) => (
                  <div
                    key={`collision:${collision.path}:${collision.pluginId}:${index}`}
                    className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs space-y-1"
                  >
                    <div className="font-mono">{collision.path}</div>
                    <div>
                      Blocked plugin <span className="font-medium">{collision.pluginId}</span> collides with{' '}
                      <span className="font-medium">{collision.conflictWith}</span>.
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {uiBlockedContributions.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-destructive">Blocked contributions</div>
              <div className="space-y-2 max-h-72 overflow-auto pr-1">
                {uiBlockedContributions.map((blocked, index) => {
                  const pluginLabel = asString(blocked.pluginName) || blocked.pluginId || 'unknown-plugin'
                  const contributionType = blocked.contributionType === 'route' ? 'Route' : 'Nav item'
                  return (
                    <div
                      key={`blocked:${blocked.pluginId}:${blocked.contributionType}:${blocked.contributionId || blocked.path || index}`}
                      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{pluginLabel}</span>
                        <Badge variant="outline">{contributionType}</Badge>
                        {blocked.contributionId ? <span className="font-mono">{blocked.contributionId}</span> : null}
                      </div>
                      {blocked.path ? (
                        <div className="font-mono break-all text-muted-foreground">{blocked.path}</div>
                      ) : null}
                      <div>{formatBlockedContributionReason(blocked)}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Installed Plugins</h2>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingPermissionDenials || loadingPlugins || refreshingPlugins || !sortedPlugins.length}
                onClick={() => refreshPermissionDenials(sortedPlugins)}
              >
                {loadingPermissionDenials ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Refresh Denials
              </Button>
              <Badge variant="outline">{sortedPlugins.length}</Badge>
            </div>
          </div>

          {pluginError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
              {pluginError}
            </div>
          )}
          {permissionDenialError && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
              {permissionDenialError}
            </div>
          )}
          {loadingPermissionDenials && !loadingPlugins && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading denied action history...
            </div>
          )}

          {loadingPlugins ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading plugins...
            </div>
          ) : !sortedPlugins.length ? (
            <div className="rounded-md border bg-surface-background p-4 text-sm text-muted-foreground">
              No plugins installed yet.
            </div>
          ) : (
            <div className="space-y-3">
              {sortedPlugins.map((plugin) => {
                const pendingForPlugin = typeof pendingAction === 'string' && pendingAction.startsWith(`${plugin.id}:`)
                const isApprovedVersion = plugin.approvedVersion === plugin.version
                const routeCount = plugin.contributions?.routes?.length || 0
                const navCount = plugin.contributions?.navItems?.length || 0
                const mediaCount = plugin.contributions?.mediaFeatures?.length || 0
                const deniedActions = Array.isArray(permissionDenialsByPlugin[plugin.id])
                  ? permissionDenialsByPlugin[plugin.id]
                  : []
                return (
                  <div key={plugin.id} className="rounded-md border bg-surface-background p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div className="font-medium">{plugin.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {plugin.id} • v{plugin.version} • tier: {plugin.tier}
                        </div>
                      </div>
                      <Badge variant={STATUS_VARIANT[plugin.status] || 'secondary'}>{plugin.status}</Badge>
                    </div>

                    <div className="text-xs text-muted-foreground">
                      Installed: {formatDate(plugin.installedAt)} • Last updated: {formatDate(plugin.updatedAt)}
                    </div>

                    <div className="text-xs space-y-1">
                      <div>
                        Contributions: {routeCount} routes, {navCount} nav items, {mediaCount} media features
                      </div>
                      <div>
                        Approved Version:{' '}
                        <span className="font-medium">{plugin.approvedVersion || 'Not approved'}</span>
                        {plugin.rejectedVersion && (
                          <span className="text-destructive">
                            {' '}
                            • Rejected: {plugin.rejectedVersion} ({formatDate(plugin.rejectedAt)})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">Permissions</div>
                      {plugin.permissions?.length ? (
                        <div className="flex flex-wrap gap-2">
                          {plugin.permissions.map((permission) => (
                            <Badge
                              key={`${plugin.id}:${permission}`}
                              variant="secondary"
                              title={PERMISSION_DESCRIPTIONS[permission]}
                            >
                              {permission}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">No permissions requested.</div>
                      )}
                    </div>

                    {deniedActions.length > 0 && (
                      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
                        <div className="flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-200">
                          <ShieldAlert className="size-3.5" />
                          Recent denied plugin actions
                        </div>
                        {deniedActions.map((denial) => (
                          <div
                            key={`${plugin.id}:${denial.commandType}:${denial.ts}`}
                            className="rounded border border-amber-500/40 bg-background/70 p-2 text-xs space-y-1"
                          >
                            <div className="font-mono text-[11px]">{denial.commandType}</div>
                            <div className="text-amber-900 dark:text-amber-200">
                              Reason: {denial.reason}
                              {denial.requiredPermission
                                ? ` • Required permission: ${denial.requiredPermission}`
                                : ''}
                            </div>
                            <div className="text-amber-800 dark:text-amber-300">
                              {getDenialRemediation(denial, plugin)}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {formatDate(denial.ts)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {!isApprovedVersion && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pendingForPlugin}
                          onClick={() => runPluginAction(plugin, 'approve')}
                        >
                          {pendingAction === `${plugin.id}:approve` ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <ShieldCheck />
                          )}
                          Approve Version
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pendingForPlugin}
                        onClick={() => runPluginAction(plugin, 'reject')}
                      >
                        {pendingAction === `${plugin.id}:reject` ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ShieldAlert />
                        )}
                        Reject Version
                      </Button>
                      {plugin.enabled ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pendingForPlugin}
                          onClick={() => runPluginAction(plugin, 'disable')}
                        >
                          {pendingAction === `${plugin.id}:disable` ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <AlertTriangle />
                          )}
                          Disable
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          disabled={!isApprovedVersion || pendingForPlugin}
                          onClick={() => runPluginAction(plugin, 'enable')}
                        >
                          {pendingAction === `${plugin.id}:enable` ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <CheckCircle2 />
                          )}
                          Enable
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost-destructive"
                        disabled={pendingForPlugin}
                        onClick={() => runPluginAction(plugin, 'uninstall')}
                      >
                        {pendingAction === `${plugin.id}:uninstall` ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                        Uninstall
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </SecondaryPageLayout>
  )
})

PluginManagerPage.displayName = 'PluginManagerPage'

export default PluginManagerPage
