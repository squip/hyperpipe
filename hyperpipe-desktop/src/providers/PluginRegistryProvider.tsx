import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import PluginPageHost from '@/plugins/PluginPageHost'
import type {
  InstalledPluginDescriptor,
  PluginNavItemContribution,
  PluginRouteContribution,
  PluginUIContributionsResponse
} from '@/plugins/types'
import { setPluginRoutes } from '@/routes'
import { electronIpc } from '@/services/electron-ipc.service'

type PluginRegistryContextValue = {
  loaded: boolean
  loading: boolean
  error: string | null
  plugins: InstalledPluginDescriptor[]
  navItems: PluginNavItemContribution[]
  routes: PluginRouteContribution[]
  refresh: () => Promise<void>
}

const PluginRegistryContext = createContext<PluginRegistryContextValue | undefined>(undefined)

function normalizePluginRoute(route: PluginRouteContribution): PluginRouteContribution | null {
  if (!route || typeof route !== 'object') return null
  const path = typeof route.path === 'string' ? route.path.trim() : ''
  const pluginId = typeof route.pluginId === 'string' ? route.pluginId.trim() : ''
  if (!path || !pluginId) return null
  const expectedPrefix = `/plugins/${pluginId}`
  if (path !== expectedPrefix && !path.startsWith(`${expectedPrefix}/`)) return null
  return {
    ...route,
    path
  }
}

function normalizeNavItem(item: PluginNavItemContribution): PluginNavItemContribution | null {
  if (!item || typeof item !== 'object') return null
  const routePath = typeof item.routePath === 'string' ? item.routePath.trim() : ''
  const pluginId = typeof item.pluginId === 'string' ? item.pluginId.trim() : ''
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id || !title || !routePath || !pluginId) return null
  const expectedPrefix = `/plugins/${pluginId}`
  if (routePath !== expectedPrefix && !routePath.startsWith(`${expectedPrefix}/`)) return null
  return {
    ...item,
    id,
    title,
    routePath
  }
}

export function PluginRegistryProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<InstalledPluginDescriptor[]>([])
  const [navItems, setNavItems] = useState<PluginNavItemContribution[]>([])
  const [routes, setRoutes] = useState<PluginRouteContribution[]>([])

  const refresh = useCallback(async () => {
    if (!electronIpc.isElectron()) {
      setPlugins([])
      setNavItems([])
      setRoutes([])
      setPluginRoutes([])
      setError(null)
      setLoaded(true)
      return
    }

    setLoading(true)
    try {
      const response = (await electronIpc.getPluginUIContributions()) as PluginUIContributionsResponse
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to load plugin UI contributions')
      }

      const normalizedRoutes = (Array.isArray(response.routes) ? response.routes : [])
        .map((route) => normalizePluginRoute(route))
        .filter((route): route is PluginRouteContribution => !!route)
      const normalizedNavItems = (Array.isArray(response.navItems) ? response.navItems : [])
        .map((item) => normalizeNavItem(item))
        .filter((item): item is PluginNavItemContribution => !!item)
        .sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100))
      const normalizedPlugins = Array.isArray(response.plugins) ? response.plugins : []

      setPlugins(normalizedPlugins)
      setNavItems(normalizedNavItems)
      setRoutes(normalizedRoutes)
      setPluginRoutes(
        normalizedRoutes.map((route) => ({
          path: route.path,
          element: <PluginPageHost route={route} />
        }))
      )
      setError(null)
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load plugins')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    refresh().catch((err) => {
      setError((err as Error)?.message || 'Failed to initialize plugin registry')
      setLoaded(true)
      setLoading(false)
    })
  }, [refresh])

  useEffect(() => {
    if (!electronIpc.isElectron()) return
    const off = electronIpc.onPluginEvent(() => {
      refresh().catch(() => {})
    })
    return () => {
      off()
    }
  }, [refresh])

  const value = useMemo<PluginRegistryContextValue>(
    () => ({
      loaded,
      loading,
      error,
      plugins,
      navItems,
      routes,
      refresh
    }),
    [loaded, loading, error, plugins, navItems, routes, refresh]
  )

  return <PluginRegistryContext.Provider value={value}>{children}</PluginRegistryContext.Provider>
}

export function usePluginRegistry() {
  const context = useContext(PluginRegistryContext)
  if (!context) {
    throw new Error('usePluginRegistry must be used within PluginRegistryProvider')
  }
  return context
}
