// Minimal IPC adapter; no-ops in web mode.
// Extend types as you learn more about worker payload shapes.

import { isElectron } from '@/lib/platform'
import type {
  InstalledPluginDescriptor,
  PluginArchivePreviewResponse,
  PluginAuditResponse,
  PluginLifecycleResponse,
  PluginPermission,
  PluginUIContributionsResponse
} from '@/plugins/types'

export type WorkerCommandResult = { success: boolean; error?: string }
export type WorkerStartResult = WorkerCommandResult & { alreadyRunning?: boolean; configSent?: boolean }
export type SaveDialogResult = {
  canceled: boolean
  filePath?: string
}

export type RelayEntry = {
  relayKey: string
  publicIdentifier?: string
  connectionUrl?: string
  userAuthToken?: string
  requiresAuth?: boolean
  writable?: boolean
  readyForReq?: boolean
  name?: string
  description?: string
  createdAt?: number
  members?: string[]
  registrationStatus?: string
  registrationError?: string
  isActive?: boolean
  gatewayPath?: string
}

export type GatewayLogEntry = {
  ts?: number | string
  level?: string
  message: string
  data?: unknown
}

export type GatewayStatus = {
  running: boolean
  host?: string
  hostname?: string
  port?: number
  wsBase?: string
  urls?: Record<string, string>
  startedAt?: number
  relays?: RelayEntry[]
  publicGateway?: PublicGatewayStatus
  peers?: unknown
  peerRelayMap?: Record<
    string,
    {
      peers?: string[]
      peerCount?: number
      status?: string
      lastActive?: number | string | null
      createdAt?: number | string | null
      metadata?: unknown
    }
  >
  peerDetails?: Record<
    string,
    {
      nostrPubkeyHex?: string | null
      relays?: string[]
      relayCount?: number
      lastSeen?: number | string | null
      status?: string
      mode?: string | null
      address?: string | null
    }
  >
  metrics?: unknown
}

export type PublicGatewayStatus = {
  enabled?: boolean
  authMethod?: string | null
  baseUrl?: string
  wsBase?: string
  defaultTokenTtl?: number
  lastUpdatedAt?: number
  discoveryWarning?: string | null
  discoveryUnavailableReason?: string | null
  disabledReason?: string | null
  discoveredGateways?: Array<{
    gatewayId: string
    publicUrl: string
    displayName?: string | null
    region?: string | null
    isExpired?: boolean
    authMethod?: string | null
    hostPolicy?: string | null
    memberDelegationMode?: string | null
    operatorPubkey?: string | null
    operatorIdentity?: GatewayOperatorIdentity | null
  }>
  authorizedGateways?: Array<{
    gatewayId: string
    publicUrl: string
    displayName?: string | null
    region?: string | null
    isExpired?: boolean
    authMethod?: string | null
    hostPolicy?: string | null
    memberDelegationMode?: string | null
    operatorPubkey?: string | null
    operatorIdentity?: GatewayOperatorIdentity | null
  }>
  gatewayAccessCatalog?: Array<{
    gatewayId?: string | null
    gatewayOrigin?: string | null
    hostingState?: string
    reason?: string | null
    lastCheckedAt?: number | null
    memberDelegationMode?: string | null
    authMethod?: string | null
    operatorIdentity?: GatewayOperatorIdentity | null
    policy?: {
      hostPolicy?: string | null
      authMethod?: string | null
      openAccess?: boolean
      operatorPubkey?: string | null
      wotRootPubkey?: string | null
      wotMaxDepth?: number | null
      wotMinFollowersDepth2?: number | null
      capabilities?: string[]
    } | null
  }>
  relays?: Record<
    string,
    {
      status?: string
      lastSyncedAt?: number
      tokenTtl?: number
      error?: string
      message?: string | null
      gatewayId?: string | null
      gatewayOrigin?: string | null
      publicIdentifier?: string | null
      name?: string | null
    }
  >
}

export type GatewayOperatorAttestationPayload = {
  purpose?: string | null
  operatorPubkey?: string | null
  gatewayId?: string | null
  publicUrl?: string | null
  issuedAt?: number | null
  expiresAt?: number | null
}

export type GatewayOperatorAttestation = {
  version?: number | null
  payload?: GatewayOperatorAttestationPayload | null
  signature?: string | null
}

export type GatewayOperatorIdentity = {
  pubkey?: string | null
  attestation?: GatewayOperatorAttestation | null
}

export type MediaCommandPayload = {
  type: string
  data?: Record<string, unknown>
  sourceType?: 'host' | 'plugin'
  pluginId?: string
  permissions?: string[]
  timeoutMs?: number
}

