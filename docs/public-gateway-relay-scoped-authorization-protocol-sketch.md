# Public Gateway Relay-Scoped Authorization Protocol Sketch

## Goal

Preserve the gateway operator's ability to restrict who may host relays on the gateway, while also preserving current-state offline join and blind-peer mirror behavior for members of relays that have already been approved and sponsored onto that gateway.

This design splits trust into two layers:

- `host sponsorship`
  Only gateway-approved pubkeys may assign the gateway to a new relay and register that relay with the gateway.
- `relay-scoped membership`
  Once a relay is sponsored, the gateway may delegate scoped access to members of that relay without requiring every member to satisfy the gateway-wide trust policy.

This document is designed as a delta from the current implementation:

- gateway discovery kind `30078` in [shared/public-gateway/GatewayDiscoveryNostr.mjs](/Users/essorensen/hypertuna-electron/shared/public-gateway/GatewayDiscoveryNostr.mjs)
- group metadata kind `39000` and gateway tags in [indiepress-dev/src/lib/hypertuna-group-events.ts](/Users/essorensen/hypertuna-electron/indiepress-dev/src/lib/hypertuna-group-events.ts)
- closed invite payloads in [indiepress-dev/src/providers/GroupsProvider.tsx](/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/GroupsProvider.tsx)
- open-join auth event kind `22242` in [hypertuna-worker/index.js](/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js) and [public-gateway/src/PublicGatewayService.mjs](/Users/essorensen/hypertuna-electron/public-gateway/src/PublicGatewayService.mjs)

## Core Concepts

### Gateway policy

Each gateway exposes two policy surfaces:

- `hostPolicy`
  Who may sponsor relays on this gateway.
- `memberDelegationMode`
  Whether sponsored relays may delegate gateway access to their members.

Proposed values:

- `hostPolicy`
  - `open`
  - `allowlist`
  - `wot`
  - `allowlist+wot`
- `memberDelegationMode`
  - `none`
  - `closed-members`
  - `all-members`

### Principal types

- `gateway operator`
  Configures gateway policy.
- `relay sponsor`
  Pubkey approved under `hostPolicy`; allowed to register a relay with this gateway.
- `relay admin`
  Pubkey authorized by the relay to manage relay members. Initially this may be the same as sponsor.
- `relay member`
  Pubkey granted scoped gateway access for one relay.
- `member device`
  Optional worker peer identity or blind-peer public key bound to a relay-scoped token.

## Discovery Event Shape

Keep gateway discovery on kind `30078`, but extend the event with policy metadata.

### Kind `30078` gateway announcement

- `kind`
  - `30078`
- required tags
  - `["d", "<gatewayId>"]`
  - `["t", "hypertuna-public-gateway"]`
  - `["gateway-id", "<gatewayId>"]`
  - `["http", "<httpsOrigin>"]`
- existing optional tags
  - `["ws", "<wssOrigin>"]`
  - `["name", "<displayName>"]`
  - `["region", "<region>"]`
  - `["relay-key", "<hyperbeeKey>"]`
  - `["relay-discovery-key", "<discoveryKey>"]`
  - `["relay-replication-topic", "<topic>"]`
- new optional tags
  - `["host-policy", "open|allowlist|wot|allowlist+wot"]`
  - `["member-delegation", "none|closed-members|all-members"]`
  - `["auth-method", "relay-scoped-bearer-v1"]`
  - `["operator-pubkey", "<hexPubkey>"]`
  - `["wot-root-pubkey", "<hexPubkey>"]`
  - `["wot-max-depth", "<n>"]`
  - `["wot-min-followers-depth2", "<n>"]`
  - `["capability", "relay-sponsor"]`
  - `["capability", "relay-member-delegation"]`
  - `["capability", "relay-open-join"]`
  - `["capability", "relay-closed-invite"]`

### Discovery rules

- Restricted gateways should still publish discovery events.
- Clients must not interpret discovery as approval.
- Gateway selection UIs should filter to `authorizedForHosting === true`, not merely `discovered === true`.

