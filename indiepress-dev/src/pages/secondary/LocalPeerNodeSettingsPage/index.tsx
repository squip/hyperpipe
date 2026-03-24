import LocalPeerNodeSettingsContent from '@/components/Settings/LocalPeerNodeSettingsContent'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { forwardRef } from 'react'

const LocalPeerNodeSettingsPage = forwardRef(({ index }: { index?: number }, ref) => {
  return (
    <SecondaryPageLayout ref={ref} index={index} title="Local Peer Node">
      <LocalPeerNodeSettingsContent />
    </SecondaryPageLayout>
  )
})

LocalPeerNodeSettingsPage.displayName = 'LocalPeerNodeSettingsPage'
export default LocalPeerNodeSettingsPage