export type MarketplaceListing = {
  manifest?: Record<string, unknown>
  metadata?: Record<string, unknown>
  social?: Record<string, unknown>
  verification?: MarketplacePublisherVerification
}

export type MarketplacePublisherVerificationStatus = 'verified' | 'unverified' | 'mismatch'

export type MarketplacePublisherVerification = {
  status: MarketplacePublisherVerificationStatus
  manifestPublisherPubkey?: string | null
  listingPublisherPubkey?: string | null
  canInstallByDefault?: boolean
  reason?: string
}

export type MarketplaceDiscoveryResponse = {
  success: boolean
  listings?: MarketplaceListing[]
  discovered?: InstalledPluginDescriptor[]
  skipped?: Array<{ reason?: string; [key: string]: unknown }>
  relays?: string[]
  warnings?: string[]
  totalListings?: number
  error?: string
}

export type MarketplaceInstallResponse = {
  success: boolean
  plugin?: InstalledPluginDescriptor
  download?: {
    archivePath?: string
    sizeBytes?: number
    sha256?: string
    source?: string
    sourceType?: string
    warnings?: string[]
  }
  verification?: MarketplacePublisherVerification
  requiresOverride?: boolean
  overrideAccepted?: boolean
  error?: string
}

export type ReferencePluginDescriptor = {
  id: string
  slug: string
  name: string
  version: string
  summary: string
  majorCapability: string
  permissions: PluginPermission[]
  navItemCount: number
  routeCount: number
  mediaFeatureCount: number
}

export type ReferencePluginListResponse = {
  success: boolean
  plugins?: ReferencePluginDescriptor[]
  warnings?: string[]
  error?: string
}

export type ReferencePluginInstallResponse = {
  success: boolean
  plugin?: InstalledPluginDescriptor | null
  referencePlugin?: ReferencePluginDescriptor | null
  archive?: {
    sizeBytes?: number
    sha256?: string | null
  } | null
  warnings?: string[]
  error?: string
}

