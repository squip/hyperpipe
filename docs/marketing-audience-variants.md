# Hyperpipe Audience Variants

This document provides alternate messaging variants for two different audiences:

- a technical Nostr audience
- a broader freedom-tech audience

These are not new core narratives. They are alternate ways of presenting the same product depending on what the reader already understands and what they are most likely to care about.

Use this alongside:

- [marketing-messaging-foundation.md](/Users/essorensen/hypertuna-electron/docs/marketing-messaging-foundation.md)
- [marketing-homepage-draft.md](/Users/essorensen/hypertuna-electron/docs/marketing-homepage-draft.md)
- [marketing-welcome-page-draft.md](/Users/essorensen/hypertuna-electron/docs/marketing-welcome-page-draft.md)
- [marketing-launch-blog-draft.md](/Users/essorensen/hypertuna-electron/docs/marketing-launch-blog-draft.md)

## Audience Split

### Technical Nostr audience

Assume the reader already understands:

- what a relay is
- the basic value of portable identity
- the difference between clients and relays
- why hosted relay dependence matters

Lead with:

- relay ownership
- relay topology and edge-run infrastructure
- Nostr-native identity and discovery
- new design space for specialized relays and clients

Use language like:

- relay
- identity layer
- discovery
- trust graph
- routing
- relay-scoped
- client experiences

Avoid making it sound like:

- a generic privacy app
- a cloud storage app
- an anti-platform slogan without a concrete product

### Broader freedom-tech audience

Assume the reader may not understand:

- relay architecture
- Nostr vocabulary
- why hosted relays are a bottleneck

Lead with:

- ownership
- local-first control
- practical censorship resistance
- private coordination
- easy setup without server administration

Use language like:

- shared space
- coordination network
- your own infrastructure
- private or public
- trusted peers
- no hosted server required

Avoid leading with:

- protocol jargon
- relay internals
- ecosystem-specific references unless explained

## Variant A: Technical Nostr Audience

### Positioning

Hyperpipe brings relay ownership to the edge of the Nostr network by making it practical to create, run, and route relays from a user device instead of a hosted server.

### Homepage hero options

#### Headline options

1. Run Nostr relays from the edge, not the data center.
2. Hyperpipe turns relay ownership into a user-level primitive.
3. Bring the relay layer to the edge of the Nostr network.
4. Purpose-built Nostr relays, run from your own device.

#### Subhead options

1. Create local-first relays with Nostr-native identity, optional gateway reachability, trusted-peer replication, and room for relay-specific client experiences.
2. Hyperpipe makes it practical to run private, shared, or purpose-built relays from your own device instead of depending on a hosted relay operator.
3. Build relay-scoped networks for groups, projects, files, and custom workflows without treating server administration as a prerequisite.

#### Support bullets

- Nostr-native identity and discovery
- Public, private, open, or invite-based relay models
- Optional gateway reachability and direct-join-only mode
- Built for relay-specific workflows, not only generic social feeds

### Homepage section variant

#### Section title

Why this matters for Nostr

#### Body

Nostr made identity portable, but relay ownership still usually stays centralized in practice. Hyperpipe changes that by making the relay itself cheap and easy to create at the user edge. That opens up a different relay topology: smaller, more intentional relays for families, projects, temporary groups, agent coordination, file exchange, or custom applications that do not fit the assumptions of a permanent public relay.

### Welcome page variant

#### Headline

Your device can run relays.

#### Body

Hyperpipe lets you create Nostr relays directly from your device, choose whether they are public or private, and route them with optional gateway assistance only when needed. Start with one relay for one clear purpose, then expand from there.

#### Quick explainer

A Hyperpipe relay is not just another endpoint to publish to. It can be a dedicated network space with its own membership model, discovery hints, routing, files, and custom client surface.

### Launch post variant

#### Title

Hyperpipe and the next step in Nostr relay ownership

#### Subtitle

Portable identity changed the client layer. Hyperpipe pushes sovereignty deeper into the relay layer.

#### Alternate opening

Nostr already solved an important problem: identity is no longer trapped inside the client. But relay ownership still tends to stay centralized in practice, because running a relay usually means operating hosted infrastructure. Hyperpipe is built around a different assumption. It treats relay creation as a user-level action, not an operator-only responsibility, and turns edge-run relays into a practical primitive for private groups, purpose-built workflows, and custom client experiences.

