# Hyperpipe Messaging Foundation

This document is a working source for product messaging, not a final polished draft. It is intended to help turn the product architecture into clear, non-technical copy for the website, welcome page, blog posts, onboarding, and other public-facing channels.

It is grounded in the current codebase and favors claims that are already supported by the implemented design:

- local on-device relay creation
- optional public gateway reachability
- direct-join-only mode
- Nostr-native identity and discovery
- open and closed join flows
- offline-tolerant mirror hydration
- trusted peer replication
- local-first file sharing
- plugin-based custom app surfaces

## Positioning Core

### One-line positioning

Hyperpipe makes it easy to run your own Nostr relay from your own device, so anyone can create private, shared, or purpose-built relay networks without managing a hosted server.

### Short thesis

Hyperpipe moves the relay function from the center of the network to the edge. Instead of depending on a hosted relay operated by someone else, users can create and run their own relays locally, share them with trusted peers, and use optional gateway reachability only when it helps.

### Expanded thesis

Nostr made identity and messaging portable. Hyperpipe extends that model by making relay ownership portable too. It turns the relay into something a person, family, group, project, or autonomous system can create on demand, run locally, and shape around a specific purpose. The result is a more practical kind of self-sovereignty: not just the ability to move between relays, but the ability to run your own.

## Messaging Priorities

When choosing what to emphasize, lead with these ideas in roughly this order:

1. Running a relay should feel easy and personal, not like server administration.
2. Your relay belongs to you, and your data stays local by default.
3. Hyperpipe supports private and purpose-specific networks, not only public broadcasting.
4. Trusted peers and optional gateways make self-hosted relays more usable in the real world.
5. Because each relay can be tailored to a purpose, Hyperpipe opens a broader application space than a traditional general-purpose relay.

## Plain-English Vocabulary

Use these translations when explaining the product to non-technical readers.

| Technical idea | Preferred plain-English framing |
| --- | --- |
| relay | a shared message space or coordination space |
| hosted relay | a relay running on someone else’s server |
| p2p replication | trusted devices keeping the relay in sync |
| distributed identity | a portable identity you already control on Nostr |
| censorship resistance | no platform owner can remove you from your own relay |
| gateway | an optional bridge that makes your relay easier to reach remotely |
| open join | anyone approved by the relay’s rules can join easily |
| closed join | invite-only or approval-based access |
| local-first storage | your data lives on your device first |

### Phrases to use

- run a relay from your own device
- create a relay in one click
- private or purpose-built relay networks
- your own relay, your own rules
- local-first and peer-to-peer
- optional remote reach, without giving up ownership
- Nostr-native identity and discovery
- trusted-peer coordination

### Phrases to avoid or use carefully

- serverless
- decentralized everything
- unstoppable
- absolute privacy
- trustless
- replacing Nostr

These either overpromise, sound generic, or blur what the product actually does.

## Core Value Props

### 1. The relay becomes personal infrastructure

Traditional relays are usually public infrastructure or hosted services. Hyperpipe turns the relay into something a user can create and own directly.

Why it matters:

- lowers the barrier to running a relay
- removes dependence on a hosted server for many use cases
- makes relay ownership available to normal users, not only operators

### 2. Relay creation is fast enough to be situational

Because the product is designed around easy local creation, users are not pushed toward one permanent, all-purpose relay.

Why it matters:

- supports relays for a person, family, group, campaign, project, or event
- makes temporary and single-purpose relay patterns realistic
- encourages smaller, more intentional trust boundaries

### 3. Ownership is stronger because the relay is yours

Nostr already lets users move between clients and relays. Hyperpipe pushes that further by making the relay itself user-controlled.

Why it matters:

- users cannot be removed from their own relay by an outside operator
- the primary copy of relay state lives locally
- moderation and access control can be shaped to the relay’s purpose

### 4. Local-first does not mean isolated

Hyperpipe is not just local storage with a Nostr skin. The architecture includes trusted-peer replication, mirror hydration, and optional gateway reachability.

Why it matters:

- the relay can remain useful even when one device is offline
- remote access can be added when helpful
- users keep ownership without giving up convenience

### 5. Nostr identity becomes a coordination layer for private networks

Hyperpipe keeps Nostr-native identity, discovery, and social trust in the loop rather than inventing an entirely separate identity system.

Why it matters:

- users do not need a new identity model to understand or use the product
- relay discovery and routing can stay tied to the Nostr graph
- social trust can inform who hosts, joins, or discovers relay networks

### 6. Hyperpipe is not only a relay product, but an application primitive

The plugin and custom route model suggests a bigger idea: a relay can have its own tailored interface and experience.

Why it matters:

