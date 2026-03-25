export type RendererFeature = 'explore' | 'lists' | 'bookmarks' | 'plugins'

const FEATURE_DEFAULTS: Record<RendererFeature, boolean> = {
  // Pass-1 defaults: hide Explore, keep Lists + Bookmarks enabled.
  explore: false,
  lists: true,
  bookmarks: true,
  plugins: false
}

const FEATURE_ENV_KEYS: Record<RendererFeature, string> = {
  explore: 'VITE_FEATURE_EXPLORE_ENABLED',
  lists: 'VITE_FEATURE_LISTS_ENABLED',
  bookmarks: 'VITE_FEATURE_BOOKMARKS_ENABLED',
  plugins: 'VITE_FEATURE_PLUGINS_ENABLED'
}

const FEATURE_STORAGE_KEYS: Record<RendererFeature, string> = {
  explore: 'hyperpipe_feature_explore_enabled',
  lists: 'hyperpipe_feature_lists_enabled',
  bookmarks: 'hyperpipe_feature_bookmarks_enabled',
  plugins: 'hyperpipe_feature_plugins_enabled'
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return undefined
}

function readEnvValue(key: string): unknown {
  if (typeof import.meta === 'undefined') return undefined
  return (import.meta.env as Record<string, unknown>)[key]
}

function readLocalStorageValue(key: string): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch (_) {
    return null
  }
}

function resolveFeatureFlag(feature: RendererFeature): boolean {
  const envValue = parseBooleanFlag(readEnvValue(FEATURE_ENV_KEYS[feature]))
  if (envValue !== undefined) return envValue

  const storageValue = parseBooleanFlag(readLocalStorageValue(FEATURE_STORAGE_KEYS[feature]))
  if (storageValue !== undefined) return storageValue

  return FEATURE_DEFAULTS[feature]
}

export function isRendererFeatureEnabled(feature: RendererFeature): boolean {
  return resolveFeatureFlag(feature)
}

export function getRendererFeatureFlags(): Record<RendererFeature, boolean> {
  return {
    explore: resolveFeatureFlag('explore'),
    lists: resolveFeatureFlag('lists'),
    bookmarks: resolveFeatureFlag('bookmarks'),
    plugins: resolveFeatureFlag('plugins')
  }
}

export function useHyperdriveUploads(): boolean {
  // Default to external storage; enable via env or localStorage in future.
  const envFlag = parseBooleanFlag(readEnvValue('VITE_USE_HYPERDRIVE_UPLOADS'))
  if (envFlag !== undefined) return envFlag

  const stored = parseBooleanFlag(readLocalStorageValue('hyperpipe_use_hyperdrive_uploads'))
  if (stored !== undefined) return stored

  return false
}
