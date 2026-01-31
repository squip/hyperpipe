# Closed-Join Architecture & End-to-End Flow (Hypertuna)

This document maps the **closed-join** flow (invite required) to the codebase and the most relevant logs:
- Worker log: `test-logs/CLOSED-JOIN-WORKFLOW/test12/worker.log`
- Public gateway log: `test-logs/CLOSED-JOIN-WORKFLOW/test12/public-gateway.log`

Note: the `test12` logs show **invite writer provisioning** events but do **not** include a clear closed-join success path (no `join-auth-success` for a closed relay). The mapping below is therefore primarily code-driven, with log pointers where they do exist.

## System Components (with code references)

Renderer (Electron UI):
- **Join action orchestration**: `GroupPage.handleJoin` (`indiepress-dev/src/pages/secondary/GroupPage/index.tsx:736`).
- **Closed vs open determination**: `openJoinAllowed` and `isOpenGroup` gate flags (`indiepress-dev/src/pages/secondary/GroupPage/index.tsx:904`).
- **Join requests**: `GroupsProvider.sendJoinRequest` publishes kind 9021 (`indiepress-dev/src/providers/GroupsProvider.tsx:1113`).
- **Invite ingestion (9009 decrypt + payload parse)**: `GroupsProvider.refreshInvites` (`indiepress-dev/src/providers/GroupsProvider.tsx:464`).
- **Invite build + dispatch**: `GroupsProvider.sendInvites` (`indiepress-dev/src/providers/GroupsProvider.tsx:1149`).
- **Join approval -> invite**: `GroupsProvider.approveJoinRequest` (`indiepress-dev/src/providers/GroupsProvider.tsx:1315`).
- **Mirror metadata fetch for invites**: `fetchInviteMirrorMetadata` (`indiepress-dev/src/providers/GroupsProvider.tsx:333`).
- **Worker join bridge**: `WorkerBridgeProvider.startJoinFlowInternal` (`indiepress-dev/src/providers/WorkerBridgeProvider.tsx:509`).

Worker (local worker process):
- **Join flow orchestrator**: `start-join-flow` handler (`hypertuna-worker/index.js:3900`).
- **Mirror metadata fetch**: `fetchRelayMirrorMetadata` (`hypertuna-worker/index.js:1605`).
- **Auth token persistence**: `update-auth-data` handler (`hypertuna-worker/index.js:4308`).
- **Provision invite writer core**: `provision-writer-for-invitee` handler (`hypertuna-worker/index.js:4208`).

Relay server (host + join auth):
- **Join request endpoint**: `protocol.handle('/post/join/:identifier')` (closed relays return `pending`) (`hypertuna-worker/pear-relay-server.mjs:1246`).
- **Join authentication**: `startJoinAuthentication` (`hypertuna-worker/pear-relay-server.mjs:3340`).
- **Invite-token fallback (offline/closed path)**: inside `startJoinAuthentication` (`hypertuna-worker/pear-relay-server.mjs:3486`).
- **Invite writer provisioning**: `provisionWriterForInvitee` (`hypertuna-worker/pear-relay-server.mjs:4175`).

Gateway / Public gateway:
- **Relay registration + mirror metadata storage**: `#handleRelayRegistration` (`public-gateway/src/PublicGatewayService.mjs:3486`).
- **Mirror metadata endpoint**: `#handleRelayMirrorMetadata` (`public-gateway/src/PublicGatewayService.mjs:3570`).
- **Worker registration driver**: `GatewayService` collects relay cores + registers (`hypertuna-worker/gateway/GatewayService.mjs:1151`, `:1261`).

Relay writer material validation:
- **Writer expectation + secret validation**: `joinRelay` writer material handling (`hypertuna-worker/hypertuna-relay-manager-adapter.mjs:1150`).

## Sequence Diagram (Closed Join: Request -> Invite -> Join)

