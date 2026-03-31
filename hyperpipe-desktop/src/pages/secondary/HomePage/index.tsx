import Logo from '@/assets/Logo'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { APP_DISPLAY_NAME } from '@/constants'
import { Sparkles } from 'lucide-react'
import { forwardRef } from 'react'

const HomePage = forwardRef(({ index }: { index?: number }, ref) => {
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
            {APP_DISPLAY_NAME} lets you create <strong>Nostr</strong> relays powered by{' '}
            <strong>peer-to-peer</strong> technology instead of traditional hosted servers. It
            integrates relay creation into the client experience, so running your own relay feels
            closer to creating or joining a moderated group than provisioning infrastructure.
          </p>

          <p>
            Nostr made online identity portable and censorship resistant. {APP_DISPLAY_NAME} pushes
            that idea deeper into the stack by making relay ownership permissionless and practical
            too. Create a relay from your own device, keep data local by default, and use
            Nostr&apos;s identity layer to share it with trusted peers in your network.
          </p>

          <p>
            The result is a simpler, more adaptable and personalized relay model: one that works
            for smaller, intentional networks where a relay can be leveraged as a user-owned
            building block for permissionless speech, coordination, and custom apps.
          </p>
        </div>

        <div className="space-y-4 text-base">
          <h2 className="text-2xl font-bold">What You Can Build</h2>
          <p>
            {APP_DISPLAY_NAME} relays come out-of-the-box with p2p database replication, state
            synchronization, and file-sharing capabilities.
          </p>

          <p>
            This native p2p-first model makes it trivial for users to run feature-rich Nostr relays
            at the edge of the network without servers or middlemen, providing a practical solution
            for use cases where we seek more direct control, moderation, and privacy around who we
            talk to, and what we share:
          </p>

          <ul className="list-disc pl-6 space-y-2">
            <li>Personal and family relays</li>
            <li>Private group chat relays</li>
            <li>Community and interest-based relays</li>
            <li>Secure file-sharing spaces</li>
            <li>Ephemeral relays for events, campaigns, trips, and working-groups</li>
            <li>Coordination relays for autonomous agents and mixed human-agent systems</li>
            <li>Purpose-built apps and custom client surfaces wrapped around a relay</li>
          </ul>

          <p>
            Hosting private online spaces should not require permissioned platforms, including the
            infrastructure layer. While most relays still depend on someone else&apos;s server,
            someone else&apos;s rules, and someone else&apos;s uptime, {APP_DISPLAY_NAME} aims to
            offer a new alternative that makes relay ownership as practical and self-sovereign as
            owning your Nostr identity.
          </p>
        </div>
      </div>
    </SecondaryPageLayout>
  )
})
HomePage.displayName = 'HomePage'
export default HomePage