### Best emphasis points

- relay ownership is now cheap enough to be situational
- relay-scoped networks are easier to build
- public relay assumptions are not the right fit for every coordination model
- Hyperpipe extends Nostr instead of replacing it
- specialized clients can emerge around specialized relays

### Best phrases

- edge-run relays
- relay ownership as a primitive
- relay-scoped coordination
- local-first relay infrastructure
- purpose-built relay networks
- relay-specific client surfaces

## Variant B: Broader Freedom-Tech Audience

### Positioning

Hyperpipe makes it easy to run your own communication and coordination space from your own device, so you do not have to depend on a hosted server just to have a space of your own.

### Homepage hero options

#### Headline options

1. Run your own network space from your own device.
2. Create a private or public relay without running a server.
3. Your own relay. Your own rules. Your own device.
4. Build shared spaces without handing control to a platform.

#### Subhead options

1. Hyperpipe makes it easy to create local-first relays for families, groups, projects, communities, and custom workflows without depending on hosted infrastructure.
2. Start a shared space on your own device, keep data local by default, and choose when to make it reachable, private, invite-only, or open.
3. Hyperpipe gives people and groups a practical way to build their own coordination infrastructure around trusted peers instead of defaulting to public platforms.

#### Support bullets

- No hosted server required for the core experience
- Data stays local by default
- Private or public, invite-only or open
- Built for real groups, projects, and coordination

### Homepage section variant

#### Section title

Why this matters

#### Body

Too many communication tools still depend on someone else’s platform, someone else’s server, and someone else’s rules. Hyperpipe gives users a different path. It lets you create a shared space on your own device, keep primary control close to the people who actually use it, and shape that space around a real need instead of around the incentives of a public platform.

### Welcome page variant

#### Headline

This device can host your own shared spaces.

#### Body

With Hyperpipe, you can create a private family space, a project coordination space, a group chat relay, or a temporary network for a specific mission or event. You do not need to start by thinking about infrastructure. Start by thinking about who the space is for and what it is meant to do.

#### Quick explainer

Hyperpipe works best when you create smaller, more intentional spaces instead of trying to force everything into one public network.

### Launch post variant

#### Title

Hyperpipe: practical relay ownership for private coordination and permissionless speech

#### Subtitle

Running your own relay should not require becoming a server operator.

#### Alternate opening

For all the progress in open and censorship-resistant technology, one thing still often stays harder than it should be: having infrastructure of your own. Hyperpipe is built around a simple idea. If people can easily create and run relays from their own devices, then private coordination, group ownership, and more durable forms of speech become practical for many more real-world use cases.

### Best emphasis points

- ordinary users should be able to run their own infrastructure
- private coordination should not require a public platform
- censorship resistance becomes more concrete when the relay belongs to the user
- smaller, trusted networks are often more useful than one giant shared surface
- the product is practical, not only ideological

### Best phrases

- your own shared space
- practical self-sovereignty
- private coordination infrastructure
- local-first ownership
- trusted-peer networks
- no platform owner in the middle

## Same Product, Different Lead

### Technical Nostr lead

Lead with:

- what Hyperpipe changes in the relay model
- why this expands the Nostr design space
- how it fits identity, discovery, and custom clients

### Freedom-tech lead

Lead with:

- what Hyperpipe lets people own
- what dependency it removes
- how it helps groups coordinate on their own terms

## Recommended Usage

### Use the technical Nostr variant when

- writing for Nostr developers
- posting into Nostr-native communities
- speaking to protocol-aware early adopters
- explaining why Hyperpipe is a differentiated contribution to the ecosystem

### Use the broader freedom-tech variant when

- writing homepage copy for new visitors
- introducing the project to non-Nostr communities
- speaking to organizers, communities, or privacy-minded users
- explaining the practical benefit before the protocol context

## Hybrid Option

If you want one voice that can work for both audiences, use the broader freedom-tech lead first, then let the technical Nostr layer appear lower on the page.

Example:

1. Start with ownership, ease, and private coordination.
2. Then explain that Hyperpipe uses Nostr identity and discovery.
3. Then explain that this creates a new kind of relay primitive for the ecosystem.

That keeps the first impression legible while still preserving the deeper technical story.