```mermaid
sequenceDiagram
  autonumber
  actor Joiner
  actor Admin
  participant UI as Renderer (GroupPage)
  participant GP as GroupsProvider
  participant WB as WorkerBridge
  participant W as Worker
  participant RS as RelayServer (host)
  participant PGW as Public Gateway
  participant BP as Blind Peer
  participant NR as Nostr relays

  Note over RS,PGW: Hosted closed relay registers; mirror metadata cached (TTL)
  RS->>PGW: /api/relays register (metadata + relay cores)
  PGW-->>PGW: store mirror payload (mirrorTtlSeconds)

  alt No invite yet (request access)
    Joiner->>UI: Request to join
    UI->>GP: sendJoinRequest (kind 9021)
    GP->>NR: publish 9021

    alt Host peers reachable
      W->>RS: /post/join/:identifier (join request)
      RS->>NR: publish 9021
      RS-->>W: status=pending (closed)
    else Host offline
      Note over Joiner,RS: No peer route; request may not reach relay
    end

    Admin->>GP: approveJoinRequest(...)
    GP->>W: provision-writer-for-invitee
    W->>RS: provisionWriterForInvitee (add writer)
    GP->>PGW: GET /api/relays/:relayKey/mirror
    PGW-->>GP: mirror payload (blindPeer + cores)
    GP->>NR: publish 9000 (member+token) + 9009 invite (encrypted payload)
  else Invite already received
    Joiner->>GP: refreshInvites (decrypt 9009 payload)
  end

  Joiner->>UI: Use invite
  UI->>WB: startJoinFlow (token + writerSecret + mirror info)
  WB->>W: IPC start-join-flow

  W->>PGW: GET /api/relays/:relayKey/mirror (if missing blindPeer/cores)
  PGW-->>W: mirror payload

  alt Host peers reachable
    W->>RS: startJoinAuthentication(hostPeers, token)
    RS-->>W: no challenge (closed) -> fallback
  else Host offline
    W->>BP: ensureRelayMirror + refresh/rehydrate
  end

  W->>RS: invite token fallback (preseed auth, join locally)
  RS-->>W: join-auth-success + relay-writable
```

## Config knobs (public gateway)

From `public-gateway/src/config.mjs`:

- `GATEWAY_REGISTRATION_SECRET` (default: `null`)
- `GATEWAY_REGISTRATION_REDIS` (default: `null`)
- `GATEWAY_REGISTRATION_REDIS_PREFIX` (default: `gateway:registrations:`)
- `GATEWAY_REGISTRATION_TTL` (default: `1800` seconds)
- `GATEWAY_MIRROR_METADATA_TTL` (default: `86400` seconds)
- `GATEWAY_DEFAULT_TOKEN_TTL` (default: `3600` seconds)
- `GATEWAY_TOKEN_REFRESH_WINDOW` (default: `300` seconds)
- `GATEWAY_BLINDPEER_ENABLED` (default: `false`)
- `GATEWAY_BLINDPEER_MAX_BYTES` (default: `25 * 1024 ** 3` bytes)
- `GATEWAY_BLINDPEER_GC_INTERVAL_MS` (default: `300000` ms)
- `GATEWAY_BLINDPEER_STALE_TTL_MS` (default: `7 * 24 * 60 * 60 * 1000` ms)

## End-to-End Flow (Closed Join)

### 0) Create group and hosted relay (closed)
- UI creates hosted relay with `isOpen: false` via worker IPC.
  - Renderer: `GroupsProvider.createHypertunaRelayGroup` calls `createRelay` with `isOpen` (`indiepress-dev/src/providers/GroupsProvider.tsx:1028`).
  - Worker: IPC `create-relay` handler (`hypertuna-worker/index.js:3753`) forwards to `pear-relay-server.createRelay` (`hypertuna-worker/pear-relay-server.mjs:3151`).

### 1) Join request (no invite yet)
Two paths exist:
- **Pure Nostr request**: `sendJoinRequest` publishes kind 9021 to relay/discovery (`indiepress-dev/src/providers/GroupsProvider.tsx:1113`).
- **Worker join request**: `startJoinAuthentication` sends `/post/join/:identifier` to a host peer, which publishes 9021 to the relay (`hypertuna-worker/pear-relay-server.mjs:3340`, `:1246`).
  - For closed relays, the host **returns `pending`** and does **not** issue a challenge (`hypertuna-worker/pear-relay-server.mjs:1297`).

### 2) Admin approval -> invite issuance
- Admin approval path creates a token, publishes `9000` (member+token), provisions writer material (optional), fetches mirror metadata, and publishes encrypted `9009` invite.
  - `GroupsProvider.approveJoinRequest` (`indiepress-dev/src/providers/GroupsProvider.tsx:1315`).
  - Worker provisioning: `provision-writer-for-invitee` (`hypertuna-worker/index.js:4208` -> `hypertuna-worker/pear-relay-server.mjs:4175`).
  - Mirror metadata: `fetchInviteMirrorMetadata` (`indiepress-dev/src/providers/GroupsProvider.tsx:333`).
  - Invite payload fields: `buildInvitePayload` includes token, relayKey, blindPeer, cores, writerSecret (`indiepress-dev/src/providers/GroupsProvider.tsx:169`).

