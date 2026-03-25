import Logo from '@/assets/Logo'
import { Button } from '@/components/ui/button'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { APP_DISPLAY_NAME } from '@/constants'
import { Sparkles } from 'lucide-react'
import { forwardRef } from 'react'

const HomePage = forwardRef(({ index }: { index?: number }, ref) => {
  const handleLearnMore = () => {
    window.open('https://njump.me', '_blank', 'noopener,noreferrer')
  }

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      title={
        <>
          <Sparkles />
          <div>Welcome to {APP_DISPLAY_NAME}</div>
        </>
      }
      hideBackButton
      hideTitlebarBottomBorder
    >
      <div className="px-6 pt-6 pb-8 max-w-3xl mx-auto space-y-6">
        <div className="flex justify-center">
          <div className="w-full max-w-xl">
            <Logo className="max-w-full" />
          </div>
        </div>

        <div className="space-y-4 text-base">
          <h2 className="text-2xl font-bold">About {APP_DISPLAY_NAME}</h2>
          <p>
            {APP_DISPLAY_NAME} is a desktop client for creating, joining, and managing
            peer-to-peer multiwriter <strong>Nostr</strong> relays backed by Hypercore and Autobase.
            It pairs the renderer with a local worker node so each desktop client can act as a
            fully capable peer in the relay network.
          </p>

          <p>
            Desktop peers in this network are intentionally ephemeral. {APP_DISPLAY_NAME}'s public
            gateway bridge preserves relay state, mirrored cores, and file metadata so members can
            reconnect, sync, merge, and keep collaborating even when no other desktop peer is
            currently online.
          </p>
        </div>

        <div className="space-y-4 text-base">
          <h2 className="text-2xl font-bold">Why Nostr still matters here</h2>
          <p>
            <span className="font-semibold text-foreground">Nostr</span> is a simple, open protocol
            for portable identity, relay-based discovery, and interoperable event flows. Hyperpipe
            uses that openness as the control plane for private group relays, relay membership, and
            peer-to-peer coordination.
          </p>

          <p>
            The result is a workflow that combines direct peer replication with a persistent
            availability layer. You keep local ownership of your account and data while still being
            able to rejoin a relay, browse the latest state, and publish new updates without
            waiting for another operator to come online.
          </p>

          <p>
            If you are new to Nostr, the protocol basics are still worth learning. They explain the
            identity model, event format, and relay architecture that Hyperpipe extends for
            multiwriter relays and file distribution.
          </p>
        </div>

        <div className="flex justify-center pt-2">
          <Button size="lg" onClick={handleLearnMore} className="px-8">
            Learn more about Nostr
          </Button>
        </div>
      </div>
    </SecondaryPageLayout>
  )
})
HomePage.displayName = 'HomePage'
export default HomePage