## Relay Metadata Event Shape

Continue using group metadata kind `39000` with the existing gateway tags:

- `["hypertuna-gateway-id", "<gatewayId>"]`
- `["hypertuna-gateway-origin", "<httpsOrigin>"]`
- `["hypertuna-direct-join-only", "1"]` when applicable

Optional new tags:

- `["hypertuna-gateway-auth-method", "relay-scoped-bearer-v1"]`
- `["hypertuna-gateway-delegation", "none|closed-members|all-members"]`
- `["hypertuna-gateway-sponsor", "<hexPubkey>"]`

These tags are advisory for UX. The gateway remains source of truth.

## Invite Payload Shape

The current encrypted `9009` invite payload already carries relay and mirror metadata in [GroupsProvider.tsx](/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/GroupsProvider.tsx#L487).

Extend it with a `gatewayAccess` object for restricted gateways:

```json
{
  "relayUrl": "wss://...",
  "relayKey": "<relayKey>",
  "gatewayId": "<gatewayId>",
  "gatewayOrigin": "https://gateway.example",
  "token": "<legacyRelayMembershipToken>",
  "blindPeer": { "...": "..." },
  "cores": [],
  "writerCore": "<writerCore>",
  "writerSecret": "<writerSecret>",
  "gatewayAccess": {
    "version": 1,
    "authMethod": "relay-scoped-bearer-v1",
    "grantId": "<gatewayGrantId>",
    "subjectPubkey": "<inviteePubkey>",
    "relayKey": "<relayKey>",
    "gatewayId": "<gatewayId>",
    "gatewayOrigin": "https://gateway.example",
    "scopes": [
      "relay:bootstrap",
      "relay:mirror-read",
      "relay:mirror-sync",
      "relay:ws-connect"
    ],
    "issuedAt": 1760000000000,
    "expiresAt": null
  }
}
```

Notes:

- Keep the existing relay membership `token` for direct relay auth compatibility.
- `grantId` is not itself a bearer token.
- The encrypted invite remains the transport for the closed-relay gateway grant reference.

## Auth Event Shapes

Continue using kind `22242` for signed auth proofs, but make the purpose explicit and bind device identity when available.

### Common tags

- `["relay", "<gatewayOriginOrWsOrigin>"]`
- `["challenge", "<serverChallenge>"]`
- `["h", "<publicIdentifier>"]`
- `["relay-key", "<relayKey>"]`
- `["gateway-id", "<gatewayId>"]`
- `["peer", "<blindPeeringPublicKey>"]` optional
- `["device", "<clientDeviceId>"]` optional

### Open join claim event

```json
{
  "kind": 22242,
  "pubkey": "<joinerPubkey>",
  "tags": [
    ["relay", "https://gateway.example"],
    ["challenge", "<challenge>"],
    ["purpose", "relay-open-join"],
    ["h", "<publicIdentifier>"],
    ["relay-key", "<relayKey>"],
    ["gateway-id", "<gatewayId>"],
    ["peer", "<blindPeeringPublicKey>"]
  ],
  "content": ""
}
```

### Closed invite claim event

```json
{
  "kind": 22242,
  "pubkey": "<inviteePubkey>",
  "tags": [
    ["relay", "https://gateway.example"],
    ["challenge", "<challenge>"],
    ["purpose", "relay-invite-claim"],
    ["h", "<publicIdentifier>"],
    ["relay-key", "<relayKey>"],
    ["gateway-id", "<gatewayId>"],
    ["grant", "<gatewayGrantId>"],
    ["peer", "<blindPeeringPublicKey>"]
  ],
  "content": ""
}
```

### Sponsor/admin control auth

The sponsor/admin bearer flow can use the existing challenge-and-bearer model already sketched in [hypertuna-worker/gateway/PublicGatewayAuthClient.mjs](/Users/essorensen/hypertuna-electron/hypertuna-worker/gateway/PublicGatewayAuthClient.mjs).

## HTTP API Shape

### Sponsor/admin routes

#### `POST /api/relays`

Extends current registration payload with sponsor identity:

```json
{
  "registration": {
    "relayKey": "<relayKey>",
    "publicIdentifier": "<publicIdentifier>",
    "sponsorPubkey": "<hexPubkey>",
    "membershipMode": "open|closed",
    "memberDelegation": "none|closed-members|all-members",
    "metadata": { "...": "..." }
  },
  "signature": "<legacy-or-migrated-signature>"
}
```

Gateway behavior:

- verify `sponsorPubkey` satisfies `hostPolicy`
- create or update relay sponsorship record
- persist sponsor as tenant of the relay

#### `POST /api/relays/:relayKey/members/authorize`

Called by sponsor/admin during closed invite issuance.

```json
{
  "subjectPubkey": "<inviteePubkey>",
  "role": "member",
  "source": "closed-invite",
  "scopes": [
    "relay:bootstrap",
    "relay:mirror-read",
    "relay:mirror-sync",
    "relay:ws-connect"
  ],
  "grantTtlMs": null,
  "inviteExpiresAt": null
}
```

Response:

```json
{
  "status": "ok",
  "grantId": "<gatewayGrantId>",
  "state": "invited"
}
```

#### `POST /api/relays/:relayKey/members/revoke`

```json
{
  "subjectPubkey": "<memberPubkey>",
  "reason": "removed-by-admin"
}
```

### Member routes

#### `GET /api/relays/:relayKey/access/challenge?purpose=relay-open-join|relay-invite-claim`

Response:

```json
{
  "challenge": "<challenge>",
  "relayKey": "<relayKey>",
  "publicIdentifier": "<publicIdentifier>",
  "gatewayId": "<gatewayId>",
  "expiresAt": 1760000000000
}
```

#### `POST /api/relays/:relayKey/open-join`

Request:

```json
{
  "authEvent": { "...kind 22242..." }
}
```

Response:

```json
{
  "status": "ok",
  "membershipState": "active",
  "accessToken": "<relayScopedBearer>",
  "refreshAfter": 1760000000000,
  "expiresAt": 1760000300000,
  "lease": { "...": "..." },
  "mirror": { "...": "..." }
}
```

#### `POST /api/relays/:relayKey/invites/claim`

Request:

```json
{
  "grantId": "<gatewayGrantId>",
  "authEvent": { "...kind 22242..." }
}
```

Response:

```json
{
  "status": "ok",
  "membershipState": "active",
  "accessToken": "<relayScopedBearer>",
  "refreshAfter": 1760000000000,
  "expiresAt": 1760000300000,
  "mirror": { "...": "..." }
}
```

#### `POST /api/relay-member-tokens/refresh`

Request:

```json
{
  "relayKey": "<relayKey>",
  "token": "<existingRelayScopedBearer>"
}
```

Response:

```json
{
  "status": "ok",
  "accessToken": "<newRelayScopedBearer>",
  "refreshAfter": 1760000000000,
  "expiresAt": 1760000300000
}
```

## Token Scope Model

### Sponsor/admin scopes

- `gateway:relay-register`
  Create or update a sponsored relay on the gateway.
- `gateway:relay-unregister`
  Remove a sponsored relay from the gateway.
- `relay:member-authorize`
  Create relay-scoped grants for members.
- `relay:member-revoke`
  Revoke relay-scoped grants.
- `relay:open-join-pool-update`
  Update open-join writer pool entries.
- `relay:admin`
  Convenience aggregate scope for relay admin operations.

### Member scopes

- `relay:bootstrap`
  Fetch challenge, claim invite grant, receive open-join lease/bootstrap bundle.
- `relay:mirror-read`
  Read mirror metadata and relay mirror payloads for this relay only.
- `relay:mirror-sync`
  Use blind-peer mirror services for this relay only.
- `relay:ws-connect`
  Connect to the gateway relay websocket for this relay only.
- `relay:file-read`
  Optional future file reads through the gateway for this relay only.

### Token payload shape

Replace the current per-relay global token payload with a subject-bound relay token:

```json
{
  "version": 1,
  "tokenType": "relay-member-access",
  "relayKey": "<relayKey>",
  "gatewayId": "<gatewayId>",
  "subjectPubkey": "<memberPubkey>",
  "subjectRole": "member",
  "sponsorPubkey": "<sponsorPubkey>",
  "scopes": [
    "relay:bootstrap",
    "relay:mirror-read",
    "relay:mirror-sync",
    "relay:ws-connect"
  ],
  "memberGrantId": "<gatewayGrantId>",
  "devicePeerKey": "<blindPeeringPublicKey-or-null>",
  "sequence": 4,
  "issuedAt": 1760000000000,
  "expiresAt": 1760000300000,
  "refreshAfter": 1760000200000
}
```

Validation rules:

- token must match `relayKey`
- token subject must match the signed join claim pubkey or bound member pubkey
- if `devicePeerKey` is present, blind-peer actions must come from that device key
- token refresh must fail if ACL row is no longer `active`

## ACL Tables

These can be backed by Redis or the existing registration store abstractions.

### `gateway_host_approvals`

Tracks operator-trusted sponsors.

| field | type | notes |
| --- | --- | --- |
| `gatewayId` | string | gateway identifier |
| `subjectPubkey` | string | sponsor pubkey |
| `state` | enum | `active`, `revoked` |
| `source` | enum | `allowlist`, `wot`, `allowlist+wot`, `manual` |
| `policySnapshot` | json | decision context used at approval time |
| `approvedAt` | number | ms timestamp |
| `revokedAt` | number nullable | ms timestamp |

### `relay_sponsorships`

Tracks which sponsor attached a relay to the gateway.

| field | type | notes |
| --- | --- | --- |
| `relayKey` | string | canonical relay key |
| `publicIdentifier` | string | group identifier |
| `gatewayId` | string | assigned gateway |
| `sponsorPubkey` | string | sponsoring subject |
| `membershipMode` | enum | `open`, `closed` |
| `memberDelegation` | enum | `none`, `closed-members`, `all-members` |
| `state` | enum | `active`, `suspended`, `revoked`, `deleted` |
| `createdAt` | number | ms timestamp |
| `updatedAt` | number | ms timestamp |

### `relay_member_acl`

Tracks relay-scoped membership grants.

| field | type | notes |
| --- | --- | --- |
| `relayKey` | string | canonical relay key |
| `subjectPubkey` | string | member pubkey |
| `grantId` | string | stable relay-scoped grant identifier |
| `role` | enum | `member` |
| `source` | enum | `open-join`, `closed-invite`, `admin-manual` |
| `state` | enum | `invited`, `active`, `revoked`, `expired` |
| `scopes` | json array | allowed relay-scoped capabilities |
| `inviteTokenHash` | string nullable | optional closed-invite linkage |
| `boundDevicePeerKeys` | json array | optional worker/blind-peer bindings |
| `issuedByPubkey` | string | sponsor/admin actor |
| `createdAt` | number | ms timestamp |
| `activatedAt` | number nullable | set on claim/open join success |
| `revokedAt` | number nullable | set on removal |
| `expiresAt` | number nullable | optional expiry |

### `relay_member_token_state`

Replaces the current token metadata model that is keyed only by relay.

| field | type | notes |
| --- | --- | --- |
| `relayKey` | string | canonical relay key |
| `subjectPubkey` | string | member pubkey |
| `tokenType` | string | `relay-member-access` |
| `sequence` | number | monotonic issue counter |
| `currentTokenHash` | string nullable | latest token hash |
| `refreshAfter` | number nullable | ms timestamp |
| `expiresAt` | number nullable | ms timestamp |
| `lastValidatedAt` | number nullable | ms timestamp |
| `revokedAt` | number nullable | ms timestamp |

## State Transitions

### Open join

#### Preconditions

- relay sponsorship exists and `state=active`
- relay `membershipMode=open`
- relay `memberDelegation=all-members`
- open-join pool has writer entries

#### State machine

1. `relay_sponsorships.active`
2. joiner requests challenge
3. gateway issues challenge with `purpose=relay-open-join`
4. joiner submits signed kind `22242`
5. gateway verifies:
   - challenge
   - pubkey signature
   - relay tag
   - relay sponsorship still active
   - relay is open
   - delegation mode allows open members
6. gateway allocates open-join writer lease
7. gateway upserts `relay_member_acl`
   - if absent: create `state=active`, `source=open-join`
   - if existing `revoked`: reject
   - if existing `active`: refresh metadata and continue
8. gateway issues relay-scoped access token
9. gateway returns `{ lease, mirror, accessToken }`
10. worker uses token for mirror/bootstrap/ws
11. token refresh succeeds while:
   - sponsorship active
   - member ACL active
   - relay still open or existing active members are grandfathered by policy
12. member removal or relay revocation transitions ACL to `revoked`
13. next refresh fails; mirror and websocket access end

### Closed invite

#### Preconditions

- relay sponsorship exists and `state=active`
- relay `membershipMode=closed`
- relay `memberDelegation` is `closed-members` or `all-members`
- sponsor/admin has `relay:member-authorize`

#### State machine

1. sponsor/admin approves invitee
2. gateway `members/authorize` creates `relay_member_acl`
   - `state=invited`
   - `source=closed-invite`
   - `grantId=<id>`
3. client publishes encrypted `9009` invite carrying `gatewayAccess.grantId`
4. invitee decrypts payload
5. invitee requests challenge with `purpose=relay-invite-claim`
6. gateway issues challenge
7. invitee submits signed kind `22242` including `grantId`
8. gateway verifies:
   - challenge
   - pubkey signature
   - `grantId`
   - ACL exists with `state=invited`
   - ACL `subjectPubkey` matches auth event pubkey
   - relay sponsorship still active
9. gateway transitions ACL to `state=active`
10. gateway optionally binds `peer` tag as device key
11. gateway issues relay-scoped access token
12. gateway returns `{ mirror, accessToken }`
13. worker uses token for mirror/bootstrap/ws
14. token refresh succeeds while ACL remains active
15. admin removal transitions ACL to `revoked`

## Blind-Peer Authorization Rules

The current blind-peer trust model is gateway-global. For relay-scoped authorization, blind-peer access must be checked against:

- `relayKey`
- `subjectPubkey`
- optional `devicePeerKey`
- requested scope

Rules:

- a member token may only operate on mirrors associated with its `relayKey`
- a member token may not create or delete mirrors for unrelated relays
- sponsor/admin tokens may manage relay metadata only for relays they sponsor or administer
- gateway-global host approval must never be inferred from a member token

## Migration Notes

### Current implementation mismatches

- current relay registration is authenticated by a gateway-wide shared secret in [PublicGatewayRegistrar.mjs](/Users/essorensen/hypertuna-electron/hypertuna-worker/gateway/PublicGatewayRegistrar.mjs)
- current gateway token state is per relay, not per subject
- current discovery flow assumes open gateways are the only discoverable gateways
- current blind-peer trust is gateway-global on successful registration

### Recommended migration order

1. Extend discovery events to publish policy metadata for restricted gateways.
2. Add relay sponsorship records and gateway host approval logic.
3. Add relay member ACL storage and member token state storage.
4. Add `members/authorize`, `members/revoke`, and `invites/claim` endpoints.
5. Modify open-join response to issue relay-scoped member tokens.
6. Move blind-peer auth checks from gateway-global trust to relay-scoped token validation.
7. Replace per-relay token metadata with per-subject token metadata.

## Summary

The key design decision is:

- `hostPolicy` controls who may place a relay on the gateway.
- `memberDelegationMode` controls whether that sponsored relay may extend relay-scoped gateway access to its members.

That preserves strict gateway operator control at the sponsorship layer while preserving current offline join and mirror behavior for relay members after sponsorship is established.