### 3) Invite ingestion (joiner)
- Joiner decrypts `9009` invite and extracts token, relayKey, blind peer, core refs, writer secret/core.
  - `GroupsProvider.refreshInvites` (`indiepress-dev/src/providers/GroupsProvider.tsx:464`).

### 4) Start join flow (joiner -> worker)
- `GroupPage.handleJoin` invokes worker join when invite data exists (`indiepress-dev/src/pages/secondary/GroupPage/index.tsx:736`).
- WorkerBridge packages invite material + host peers (if known) and sends `start-join-flow` (`indiepress-dev/src/providers/WorkerBridgeProvider.tsx:509`).

### 5) Worker join flow (mirror + blind-peer fallback)
- Worker resolves host peers, augments missing mirror data via `fetchRelayMirrorMetadata`, and prehydrates blind-peer mirrors if available.
  - `start-join-flow` (`hypertuna-worker/index.js:3900`).
  - Mirror fetch: `fetchRelayMirrorMetadata` (`hypertuna-worker/index.js:1605`).
  - Blind-peer hydration path inside `start-join-flow` (`hypertuna-worker/index.js:4081`).

### 6) Join authentication (closed path)
- `relayServer.startJoinAuthentication` attempts direct join via host peers. Closed relays return `pending`, so the flow falls back to the **invite token path**.
  - Join auth: `hypertuna-worker/pear-relay-server.mjs:3340`.
  - Invite fallback: `hypertuna-worker/pear-relay-server.mjs:3486`.
- Fallback path pre-seeds auth, joins locally, updates auth token, and emits `join-auth-success`.
  - `preseedJoinMetadata` + `joinRelayManager` usage within the fallback path (`hypertuna-worker/pear-relay-server.mjs:3518`).

### 7) Writer secret validation + writer activation
- Relay adapter validates writer secret against expected writer core and injects writer keypair for Autobase writes.
  - `hypertuna-worker/hypertuna-relay-manager-adapter.mjs:1150`.

### 8) Mirror metadata availability (public gateway)
- Public gateway stores mirror payloads during relay registration and serves them at `/api/relays/:relayKey/mirror`.
  - Store on registration: `public-gateway/src/PublicGatewayService.mjs:3486`.
  - Mirror endpoint: `public-gateway/src/PublicGatewayService.mjs:3570`.

## Log-to-Code Trace (test12 CLOSED-JOIN)

From `test-logs/CLOSED-JOIN-WORKFLOW/test12/worker.log`:
- **Invite writer provisioning** appears multiple times (e.g., `Provisioned writer for invitee` around lines ~2966). This maps to `provisionWriterForInvitee` (`hypertuna-worker/pear-relay-server.mjs:4175`).
- **Join flow entries** in this log are labeled `reason: 'open-join'` (not closed), and no closed join success (`join-auth-success`) is present.

## Gaps / Incomplete Wiring (Observed)

1) **Closed join without invite when host is offline**
   - If `startJoinFlow` is chosen (Electron path), there is no fallback to publish `9021` via discovery when no host peers are found; the join request is only sent via `/post/join` to a host peer. If no peers are reachable, the request never lands. See `GroupPage.handleJoin` (`indiepress-dev/src/pages/secondary/GroupPage/index.tsx:736`) + `startJoinAuthentication` (`hypertuna-worker/pear-relay-server.mjs:3340`).

2) **Invite fallback requires a relay key**
   - The invite-token fallback path fails if the relay key cannot be resolved from `relayKey`, `publicIdentifier` (local-only), or the relay URL path. `getRelayKeyFromPublicIdentifier` only checks local profiles (`hypertuna-worker/relay-lookup-utils.mjs:44`), and the fallback throws if no key is found (`hypertuna-worker/pear-relay-server.mjs:3505`).

3) **Multi-invite writer provisioning is skipped**
   - `sendInvites` only provisions writer material when `invitees.length === 1`, so multi-invite sends omit `writerSecret`/`writerCore` and can yield read-only joins or writer activation failures (`indiepress-dev/src/providers/GroupsProvider.tsx:1173`).

4) **Closed relay mirror metadata may expire when host is offline**
   - `GatewayService` unregisters relays when closed and no peers are connected (`hypertuna-worker/gateway/GatewayService.mjs:1138`), so mirror metadata relies on cached payloads (`GATEWAY_MIRROR_METADATA_TTL`). After TTL, `/mirror` fetches for offline closed relays may fail.

If you want, I can follow up with fixes or add targeted telemetry so the closed-join happy path is visible in logs (e.g., `join-auth-success` for closed relays).