- a relay can power a custom group tool, not just a generic feed
- specialized clients can be built around specific workflows
- this expands Hyperpipe from a communications tool into a coordination platform

## Differentiation Against Traditional Nostr Relays

### Traditional relay model

- usually hosted on a remote server
- often optimized for broad public traffic
- requires setup, cost, maintenance, and operator expertise
- tends toward one-size-fits-all usage
- ownership and moderation are usually operator-centric

### Hyperpipe model

- runs from the user’s own device
- optimized for small, private, trusted, or purpose-specific networks
- removes most server administration from the user path
- supports many relays for many purposes
- makes the user or group the center of control

### Short comparison language

- Traditional relays are infrastructure you connect to. Hyperpipe makes the relay itself something you can spin up and own.
- Traditional relays tend to be permanent destinations. Hyperpipe makes relays disposable, situational, and purpose-built.
- Traditional relays centralize operation. Hyperpipe distributes operation to the edge of the network.

## Homepage Layer

These are working options, not final picks.

### Hero headline options

1. Run your own Nostr relay from your own device.
2. Turn your device into a Nostr relay in one click.
3. Personal relays for private groups, trusted peers, and purpose-built networks.
4. The relay layer, moved to the edge.
5. Create a relay as easily as creating a room.

### Hero subhead options

1. Hyperpipe makes it simple to create local-first Nostr relays for private groups, communities, projects, and custom apps without managing a hosted server.
2. Run private or public relays from your own device, keep data local by default, and add peer-to-peer sync and optional remote reach when you need it.
3. Build permissionless speech and coordination spaces around trusted peers, portable identity, and user-owned relay infrastructure.

### Homepage support bullets

- No hosted server required for the core relay experience.
- Local-first by default, with optional remote reach.
- Designed for private, shared, and purpose-specific networks.
- Uses Nostr identity and discovery instead of a separate account system.
- Supports custom app surfaces on top of relay-specific networks.

### Homepage CTA directions

- Create your first relay
- Run Hyperpipe locally
- Explore use cases
- See how it works

## Concise Product Explainer Layer

### 30-word version

Hyperpipe lets you run a Nostr relay from your own device, making it easy to create private, shared, or purpose-built relay networks without running a hosted server.

### 60-word version

Hyperpipe is a local-first relay client that turns your device into a Nostr relay. Instead of depending on a hosted server, you can create your own relay for a group, project, or personal use case, keep data local by default, sync with trusted peers, and use optional gateway access when remote reach matters.

### 100-word version

Hyperpipe brings the Nostr relay function to the edge of the network. It lets users create and run relays directly from their own device, using Nostr identity for discovery, access, and coordination. That makes it practical to run private relays, family relays, project relays, and other purpose-built networks without the cost and friction of operating a server. Hyperpipe is local-first, but not isolated: trusted-peer replication and optional gateway access help keep relays usable across devices and across distance. The result is a more flexible relay model for permissionless speech, private coordination, and custom applications built around user-owned infrastructure.

### Simple three-step explanation

1. Create a relay on your device.
2. Share it with trusted people or keep it private.
3. Use it as a dedicated space for conversation, coordination, files, or a custom app.

### “How it works” paragraph

Each Hyperpipe relay is created locally and tied into Nostr’s identity and discovery model. You can choose whether a relay is public or private, open or invite-based, and whether it should use optional gateway assistance or stay direct-join-only. Relay state stays local by default, while trusted-peer replication and mirror-based recovery help the relay stay available across devices and in more offline-tolerant conditions.

## Channel Matrix Layer

### Website welcome page

Primary job:

- make the product legible in under 10 seconds

Best angle:

- running your own relay is now easy enough for normal users

Recommended emphasis:

- one-click creation
- user ownership
- local-first design
- examples of concrete relay types

Suggested structure:

1. headline
2. one-sentence explanation
3. 3 to 5 value bullets
4. concrete use-case cards
5. simple “how it works”

### Blog introduction post

Primary job:

- explain why this matters now and why it is different

Best angle:

- Nostr gave users portable identity; Hyperpipe gives them practical relay ownership

Recommended emphasis:

- pain points of hosted relay operation
- why small/private/purpose-built relay patterns are underserved
- why edge-run relays expand the design space
- how gateways and peer sync make the model practical

Suggested structure:

1. the problem with today’s relay assumptions
2. what Hyperpipe changes
3. what becomes possible
4. why this matters for freedom tech and coordination

### App onboarding / first-run welcome

Primary job:

- make the first relay feel intuitive, safe, and concrete

Best angle:

- you can create a private coordination space right now

Recommended emphasis:

- your relay runs on this device
- choose public or private
- choose open or invite-only
- you can create more than one

Suggested structure:

1. “Your device can host relays”
2. “Pick who it is for”
3. “Choose how people join”
4. “Create your first relay”

