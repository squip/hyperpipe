import nodeCrypto from 'node:crypto'

export const PLUGIN_TIERS = ['restricted', 'elevated']
export const PLUGIN_STATUSES = ['discovered', 'installed', 'approved', 'enabled', 'disabled', 'blocked']
export const PLUGIN_PERMISSIONS = [
  'renderer.nav',
  'renderer.route',
  'nostr.read',
  'nostr.publish',
  'p2p.session',
  'media.session',
  'media.record',
  'media.transcode'
]

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function sanitizeManifestId(value) {
  const id = asString(value).toLowerCase()
  return /^[a-z0-9]+([.-][a-z0-9]+)+$/.test(id) ? id : ''
}

function sanitizePermission(permission) {
  const next = asString(permission).toLowerCase()
  if (!PLUGIN_PERMISSIONS.includes(next)) return null
  return next
}

function sanitizeRoutePath(path) {
  const normalized = asString(path)
  if (!normalized.startsWith('/')) return ''
  return normalized.replace(/\/+$/, '') || '/'
}

function sanitizeRoute(entry = {}) {
  return {
    id: asString(entry.id),
    title: asString(entry.title),
    description: asString(entry.description),
    path: sanitizeRoutePath(entry.path),
    iframeSrc: asString(entry.iframeSrc),
    moduleId: asString(entry.moduleId),
    timeoutMs: Number.isFinite(entry.timeoutMs) ? Number(entry.timeoutMs) : undefined
  }
}

function sanitizeNavItem(entry = {}) {
  return {
    id: asString(entry.id),
    title: asString(entry.title),
    description: asString(entry.description),
    icon: asString(entry.icon),
    routePath: sanitizeRoutePath(entry.routePath),
    order: Number.isFinite(entry.order) ? Number(entry.order) : undefined
  }
}

function sanitizeMediaFeature(entry = {}) {
  return {
    id: asString(entry.id),
    name: asString(entry.name),
    description: asString(entry.description),
    maxBitrateKbps: Number.isFinite(entry.maxBitrateKbps) ? Number(entry.maxBitrateKbps) : undefined,
    maxSessions: Number.isFinite(entry.maxSessions) ? Number(entry.maxSessions) : undefined,
    supportsRecording: entry.supportsRecording === true,
    supportsTranscode: entry.supportsTranscode === true
  }
}

export function isValidRoutePathForPlugin(path, pluginId) {
  if (!pluginId || typeof pluginId !== 'string') return false
  const normalizedPath = sanitizeRoutePath(path)
  if (!normalizedPath) return false
  const expectedPrefix = `/plugins/${pluginId}`
  return normalizedPath === expectedPrefix || normalizedPath.startsWith(`${expectedPrefix}/`)
}

export function normalizePluginManifest(input = {}) {
  const id = sanitizeManifestId(input.id)
  const permissions = asArray(input.permissions)
    .map(sanitizePermission)
    .filter(Boolean)

  const contributions = input.contributions && typeof input.contributions === 'object'
    ? input.contributions
    : {}

  return {
    id,
    name: asString(input.name),
    version: asString(input.version),
    engines: {
      hyperpipe: asString(input?.engines?.hyperpipe),
      worker: asString(input?.engines?.worker),
      renderer: asString(input?.engines?.renderer),
      mediaApi: asString(input?.engines?.mediaApi)
    },
    entrypoints: {
      runner: asString(input?.entrypoints?.runner)
    },
    permissions,
    contributions: {
      navItems: asArray(contributions.navItems).map((entry) => sanitizeNavItem(entry)),
      routes: asArray(contributions.routes).map((entry) => sanitizeRoute(entry)),
      mediaFeatures: asArray(contributions.mediaFeatures).map((entry) => sanitizeMediaFeature(entry))
    },
    integrity: {
      bundleSha256: asString(input?.integrity?.bundleSha256).toLowerCase(),
      sourceSha256: asString(input?.integrity?.sourceSha256).toLowerCase()
    },
    source: {
      hyperdriveUrl: asString(input?.source?.hyperdriveUrl),
      path: asString(input?.source?.path)
    },
    marketplace: {
      publisherPubkey: asString(input?.marketplace?.publisherPubkey).toLowerCase(),
      tags: asArray(input?.marketplace?.tags).map((tag) => asString(tag)).filter(Boolean)
    }
  }
}

export function validatePluginManifest(input = {}, { strict = true } = {}) {
  const manifest = normalizePluginManifest(input)
  const errors = []

  if (!manifest.id) errors.push('Manifest id must be reverse-dns style (for example: com.example.plugin)')
  if (!manifest.name) errors.push('Manifest name is required')
  if (!manifest.version) errors.push('Manifest version is required')
  if (!manifest.engines.hyperpipe) errors.push('Manifest engines.hyperpipe is required')
  if (!manifest.engines.worker) errors.push('Manifest engines.worker is required')
  if (!manifest.engines.renderer) errors.push('Manifest engines.renderer is required')
  if (!manifest.engines.mediaApi) errors.push('Manifest engines.mediaApi is required')

  if (strict) {
    if (!manifest.integrity.bundleSha256) errors.push('Manifest integrity.bundleSha256 is required')
    if (!manifest.integrity.sourceSha256) errors.push('Manifest integrity.sourceSha256 is required')
    if (!manifest.source.hyperdriveUrl) errors.push('Manifest source.hyperdriveUrl is required')
    if (!manifest.source.path) errors.push('Manifest source.path is required')
    if (!manifest.marketplace.publisherPubkey) errors.push('Manifest marketplace.publisherPubkey is required')
  }

  if (!PLUGIN_TIERS.includes(input?.tier || 'restricted')) {
    errors.push('Manifest tier must be one of: restricted, elevated')
  }

  const routePaths = new Set()
  for (const route of manifest.contributions.routes) {
    if (!route.id) errors.push('Route contribution id is required')
    if (!route.path) errors.push(`Route "${route.id || '<unknown>'}" path is required`)
    if (route.path && !isValidRoutePathForPlugin(route.path, manifest.id)) {
      errors.push(`Route "${route.path}" must be namespaced under /plugins/${manifest.id}`)
    }
    if (route.path && routePaths.has(route.path)) {
      errors.push(`Duplicate route contribution path: ${route.path}`)
    } else if (route.path) {
      routePaths.add(route.path)
    }
  }

  const navItemIds = new Set()
  for (const navItem of manifest.contributions.navItems) {
    if (!navItem.id) errors.push('Nav item id is required')
    if (!navItem.title) errors.push(`Nav item "${navItem.id || '<unknown>'}" title is required`)
    if (!navItem.routePath) errors.push(`Nav item "${navItem.id || '<unknown>'}" routePath is required`)
    if (navItem.routePath && !isValidRoutePathForPlugin(navItem.routePath, manifest.id)) {
      errors.push(`Nav item route "${navItem.routePath}" must be namespaced under /plugins/${manifest.id}`)
    }
    if (navItem.id && navItemIds.has(navItem.id)) {
      errors.push(`Duplicate nav item id: ${navItem.id}`)
    } else if (navItem.id) {
      navItemIds.add(navItem.id)
    }
  }

  for (const permission of manifest.permissions) {
    if (!PLUGIN_PERMISSIONS.includes(permission)) {
      errors.push(`Unknown permission: ${permission}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest
  }
}

export function getPluginManifestDigest(input = {}) {
  const normalized = normalizePluginManifest(input)
  const serialized = JSON.stringify(normalized)
  return nodeCrypto.createHash('sha256').update(serialized).digest('hex')
}
