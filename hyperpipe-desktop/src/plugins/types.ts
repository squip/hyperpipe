export type PluginTier = 'restricted' | 'elevated'

export type PluginStatus =
  | 'discovered'
  | 'installed'
  | 'approved'
  | 'enabled'
  | 'disabled'
  | 'blocked'

export type PluginPermission =
  | 'renderer.nav'
  | 'renderer.route'
  | 'nostr.read'
  | 'nostr.publish'
  | 'p2p.session'
  | 'media.session'
  | 'media.record'
  | 'media.transcode'

export type PluginRouteContribution = {
  id: string
  title: string
  description?: string
  path: string
  iframeSrc?: string
  moduleId?: string
  timeoutMs?: number
  pluginId?: string
  pluginName?: string
  version?: string
  tier?: PluginTier
}

export type PluginNavItemContribution = {
  id: string
  title: string
  description?: string
  icon?: string
  routePath: string
  order?: number
  pluginId?: string
  pluginName?: string
  version?: string
  tier?: PluginTier
}

export type PluginMediaFeatureContribution = {
  id: string
  name: string
  description?: string
  maxBitrateKbps?: number
  maxSessions?: number
  supportsRecording?: boolean
  supportsTranscode?: boolean
}

export type InstalledPluginDescriptor = {
  id: string
  name: string
  version: string
  tier: PluginTier
  status: PluginStatus
  enabled: boolean
  approvedVersion?: string | null
  rejectedVersion?: string | null
  rejectedAt?: number | null
  permissions: PluginPermission[]
  contributions?: {
    navItems?: PluginNavItemContribution[]
    routes?: PluginRouteContribution[]
    mediaFeatures?: PluginMediaFeatureContribution[]
  }
  engines?: {
    hypertuna?: string
    worker?: string
    renderer?: string
    mediaApi?: string
  }
  installedAt?: number | null
  discoveredAt?: number | null
  updatedAt?: number | null
}

export type PluginContributionCollision = {
  path: string
  pluginId: string
  conflictWith: string
}

export type BlockedPluginContributionType = 'route' | 'nav-item'

export type BlockedPluginContributionReason =
  | 'plugin-not-approved'
  | 'plugin-not-enabled'
  | 'missing-permission'
  | 'invalid-route-path'
  | 'invalid-route-namespace'
  | 'invalid-nav-id'
  | 'invalid-nav-route'
  | 'invalid-nav-namespace'
  | 'route-collision'

export type BlockedPluginContribution = {
  pluginId: string
  pluginName?: string
  version?: string
  tier?: PluginTier
  contributionType: BlockedPluginContributionType
  contributionId?: string | null
  path?: string | null
  reason: BlockedPluginContributionReason
  requiredPermission?: PluginPermission | null
  conflictWith?: string | null
}

export type PluginUIContributionsResponse = {
  success: boolean
  plugins: InstalledPluginDescriptor[]
  navItems: PluginNavItemContribution[]
  routes: PluginRouteContribution[]
  collisions?: PluginContributionCollision[]
  blockedContributions?: BlockedPluginContribution[]
  error?: string
}

export type PluginAuditEntry = {
  ts: number
  action: string
  level: 'info' | 'warn' | 'error'
  details?: Record<string, unknown>
}

export type PluginAuditResponse = {
  success: boolean
  entries?: PluginAuditEntry[]
  error?: string
}

export type PluginLifecycleResponse = {
  success: boolean
  plugin?: InstalledPluginDescriptor
  error?: string
}

export type PluginArchivePreviewResponse = {
  success: boolean
  archive?: {
    path: string
    sizeBytes: number
    entryCount: number
    sha256: string
  }
  manifest?: {
    id: string
    name: string
    version: string
    permissions?: PluginPermission[]
    contributions?: {
      navItems?: PluginNavItemContribution[]
      routes?: PluginRouteContribution[]
      mediaFeatures?: PluginMediaFeatureContribution[]
    }
    engines?: {
      hypertuna?: string
      worker?: string
      renderer?: string
      mediaApi?: string
    }
    integrity?: {
      bundleSha256?: string
      sourceSha256?: string
    }
  }
  packageStats?: {
    fileCount: number
    totalBytes: number
  }
  integrity?: {
    computedBundleSha256: string
    computedSourceSha256?: string
    declaredBundleSha256?: string
    declaredSourceSha256?: string
    sourceDirectoryPresent: boolean
    bundleTarget?: string
    bundleMode?: string
  }
  error?: string
}