type ElectronAPI = {
  startWorker: (config?: unknown) => Promise<WorkerStartResult>
  stopWorker: () => Promise<WorkerCommandResult>
  sendToWorker: (message: unknown) => Promise<any>
  sendToWorkerAwait: (payload: unknown) => Promise<any>
  mediaCommand: (payload: MediaCommandPayload) => Promise<any>
  getWorkerIdentity?: () => Promise<{ success: boolean; identity?: unknown }>

  getGatewayStatus: () => Promise<{ success: boolean; status: GatewayStatus | null }>
  getGatewayLogs: () => Promise<{ success: boolean; logs: GatewayLogEntry[] }>
  startGateway: (options?: unknown) => Promise<WorkerCommandResult>
  stopGateway: () => Promise<WorkerCommandResult>

  getPublicGatewayConfig: () => Promise<{ success: boolean; config: unknown }>
  setPublicGatewayConfig: (config: unknown) => Promise<WorkerCommandResult>
  getPublicGatewayStatus: () => Promise<{ success: boolean; status: PublicGatewayStatus | null }>
  generatePublicGatewayToken: (payload: unknown) => Promise<WorkerCommandResult>
  refreshPublicGatewayRelay: (payload: unknown) => Promise<WorkerCommandResult>
  refreshPublicGatewayAll: () => Promise<WorkerCommandResult>
  readPublicGatewaySettings: () => Promise<{ success: boolean; data: unknown }>
  writePublicGatewaySettings: (settings: unknown) => Promise<WorkerCommandResult>

  readGatewaySettings: () => Promise<{ success: boolean; data: unknown }>
  writeGatewaySettings: (settings: unknown) => Promise<WorkerCommandResult>

  getStoragePath: () => Promise<string>
  getLogFilePath: () => Promise<string>
  appendLogLine: (line: string) => Promise<WorkerCommandResult>
  readFileBuffer: (filePath: string) => Promise<{ success: boolean; data: ArrayBuffer }>
  showSaveDialog: (payload: { defaultFileName?: string }) => Promise<SaveDialogResult>
  openHtmlViewerWindow: (url: string, title?: string) => Promise<WorkerCommandResult>
  openHtmlSourceViewer: (payload: {
    title?: string
    source: string
    url?: string
  }) => Promise<WorkerCommandResult>

  listPlugins?: () => Promise<{ success: boolean; plugins: unknown[] }>
  discoverPlugin?: (payload: unknown) => Promise<PluginLifecycleResponse>
  installPlugin?: (payload: unknown) => Promise<PluginLifecycleResponse>
  installPluginArchive?: (payload: { archivePath: string; source?: string }) => Promise<PluginLifecycleResponse>
  previewPluginArchive?: (payload: { archivePath: string }) => Promise<PluginArchivePreviewResponse>
  uninstallPlugin?: (payload: { pluginId: string }) => Promise<{ success: boolean; error?: string }>
  enablePlugin?: (payload: { pluginId: string }) => Promise<PluginLifecycleResponse>
  disablePlugin?: (payload: { pluginId: string }) => Promise<PluginLifecycleResponse>
  approvePluginVersion?: (payload: { pluginId: string; version?: string }) => Promise<PluginLifecycleResponse>
  rejectPluginVersion?: (payload: { pluginId: string; version?: string; reason?: string }) => Promise<PluginLifecycleResponse>
  elevatePluginTier?: (payload: { pluginId: string; tier: 'restricted' | 'elevated' }) => Promise<PluginLifecycleResponse>
  getPluginAudit?: (payload: { pluginId: string; limit?: number }) => Promise<PluginAuditResponse>
  invokePlugin?: (payload: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>
  discoverMarketplacePlugins?: (payload?: unknown) => Promise<MarketplaceDiscoveryResponse>
  installMarketplacePlugin?: (payload: {
    listing: MarketplaceListing
    bundleUrl?: string
    archiveUrl?: string
    timeoutMs?: number
    allowPublisherMismatch?: boolean
  }) => Promise<MarketplaceInstallResponse>
  getPluginUIContributions?: () => Promise<PluginUIContributionsResponse>
  listReferencePlugins?: () => Promise<ReferencePluginListResponse>
  installReferencePlugin?: (payload: {
    pluginId: string
    version?: string
  }) => Promise<ReferencePluginInstallResponse>

  importModule?: (specifier: string) => Promise<unknown>
  requireModule?: (specifier: string) => unknown

  onWorkerMessage: (cb: (message: any) => void) => () => void
  onWorkerError: (cb: (err: any) => void) => () => void
  onWorkerExit: (cb: (code: number) => void) => () => void
  onWorkerStdout: (cb: (data: string) => void) => () => void
  onWorkerStderr: (cb: (data: string) => void) => () => void
  onMediaEvent?: (cb: (event: any) => void) => () => void
  onPluginEvent?: (cb: (event: any) => void) => () => void
}

function api(): ElectronAPI | null {
  if (!isElectron()) return null
  return (window as any).electronAPI as ElectronAPI
}

function unavailable<T = any>(): Promise<T> {
  return Promise.reject(new Error('Electron IPC unavailable in web mode'))
}

export const electronIpc = {
  isElectron: () => isElectron(),

  startWorker(config?: unknown) {
    return api()?.startWorker(config) ?? unavailable()
  },
  stopWorker() {
    return api()?.stopWorker() ?? unavailable()
  },
  sendToWorker(message: unknown) {
    return api()?.sendToWorker(message) ?? unavailable()
  },
  sendToWorkerAwait(payload: unknown) {
    return api()?.sendToWorkerAwait(payload) ?? unavailable()
  },
  mediaCommand(payload: MediaCommandPayload) {
    return api()?.mediaCommand(payload) ?? unavailable()
  },
  getWorkerIdentity() {
    return api()?.getWorkerIdentity?.() ?? unavailable()
  },

  getGatewayStatus() {
    return api()?.getGatewayStatus() ?? unavailable()
  },
  getGatewayLogs() {
    return api()?.getGatewayLogs() ?? unavailable()
  },
  startGateway(options?: unknown) {
    return api()?.startGateway(options) ?? unavailable()
  },
  stopGateway() {
    return api()?.stopGateway() ?? unavailable()
  },

  getPublicGatewayConfig() {
    return api()?.getPublicGatewayConfig() ?? unavailable()
  },
  setPublicGatewayConfig(config: unknown) {
    return api()?.setPublicGatewayConfig(config) ?? unavailable()
  },
  getPublicGatewayStatus() {
    return api()?.getPublicGatewayStatus() ?? unavailable()
  },
  generatePublicGatewayToken(payload: unknown) {
    return api()?.generatePublicGatewayToken(payload) ?? unavailable()
  },
  refreshPublicGatewayRelay(payload: unknown) {
    return api()?.refreshPublicGatewayRelay(payload) ?? unavailable()
  },
  refreshPublicGatewayAll() {
    return api()?.refreshPublicGatewayAll() ?? unavailable()
  },
  readPublicGatewaySettings() {
    return api()?.readPublicGatewaySettings() ?? unavailable()
  },
  writePublicGatewaySettings(settings: unknown) {
    return api()?.writePublicGatewaySettings(settings) ?? unavailable()
  },

  readGatewaySettings() {
    return api()?.readGatewaySettings() ?? unavailable()
  },
  writeGatewaySettings(settings: unknown) {
    return api()?.writeGatewaySettings(settings) ?? unavailable()
  },

  getStoragePath() {
    return api()?.getStoragePath() ?? unavailable()
  },
  getLogFilePath() {
    return api()?.getLogFilePath() ?? unavailable()
  },
  appendLogLine(line: string) {
    return api()?.appendLogLine(line) ?? unavailable()
  },
  readFileBuffer(filePath: string) {
    return api()?.readFileBuffer(filePath) ?? unavailable()
  },
  showSaveDialog(payload: { defaultFileName?: string }) {
    return api()?.showSaveDialog(payload) ?? unavailable()
  },
  openHtmlViewerWindow(url: string, title?: string) {
    return api()?.openHtmlViewerWindow(url, title) ?? unavailable()
  },
  openHtmlSourceViewer(payload: { title?: string; source: string; url?: string }) {
    return api()?.openHtmlSourceViewer(payload) ?? unavailable()
  },
  listPlugins() {
    return api()?.listPlugins?.() ?? unavailable()
  },
  discoverPlugin(payload: unknown) {
    return api()?.discoverPlugin?.(payload) ?? unavailable()
  },
  installPlugin(payload: unknown) {
    return api()?.installPlugin?.(payload) ?? unavailable()
  },
  installPluginArchive(payload: { archivePath: string; source?: string }) {
    return api()?.installPluginArchive?.(payload) ?? unavailable()
  },
  previewPluginArchive(payload: { archivePath: string }) {
    return api()?.previewPluginArchive?.(payload) ?? unavailable()
  },
  uninstallPlugin(payload: { pluginId: string }) {
    return api()?.uninstallPlugin?.(payload) ?? unavailable()
  },
  enablePlugin(payload: { pluginId: string }) {
    return api()?.enablePlugin?.(payload) ?? unavailable()
  },
  disablePlugin(payload: { pluginId: string }) {
    return api()?.disablePlugin?.(payload) ?? unavailable()
  },
  approvePluginVersion(payload: { pluginId: string; version?: string }) {
    return api()?.approvePluginVersion?.(payload) ?? unavailable()
  },
  rejectPluginVersion(payload: { pluginId: string; version?: string; reason?: string }) {
    return api()?.rejectPluginVersion?.(payload) ?? unavailable()
  },
  elevatePluginTier(payload: { pluginId: string; tier: 'restricted' | 'elevated' }) {
    return api()?.elevatePluginTier?.(payload) ?? unavailable()
  },
  getPluginAudit(payload: { pluginId: string; limit?: number }) {
    return api()?.getPluginAudit?.(payload) ?? unavailable()
  },
  invokePlugin(payload: unknown) {
    return api()?.invokePlugin?.(payload) ?? unavailable()
  },
  discoverMarketplacePlugins(payload?: unknown) {
    return api()?.discoverMarketplacePlugins?.(payload) ?? unavailable()
  },
  installMarketplacePlugin(payload: {
    listing: MarketplaceListing
    bundleUrl?: string
    archiveUrl?: string
    timeoutMs?: number
    allowPublisherMismatch?: boolean
  }) {
    return api()?.installMarketplacePlugin?.(payload) ?? unavailable()
  },
  getPluginUIContributions() {
    return api()?.getPluginUIContributions?.() ?? unavailable()
  },
  listReferencePlugins() {
    return api()?.listReferencePlugins?.() ?? unavailable()
  },
  installReferencePlugin(payload: { pluginId: string; version?: string }) {
    return api()?.installReferencePlugin?.(payload) ?? unavailable()
  },

  onWorkerMessage(cb: (msg: any) => void) {
    return api()?.onWorkerMessage(cb) ?? (() => {})
  },
  onWorkerError(cb: (err: any) => void) {
    return api()?.onWorkerError(cb) ?? (() => {})
  },
  onWorkerExit(cb: (code: number) => void) {
    return api()?.onWorkerExit(cb) ?? (() => {})
  },
  onWorkerStdout(cb: (data: string) => void) {
    return api()?.onWorkerStdout(cb) ?? (() => {})
  },
  onWorkerStderr(cb: (data: string) => void) {
    return api()?.onWorkerStderr(cb) ?? (() => {})
  },
  onMediaEvent(cb: (event: any) => void) {
    return api()?.onMediaEvent?.(cb) ?? (() => {})
  },
  onPluginEvent(cb: (event: any) => void) {
    return api()?.onPluginEvent?.(cb) ?? (() => {})
  }
}
