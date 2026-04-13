import Logo from '@/assets/Logo'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { APP_DISPLAY_NAME } from '@/constants'
import { usePrimaryPage } from '@/PageManager'
import { Sparkles } from 'lucide-react'
import { forwardRef } from 'react'

const HomePage = forwardRef(({ index }: { index?: number }, ref) => {
  const { navigate } = usePrimaryPage()

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      titlebar={
        <div className="flex h-full items-center gap-2 pl-3 text-lg font-semibold">
          <Sparkles />
          <div>Welcome!</div>
        </div>
      }
      hideBackButton
      hideTitlebarBottomBorder
    >
      <div className="px-6 pt-6 pb-8 max-w-3xl mx-auto space-y-6">
        <div className="flex justify-center">
          <div className="w-full max-w-xl">
            <Logo variant="hero" className="max-w-full" />
          </div>
        </div>

        <div className="space-y-4 text-base">
          <h2 className="text-2xl font-bold">About {APP_DISPLAY_NAME}</h2>
          <p>
            {APP_DISPLAY_NAME} is a decentralized communication platform that lets you create and
            share <strong>Nostr</strong> relays from your own device, using a{' '}
            <strong>distributed, peer-to-peer database and file-sharing architecture</strong>{' '}
            instead of hosted servers.
          </p>

          <p>
            Unlike the operational overhead and friction that comes with running traditional hosted
            relays, {APP_DISPLAY_NAME} embeds the relay creation and discovery process directly into
            the nostr client itself, transforming the user experience of running your own relay
            from an administrative burden, into a social activity that feels as simple as creating
            or joining an{' '}
            <button
              type="button"
              className="inline cursor-pointer text-primary hover:underline"
              onClick={() => navigate('groups')}
            >
              online moderated group
            </button>
            .
          </p>

          <p>
            No server setup, cloud provisioning, or relay administration required. {APP_DISPLAY_NAME}{' '}
            relays come with built-in authentication, peer-to-peer replication, shared state
            synchronization, multi-writer collaboration, and distributed file sharing out of the
            box. All data is stored locally by default, while {APP_DISPLAY_NAME}&apos;s native
            integration with your nostr follow-graph makes it easy to selectively share your relays
            with trusted peers in your network.
          </p>

          <p>
            The result is a more personal, adaptable relay model: one designed for smaller,
            ad-hoc communication networks where each relay is deployed at the edge of the network
            and hosted only on the devices of the people who actually use it.
          </p>
        </div>

        <div className="space-y-4 text-base">
          <h2 className="text-2xl font-bold">What You Can Build</h2>
          <p>
            This p2p-first architecture makes self-run Nostr relays practical for use cases where
            people want more direct control, moderation, privacy, and clarity around who they
            communicate with and what they share, for example:
          </p>

          <ul className="list-disc pl-6 space-y-2">
            <li>Personal and family relays</li>
            <li>Private group chat relays</li>
            <li>Community and interest-based relays</li>
            <li>Secure file-sharing spaces</li>
            <li>Ephemeral relays for events, campaigns, trips, and working groups</li>
            <li>Coordination relays for autonomous agents and mixed human-agent systems</li>
            <li>Purpose-built apps and custom client surfaces built around a relay</li>
          </ul>

          <p>
            Free speech and private communication should not have to depend on permissioned
            platforms or third-party infrastructure. While the convenience and reliability of
            traditional relays often comes with the tradeoff of placing your data on someone
            else&apos;s server, under someone else&apos;s rules, {APP_DISPLAY_NAME} is designed to
            offer a more self-sovereign alternative that makes owning the infrastructure layer of
            your personal communications stack just as practical as owning your nostr identity.
          </p>
        </div>
      </div>
    </SecondaryPageLayout>
  )
})
HomePage.displayName = 'HomePage'
export default HomePage
