export const homepageSections = {
  about: [
    'Hyperpipe is a decentralized communication platform that lets you create and share Nostr relays from your own device, using a distributed, peer-to-peer database and file-sharing architecture instead of hosted servers.',
    'Unlike the operational overhead and friction that comes with running traditional hosted relays, Hyperpipe embeds the relay creation and discovery process directly into the nostr client itself, transforming the user experience of running your own relay from an administrative burden, into a social activity that feels as simple as creating or joining an online moderated group.',
    "No server setup, cloud provisioning, or relay administration required. Hyperpipe relays come with built-in authentication, peer-to-peer replication, shared state synchronization, multi-writer collaboration, and distributed file sharing out of the box. All data is stored locally by default, while Hyperpipe's native integration with your nostr follow-graph makes it easy to selectively share your relays with trusted peers in your network.",
    'The result is a more personal, adaptable relay model: one designed for smaller, ad-hoc communication networks where each relay is deployed at the edge of the network and hosted only on the devices of the people who actually use it.'
  ],
  whatYouCanBuildIntro:
    'This p2p-first architecture makes self-run Nostr relays practical for use cases where people want more direct control, moderation, privacy, and clarity around who they communicate with and what they share, for example:',
  whatYouCanBuildItems: [
    'Personal and family relays',
    'Private group chat relays',
    'Community and interest-based relays',
    'Secure file-sharing spaces',
    'Ephemeral relays for events, campaigns, trips, and working groups',
    'Coordination relays for autonomous agents and mixed human-agent systems',
    'Purpose-built apps and custom client surfaces built around a relay'
  ],
  whatYouCanBuildOutro:
    "Free speech and private communication should not have to depend on permissioned platforms or third-party infrastructure. While the convenience and reliability of traditional relays often comes with the tradeoff of placing your data on someone else's server, under someone else's rules, Hyperpipe is designed to offer a more self-sovereign alternative that makes owning the infrastructure layer of your personal communications stack just as practical as owning your nostr identity.",
  software: [
    {
      name: 'Hyperpipe Desktop',
      href: '/download/hyperpipe-desktop',
      description:
        'A social Nostr client for creating and connecting with online communities powered by Hyperpipe relays.'
    },
    {
      name: 'Hyperpipe Terminal',
      href: '/download/hyperpipe-tui',
      description:
        'A terminal client for creating, joining, and managing Hyperpipe relays.',
      tips: [
        'Run the terminal client from a hosted VPS or home server to keep your Hyperpipe relays available on the p2p network.',
        'Use Hyperpipe Terminal with your coding agent when building Nostr client applications to provide your app with a custom relay and file-sharing backend.'
      ]
    },
    {
      name: 'Hyperpipe Gateway',
      href: '/download/hyperpipe-gateway',
      description:
        'An optional always-on node that helps trusted peers keep their Hyperpipe relays reachable, discoverable, and synchronized across the network even when other peers go offline. It is designed to forward relay data without seeing its contents, and it can provide secure remote WebSocket access so registered relays can be used in standard Nostr clients.',
      tips: [
        'Run your own Hyperpipe Gateway on a VPS or home server with the built-in Docker deployment and setup wizard.',
        "Configure your gateway's trust policy during setup to decide who can use it, from fully open access to a tightly restricted list of approved peers."
      ]
    }
  ],
  sourceCode: {
    github: 'https://github.com/squip/hyperpipe',
    npmPackages: [
      'npm i @squip/hyperpipe-core',
      'npm i @squip/hyperpipe-bridge',
      'npm i @squip/hyperpipe-core-host'
    ]
  },
  credits:
    'Special thanks to the Holepunch team, who created the p2p primitive libraries used to build hyperpipe-core, and to the creators of Fevela and Jumble, which were forked to create the front-end for Hyperpipe Desktop.'
} as const
