import MailboxSetting from '@/components/MailboxSetting'
import FavoriteRelaysSetting from '@/components/FavoriteRelaysSetting'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { forwardRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isElectron } from '@/lib/platform'
import DiscoveryRelaysPanel from '@/components/Settings/DiscoveryRelaysPanel'
import LocalPeerNodeSettingsContent from '@/components/Settings/LocalPeerNodeSettingsContent'

const RelaySettingsPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const [tabValue, setTabValue] = useState('favorite-relays')
  const hasDesktop = isElectron()
  const isLegacyLocalPeerNodeRoute = hasDesktop && window.location.hash === '#hypertuna-desktop'

  useEffect(() => {
    switch (window.location.hash) {
      case '#mailbox':
        setTabValue('mailbox')
        break
      case '#discovery-relays':
        if (hasDesktop) setTabValue('discovery-relays')
        break
      case '#favorite-relays':
        setTabValue('favorite-relays')
        break
    }
  }, [hasDesktop])

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      title={isLegacyLocalPeerNodeRoute ? 'Local Peer Node' : t('Relay settings')}
    >
      {isLegacyLocalPeerNodeRoute ? (
        <LocalPeerNodeSettingsContent />
      ) : (
        <Tabs value={tabValue} onValueChange={setTabValue} className="px-4 py-3 space-y-4">
          <TabsList>
            <TabsTrigger value="favorite-relays">{t('Favorite Relays')}</TabsTrigger>
            <TabsTrigger value="mailbox">{t('Read & Write Relays')}</TabsTrigger>
            {hasDesktop && <TabsTrigger value="discovery-relays">Discovery Relays</TabsTrigger>}
          </TabsList>
          <TabsContent value="favorite-relays">
            <FavoriteRelaysSetting />
          </TabsContent>
          <TabsContent value="mailbox">
            <MailboxSetting />
          </TabsContent>
          {hasDesktop && (
            <TabsContent value="discovery-relays">
              <DiscoveryRelaysPanel />
            </TabsContent>
          )}
        </Tabs>
      )}
    </SecondaryPageLayout>
  )
})
RelaySettingsPage.displayName = 'RelaySettingsPage'
export default RelaySettingsPage
