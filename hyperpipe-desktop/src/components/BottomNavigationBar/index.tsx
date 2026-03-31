import { cn } from '@/lib/utils'
import { getRendererFeatureFlags } from '@/lib/features'
import BackgroundAudio from '../BackgroundAudio'
import AccountButton from './AccountButton'
import ExploreButton from './ExploreButton'
import HomeButton from './HomeButton'
import ChatButton from './ChatButton'
import NotificationsButton from './NotificationsButton'

export default function BottomNavigationBar() {
  const featureFlags = getRendererFeatureFlags()

  return (
    <div
      className={cn('fixed bottom-0 w-full z-40 bg-background border-t')}
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}
    >
      <BackgroundAudio className="rounded-none border-x-0 border-t-0 border-b bg-background" />
      <div className="w-full flex justify-around items-center [&_svg]:size-4 [&_svg]:shrink-0">
        <HomeButton />
        <ChatButton />
        <NotificationsButton />
        {featureFlags.explore && <ExploreButton />}
        <AccountButton />
      </div>
    </div>
  )
}
