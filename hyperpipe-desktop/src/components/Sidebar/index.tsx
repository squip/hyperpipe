import Icon from '@/assets/Icon'
import Logo from '@/assets/Logo'
import { getRendererFeatureFlags } from '@/lib/features'
import { cn } from '@/lib/utils'
import { useSecondaryPage } from '@/PageManager'
import { useNostr } from '@/providers/NostrProvider'
import { usePluginRegistry } from '@/providers/PluginRegistryProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { useUserPreferences } from '@/providers/UserPreferencesProvider'
import { ChevronsLeft, ChevronsRight, Puzzle } from 'lucide-react'
import AccountButton from './AccountButton'
import BookmarkButton from './BookmarkButton'
import RelaysButton from './ExploreButton'
import HomeButton from './HomeButton'
import ChatButton from './ChatButton'
import NotificationsButton from './NotificationButton'
import PostButton from './PostButton'
import ListsButton from './ListsButton'
import GroupsButton from './GroupsButton'
import FilesButton from './FilesButton'
import ReadsButton from './ReadsButton'
import SearchButton from './SearchButton'
import SidebarItem from './SidebarItem'

export default function PrimaryPageSidebar() {
  const { isSmallScreen } = useScreenSize()
  const { sidebarCollapse, updateSidebarCollapse, enableSingleColumnLayout } = useUserPreferences()
  const { pubkey } = useNostr()
  const featureFlags = getRendererFeatureFlags()
  const { push } = useSecondaryPage()
  const { navItems: rawPluginNavItems } = usePluginRegistry()
  const pluginNavItems = featureFlags.plugins ? rawPluginNavItems : []
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : ''

  if (isSmallScreen) return null

  return (
    <div
      className={cn(
        'relative flex flex-col pb-2 pt-3 justify-between h-full shrink-0',
        sidebarCollapse ? 'px-2 w-16' : 'px-3 w-60'
      )}
    >
      <div className="space-y-2">
        {sidebarCollapse ? (
          <div className="px-3 py-1 ml-1 mb-6 w-full">
            <Icon />
          </div>
        ) : (
          <div className="mt-2 mb-6 w-full pr-0">
            <Logo variant="sidebar" className="max-w-[13rem]" />
          </div>
        )}
        <HomeButton collapse={sidebarCollapse} />
        <ChatButton collapse={sidebarCollapse} />
        <NotificationsButton collapse={sidebarCollapse} />
        <ReadsButton collapse={sidebarCollapse} />
        <GroupsButton collapse={sidebarCollapse} />
        <FilesButton collapse={sidebarCollapse} />
        {featureFlags.lists && <ListsButton collapse={sidebarCollapse} />}
        {featureFlags.bookmarks && pubkey && <BookmarkButton collapse={sidebarCollapse} />}
        <SearchButton collapse={sidebarCollapse} />
        {pluginNavItems.map((item) => {
          const active = currentPath === item.routePath || currentPath.startsWith(`${item.routePath}/`)
          const title = item.title || item.pluginName || item.id
          const description = item.description || item.pluginName || item.title
          return (
            <SidebarItem
              key={`${item.pluginId}:${item.id}`}
              title={title}
              description={description}
              onClick={() => push(item.routePath)}
              active={active}
              collapse={sidebarCollapse}
            >
              <Puzzle />
            </SidebarItem>
          )
        })}
        {featureFlags.explore && <RelaysButton collapse={sidebarCollapse} />}
        <PostButton collapse={sidebarCollapse} />
      </div>
      <div className="space-y-4">
        <div className="block">
          <button
            className={cn(
              'absolute right-0 bottom-14 flex flex-col justify-center items-center w-5 h-6 p-0 rounded-l-md text-muted-foreground hover:text-foreground hover:bg-background transition-colors [&_svg]:size-4',
              enableSingleColumnLayout ? '' : 'hover:shadow-md'
            )}
            onClick={(e) => {
              e.stopPropagation()
              updateSidebarCollapse(!sidebarCollapse)
            }}
          >
            {sidebarCollapse ? <ChevronsRight /> : <ChevronsLeft />}
          </button>
        </div>
        <AccountButton collapse={sidebarCollapse} />
      </div>
    </div>
  )
}