### Docs / FAQ

Primary job:

- reduce conceptual friction around Nostr, gateways, and local-first operation

Best angle:

- practical explanation over ideological abstraction

Recommended emphasis:

- what is a relay in Hyperpipe terms
- what stays local
- when a gateway is used
- what direct-join-only means
- how private invites and peer sync work at a high level

### Social / announcement threads

Primary job:

- generate curiosity without needing deep technical context

Best angle:

- “run a relay like you create a room”

Recommended emphasis:

- short, concrete examples
- ownership and simplicity
- novel use cases

## Use-Case Matrix

### Ephemeral relays

Job to be done:

- create a temporary coordination space for an event, action, trip, sprint, or campaign

Why Hyperpipe fits:

- low setup friction
- no server provisioning required
- easy to scope to one purpose

### Personal private relays

Job to be done:

- keep a personal space under your own control for notes, coordination, or trusted sharing

Why Hyperpipe fits:

- user-owned
- local-first
- not dependent on a public operator

### Family relays

Job to be done:

- create a private shared space for a small trusted group

Why Hyperpipe fits:

- invite-based access
- smaller trust boundary
- simple enough for non-operators

### Private group chat relays

Job to be done:

- run a dedicated relay for one group conversation or coordination thread

Why Hyperpipe fits:

- relay can be purpose-specific instead of general-purpose
- local-first chat and file sharing fit naturally
- access can stay tightly scoped

### Community or interest relays

Job to be done:

- create a community space with its own identity, rules, and interface

Why Hyperpipe fits:

- public/open options are supported
- gateway reachability can improve access
- custom client surfaces can be built around the relay

### Collaborative project relays

Job to be done:

- create a dedicated network for a team, repo, initiative, or working group

Why Hyperpipe fits:

- the relay can be centered on one project instead of one person
- private coordination and file exchange are first-class needs
- custom plugin surfaces suggest workflow-specific interfaces

### Agentic coordination relays

Job to be done:

- give agents or automation systems a dedicated shared environment for coordination

Why Hyperpipe fits:

- relays are cheap enough to be scoped to one workflow
- identity, membership, and routing are already structured
- purpose-built clients make specialized control surfaces plausible

### Secure file-sharing relays

Job to be done:

- share files inside a smaller trusted network instead of relying on public cloud defaults

Why Hyperpipe fits:

- local-first storage model
- Hyperdrive-backed file flows
- relay-scoped file contexts

## Best Claims To Reuse Across Channels

- Run a relay from your own device.
- Create private or public relay networks without managing a hosted server.
- Keep your data local by default.
- Build relay spaces for specific people, projects, and purposes.
- Use Nostr identity as the social and discovery layer.
- Add optional remote reach without giving up ownership.
- Support real coordination, files, and custom apps, not only generic posting.

## Proof-Oriented Messaging

These are strong product claims that should feel safe because they map closely to the current architecture.

- Hyperpipe supports both public/open and private/invite-based relay models.
- Gateway reachability is optional, not mandatory.
- Direct-join-only is a supported mode.
- Relay metadata, discovery hints, and gateway assignment are Nostr-native.
- The product includes offline-aware join and mirror recovery paths.
- Files and custom plugin surfaces are part of the current solution design.

## Narrative Angles Worth Testing

### Angle 1: Relay ownership for normal users

Best for:

- homepage
- short product intro
- onboarding

Core message:

Hyperpipe makes relay ownership simple enough for ordinary users.

### Angle 2: Private coordination infrastructure

Best for:

- blog post
- community outreach
- freedom tech framing

Core message:

Hyperpipe gives groups a simple way to create their own shared spaces without depending on public infrastructure.

### Angle 3: A new primitive for custom Nostr applications

Best for:

- technical audience
- ecosystem partnerships
- plugin/app positioning

Core message:

Hyperpipe is not only a relay tool. It is a foundation for relay-specific apps, workflows, and coordination surfaces.

## Suggested Next Drafting Order

1. Pick one primary narrative angle for the homepage.
2. Pick one hero headline and one subhead from the options above.
3. Write a 500 to 800 word launch post around the “what changes” narrative.
4. Turn the use-case matrix into card copy for the website.
5. Write a first-run welcome flow that starts with private relay creation, not broad abstraction.

## Open Questions For The Next Draft

- Should the public-facing name be consistently “Hyperpipe” everywhere, or should “Hyperpipe relays” be treated as a sub-brand concept?
- How hard should the public copy lean into “freedom tech” versus “private coordination infrastructure”?
- Should the homepage lead with private/small-group use cases or with the broader “new relay primitive” thesis?
- How much should plugin/custom-app language appear in the first-touch messaging versus later pages?
