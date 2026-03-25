import { match } from 'path-to-regexp'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { getRendererFeatureFlags } from './lib/features'
import AppearanceSettingsPage from './pages/secondary/AppearanceSettingsPage'
import ArticlePage from './pages/secondary/ArticlePage'
import BookmarkPage from './pages/secondary/BookmarkPage'
import FollowingListPage from './pages/secondary/FollowingListPage'
import GeneralSettingsPage from './pages/secondary/GeneralSettingsPage'
import MuteListPage from './pages/secondary/MuteListPage'
import NoteListPage from './pages/secondary/NoteListPage'
import NotePage from './pages/secondary/NotePage'
import OthersRelaySettingsPage from './pages/secondary/OthersRelaySettingsPage'
import PostSettingsPage from './pages/secondary/PostSettingsPage'
import ProfileEditorPage from './pages/secondary/ProfileEditorPage'
import ProfileListPage from './pages/secondary/ProfileListPage'
import ProfilePage from './pages/secondary/ProfilePage'
import RelayPage from './pages/secondary/RelayPage'
import RelayReviewsPage from './pages/secondary/RelayReviewsPage'
import RelaySettingsPage from './pages/secondary/RelaySettingsPage'
import RizfulPage from './pages/secondary/RizfulPage'
import SearchPage from './pages/secondary/SearchPage'
import SettingsPage from './pages/secondary/SettingsPage'
import PluginManagerPage from './pages/secondary/PluginManagerPage'
import TranslationPage from './pages/secondary/TranslationPage'
import WalletPage from './pages/secondary/WalletPage'
import ChatPage from './pages/secondary/ChatPage'
import ListsIndexPage from './pages/secondary/ListsIndexPage'
import ListPage from './pages/secondary/ListPage'
import ListEditorPage from './pages/secondary/ListEditorPage'
import GroupPage from './pages/secondary/GroupPage'
import NotFoundPage from './pages/secondary/NotFoundPage'
import LocalPeerNodeSettingsPage from './pages/secondary/LocalPeerNodeSettingsPage'

export type RouteDefinition = {
  path: string
  element: ReactElement | null
}

type ResolvedRoute = RouteDefinition & {
  matcher: ReturnType<typeof match>
}

const CORE_ROUTES: RouteDefinition[] = buildCoreRoutes()

function buildCoreRoutes(): RouteDefinition[] {
  const featureFlags = getRendererFeatureFlags()

  return [
    { path: '/notes', element: <NoteListPage /> },
    { path: '/notes/:id', element: <NotePage /> },
    { path: '/articles/:id', element: <ArticlePage /> },
    { path: '/users', element: <ProfileListPage /> },
    { path: '/users/:id', element: <ProfilePage /> },
    { path: '/users/:id/following', element: <FollowingListPage /> },
    { path: '/users/:id/relays', element: <OthersRelaySettingsPage /> },
    { path: '/relays/:url', element: <RelayPage /> },
    { path: '/relays/:url/reviews', element: <RelayReviewsPage /> },
    { path: '/conversations/:id', element: <ChatPage /> },
    { path: '/search', element: <SearchPage /> },
    { path: '/settings', element: <SettingsPage /> },
    { path: '/settings/relays', element: <RelaySettingsPage /> },
    { path: '/settings/local-peer-node', element: <LocalPeerNodeSettingsPage /> },
    { path: '/settings/wallet', element: <WalletPage /> },
    { path: '/settings/posts', element: <PostSettingsPage /> },
    { path: '/settings/general', element: <GeneralSettingsPage /> },
    { path: '/settings/appearance', element: <AppearanceSettingsPage /> },
    { path: '/settings/translation', element: <TranslationPage /> },
    { path: '/settings/plugins', element: <PluginManagerPage /> },
    { path: '/profile-editor', element: <ProfileEditorPage /> },
    { path: '/mutes', element: <MuteListPage /> },
    { path: '/rizful', element: <RizfulPage /> },
    { path: '/bookmarks', element: featureFlags.bookmarks ? <BookmarkPage /> : <NotFoundPage /> },
    { path: '/lists', element: featureFlags.lists ? <ListsIndexPage /> : <NotFoundPage /> },
    { path: '/lists/create', element: featureFlags.lists ? <ListEditorPage /> : <NotFoundPage /> },
    { path: '/lists/:id', element: featureFlags.lists ? <ListPage listId="" /> : <NotFoundPage /> },
    {
      path: '/lists/:id/edit',
      element: featureFlags.lists ? <ListEditorPage listId="" /> : <NotFoundPage />
    },
    { path: '/groups/:id', element: <GroupPage id="" /> }
  ]
}

let pluginRoutes: RouteDefinition[] = []
let cachedRoutes: ResolvedRoute[] | null = null

function buildRouteList(definitions: RouteDefinition[]): ResolvedRoute[] {
  return definitions.map(({ path, element }) => ({
    path,
    element: isValidElement(element) ? element : null,
    matcher: match(path)
  }))
}

export function setPluginRoutes(routes: RouteDefinition[]) {
  pluginRoutes = Array.isArray(routes)
    ? routes
      .filter((route) => route && typeof route.path === 'string')
      .map((route) => ({
        path: route.path.trim(),
        element: isValidElement(route.element) ? route.element : null
      }))
      .filter((route) => route.path.startsWith('/plugins/'))
    : []
  cachedRoutes = null
}

export function getRoutes(): ResolvedRoute[] {
  if (!cachedRoutes) {
    cachedRoutes = buildRouteList([...CORE_ROUTES, ...pluginRoutes])
  }
  return cachedRoutes
}
