Direct-join is implemented and working as a true peer-to-peer auth handshake, but your current default join workflow is not fully gateway-free end-to-end.

- Direct peer handshake path is explicit in [pear-relay-server.mjs (line 5218)](app://-/index.html?hostId=local#) and [pear-relay-server.mjs (line 5865)](app://-/index.html?hostId=local#) (waitForPeerProtocol + direct POST /post/join/... + direct POST /verify-ownership).
- Host-side handlers for that are in [pear-relay-server.mjs (line 1593)](app://-/index.html?hostId=local#) and [pear-relay-server.mjs (line 1683)](app://-/index.html?hostId=local#).
- Telemetry mode for this path is emitted as direct-join in [pear-relay-server.mjs (line 6010)](app://-/index.html?hostId=local#) and propagated into join telemetry meta in [index.js (line 4788)](app://-/index.html?hostId=local#).

What prevents “entirely peer-to-peer” today:

- UI join startup forces gateway service startup/status refresh in [WorkerBridgeProvider.tsx (line 677)](app://-/index.html?hostId=local#) and [WorkerBridgeProvider.tsx (line 683)](app://-/index.html?hostId=local#).
- Worker pre-join does gateway probing/mirror fetch when host peers are missing in [index.js (line 7275)](app://-/index.html?hostId=local#) and [index.js (line 7421)](app://-/index.html?hostId=local#).
- Even inside startJoinAuthentication, there is a best-effort mirror refresh call before direct auth in [pear-relay-server.mjs (line 5083)](app://-/index.html?hostId=local#).
- Post-join mirror fanout to gateway origins is always run in [index.js (line 2021)](app://-/index.html?hostId=local#).

From your provided matrix run ([matrix-summary.json](app://-/index.html?hostId=local#)):

- [JOIN_WRITABLE_CONFIRMED.meta.mode](app://-/index.html?hostId=local#) is direct-join for S01,S02,S03,S09,S11,S13,S15,S17.
- open-offline for S04.
- blind-peer-offline for S05,S06,S07,S08,S10,S12,S14,S16,S18.
- Raw logs confirm direct peer handshake in S01:
    - [workerB.log (line 1445)](app://-/index.html?hostId=local#)
    - [workerB.log (line 1568)](app://-/index.html?hostId=local#)
    - [workerA.log (line 5267)](app://-/index.html?hostId=local#)
    - [workerA.log (line 5347)](app://-/index.html?hostId=local#)
- But that same S01 flow still does gateway mirror calls first:
    - [workerB.log (line 1322)](app://-/index.html?hostId=local#)
    - [workerB.log (line 1330)](app://-/index.html?hostId=local#)

End-to-end direct-join flow as implemented:

1. Renderer sends start-join-flow, usually after refreshing gateway status ([WorkerBridgeProvider.tsx](app://-/index.html?hostId=local#) refs above).
2. Worker resolves gateway origins, probes gateways, and may fetch mirror metadata ([index.js (line 7275)](app://-/index.html?hostId=local#), [index.js (line 7421)](app://-/index.html?hostId=local#)).
3. Worker calls startJoinAuthentication ([index.js (line 7633)](app://-/index.html?hostId=local#)).
4. Relay server creates join event and tries host peers directly ([pear-relay-server.mjs (line 5191)](app://-/index.html?hostId=local#), [pear-relay-server.mjs (line 5218)](app://-/index.html?hostId=local#)).
5. Host peer handles /post/join/:identifier, returns challenge ([pear-relay-server.mjs (line 1593)](app://-/index.html?hostId=local#)).
6. Joiner sends direct /verify-ownership, receives token/relay info ([pear-relay-server.mjs (line 5865)](app://-/index.html?hostId=local#)).
7. Joiner joins local relay manager, waits writable, emits mode: direct-join ([pear-relay-server.mjs (line 5955)](app://-/index.html?hostId=local#), [pear-relay-server.mjs (line 6006)](app://-/index.html?hostId=local#), [pear-relay-server.mjs (line 6056)](app://-/index.html?hostId=local#)).
8. Worker records telemetry and runs mirror fanout ([index.js (line 4788)](app://-/index.html?hostId=local#), [index.js (line 2021)](app://-/index.html?hostId=local#)).

Note: I did static/runtime-log analysis only; I did not run a new matrix execution in this pass.

6 previous messages

Direct handshake dialing is done over Hyperswarm, but host-peer discovery metadata is mostly gateway-driven.

- Transport/dial:
    
    - Joiner calls waitForPeerProtocol(hostPeerKey) in direct-join flow at [pear-relay-server.mjs (line 5218)](app://-/index.html?hostId=local#).
    - That calls swarm.joinPeer(keyBuffer) to dial the specific peer key at [pear-relay-server.mjs (line 955)](app://-/index.html?hostId=local#).
    - The actual handshake requests are sent directly peer-to-peer: /post/join/:identifier and /verify-ownership at [pear-relay-server.mjs (line 5221)](app://-/index.html?hostId=local#) and [pear-relay-server.mjs (line 5867)](app://-/index.html?hostId=local#).
- Discovery/metadata source for hostPeerKey:
    
    - Renderer pulls hostPeers from gatewayStatus.peerRelayMap and passes them into start-join-flow at [WorkerBridgeProvider.tsx (line 690)](app://-/index.html?hostId=local#) and [WorkerBridgeProvider.tsx (line 721)](app://-/index.html?hostId=local#).
    - Worker also resolves from gateway status via resolveHostPeersFromGatewayStatus() at [index.js (line 311)](app://-/index.html?hostId=local#) and [index.js (line 7595)](app://-/index.html?hostId=local#).
    - If missing, worker fetches mirror metadata from gateway HTTP (/api/relays/:id/mirror) at [index.js (line 7421)](app://-/index.html?hostId=local#) and [index.js (line 3489)](app://-/index.html?hostId=local#).
- Important nuance:
    
    - You are not doing topic-based peer discovery for join targets. The node advertises on topic with client: false at [pear-relay-server.mjs (line 890)](app://-/index.html?hostId=local#), then dials known peer keys via joinPeer.
    - If no host peer metadata exists, direct join cannot start (No hosting peers discovered) at [pear-relay-server.mjs (line 5201)](app://-/index.html?hostId=local#).

So: direct handshake traffic is P2P over Hyperswarm; peer identity metadata is typically obtained from gateway-maintained state (or mirror/invite data), not discovered ad hoc from the swarm topic.

--------


i would like to implement reliable host peer discovery methods that are not gateway-dependent so that we can include support for direct dialing between joining peers and host-peers specifically in the scenario where the public gateway(s) for the group are not reachable, or no public gateways are specified by the admin in the kind 39000 metadata. i still want all the existing public-gateway architecture to continue to work as-is, but would like to ensure that gateway-independent peer discovery, direct-dailing / direct join will also be supported, and used when needed / appropriate.  the ideal solution will provide the best balance / combination of nostr + hyperswarm based discovery methods so that online peers will be able to find each other quickly and efficiently when direct join is used.  please evaluate the most optimal solution design to support this, and provide an implemenation plan proposal when complete.

some potential ideas that ive thought of that may be viable / worth considering in the solution design:
1. leverage hyperswarm's topic-based discovery functionality to find active / online / reachable peers for a given group / relay. 
2. the group / relay-level discovery topic key could be included in the kind 39000 and invite payload for open groups, and just in the invite payload for closed groups.  
3. since the group relay admin / host-peer specifically is the critical peer needed to provide the writerKey during the direct-join workflow, it may be beneficial to also include the admin's hyperswarm peer key in the kind 39000 / invite payload as well, so that joining peers will be able to direct-dial the admin specifically if they are online / reachable, and prevent direct-dialing to non-host peers during the join flow.

if direct-join is used to join the relay, but the group has defined public gateways in the kind 39000 event, the recurring gateway fan-out mirroring and rehydration processes should continue to be used whenever the group's gateways are available, to ensure redundancy and data availability in future situations when peers may go offline. 

we should assess whether there could be an efficiency / performance benefit to maintaining a local cache of known group / relay swarm discovery keys, host peer keys, non-host-peer keys, etc so that the worker doesnt need to rebuild a map of swarm discovery keys / peer keys from scratch with every restart.

------------------


## Gateway-Independent Direct Join Discovery (Nostr + Hyperswarm) — Implementation Plan

### Summary
Implement a dual-path join discovery system that preserves current gateway behavior but supports reliable direct peer discovery/dial when:
1. Public gateways are unreachable, or  
2. No public gateways are configured in group metadata.

Direct join dialing will continue to use Hyperswarm transport (`joinPeer` / protocol requests), while discovery metadata will come from invite + kind `39000` + local persistent cache + topic-based live discovery.

Chosen defaults (confirmed):
- Dial policy: **admin-first, then fallback to other discovered peers**
- Gateway strategy when reachable: **probe then smart-select fastest ready path**
- Cache policy: **persistent TTL cache**

---

### Current-State Constraints (to preserve)
- Existing gateway mirroring/fanout/rehydration remains unchanged when gateways are available.
- Existing join fallback modes (`direct-join`, `blind-peer-offline`, `open-offline`) remain valid.
- Backward compatibility: old invites/metadata without new fields must still work.

---

### Public Interfaces / Type Changes

#### 1) Group metadata tags (`kind 39000`)
Add optional tags (open groups only):
- `['hypertuna-p2p-topic', <64-hex-topic>]`
- `['hypertuna-host-peer', <64-hex-peer-key>, 'admin']` (first/admin preferred; allow multiple tags)

Closed groups:
- Do **not** publish these tags in `39000` (invite-only for privacy).

#### 2) Invite payload fields
Add optional payload fields:
- `discoveryTopic?: string | null`
- `hostPeers?: string[]`
- `adminHostPeer?: string | null`

#### 3) Join-flow payload (`start-join-flow`)
Extend payload with:
- `discoveryTopic?: string | null`
- `hostPeers?: string[]` (already exists; now includes invite/metadata/cache sources)
- `adminHostPeer?: string | null`
- `gatewayMode?: 'auto' | 'disabled'`  
  - `disabled` means “explicitly no gateways configured; skip gateway probe/fetch defaults”

#### 4) Group/UI domain types
Add optional discovery fields to:
- Renderer group metadata/invite types
- TUI group summary/invite/startJoinFlow input types

---

### Implementation Design

## A. Discovery Metadata Plumbing (Renderer + TUI)

### Files
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/lib/hypertuna-group-events.ts`
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/lib/groups.ts`
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/types/groups.ts`
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/GroupsProvider.tsx`
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/WorkerBridgeProvider.tsx`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/lib/hypertuna-group-events.ts`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/lib/groups.ts`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/types.ts`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/parity/groupFilters.ts`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/controller.ts`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/relayService.ts`

### Changes
- Parse/build new `39000` discovery tags in both renderer and TUI libraries.
- Include discovery fields in invite payload build/decode.
- Pass discovery fields into `startJoinFlow`.
- Set `gatewayMode: 'disabled'` when group metadata explicitly has no gateways.
- Keep gateway preflight conditional (do not force-start gateway when `gatewayMode === 'disabled'`).

---

## B. Worker Discovery Cache (persistent, TTL)

### New file
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/relay-discovery-store.mjs`

### Responsibilities
- Persist by group identifier/relay key:
  - `discoveryTopic`
  - `adminHostPeer`
  - ranked known host peers with timestamps/source/success markers
- TTL policy:
  - topic/admin hints: 30 days
  - peer liveness hints: 24 hours
  - successful dial boost retained 30 days
- APIs:
  - `recordDiscoveryHints(...)`
  - `getDiscoveryHints(...)`
  - `recordDialAttempt(...)`
  - `recordDialSuccess(...)`
  - `pruneExpiredHints(...)`

### Worker integration
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`
  - Load/configure store on startup.
  - In `start-join-flow`, merge hints from payload + cache.
  - Add new IPC sync message: `sync-group-discovery-hints`.
  - Persist successful direct-dial peer after `join-auth-success`.

---

## C. Hyperswarm Topic Discovery + Host Announcement

### Files
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/pear-relay-server.mjs`
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`

### Relay server additions
- Add per-relay topic announcement map:
  - Hosted relays announce `hypertuna-p2p-topic` with `swarm.join(topic, { server: true, client: false })`.
- Add discovery query method exported to worker:
  - `discoverPeersByTopic({ topicHex, timeoutMs, maxPeers })`
  - Uses temporary client join and collects peers whose `peerInfo.topics` contains the target topic.
- Expose `getLocalSwarmPublicKey()` (or equivalent) for metadata/invite generation.

### Host announcement policy
- Announce only for hosted/admin relays (`created_at` profile-backed hosted relays).
- Remove announcement on disconnect/shutdown.

---

## D. Join Orchestration (smart-select path)

### File
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`

### Flow updates in `start-join-flow`
1. Build candidate host set from:
   - explicit payload host peers
   - `adminHostPeer`
   - discovery cache
   - topic discovery result
   - existing gateway status map (if gateway mode auto)
2. Rank candidates:
   - admin host key highest
   - recent successful direct peers next
   - topic-discovered peers next
   - gateway-derived peers next
3. Gateway behavior:
   - `gatewayMode=auto`: run short gateway probe + p2p discovery in parallel; choose first viable path.
   - `gatewayMode=disabled`: skip gateway probe/open-join bootstrap/mirror fetch defaults.
4. Dial strategy:
   - Dial admin host first (timeout window), then fallback peers.
5. Keep existing post-join fanout/telemetry behavior intact when gateway origins are available.

---

## E. Metadata/Invite Production from Host

### Files
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/pear-relay-server.mjs`
- `/Users/essorensen/hypertuna-electron/hypertuna-worker/hypertuna-relay-manager-adapter.mjs`
- `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/GroupsProvider.tsx`
- `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/controller.ts`

### Changes
- On relay create (host), ge
### Changes
- On relay create (host), generate/store discovery topic and host peer key in profile/result payload.
- Renderer/TUI include these hints in open-group metadata publish and invite payloads.
- Closed-group invites include hints; `39000` does not.

---

### Telemetry Additions
Add join telemetry events (worker/relay server):
- `JOIN_DISCOVERY_PLAN` (sources used, gatewayMode, topic present)
- `JOIN_DIAL_ATTEMPT` (peer key, rank, source)
- `JOIN_DIAL_SUCCESS`
- `JOIN_DIAL_FAILURE`
- `JOIN_DISCOVERY_RESULT` (selected path: p2p/gateway/fallback)

These feed matrix assertions for true gateway-independent behavior.

---

### Test Plan

## Unit/Parser tests
- Metadata tag parse/build roundtrip (renderer + TUI).
- Invite payload parse/build with new fields.
- Discovery store TTL pruning and ranking.
- Join planner ranking and fallback ordering.

## Worker integration tests
- `gatewayMode=disabled` skips gateway probe/mirror calls.
- Admin-first dialing with fallback.
- Topic discovery returns peers by target topic only.

## Matrix/e2e extensions
Update:
- `/Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/scenarios.mjs`
- `/Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/executor-real.mjs`
- `/Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs`

Add scenarios:
1. Open group, no gateways in metadata, host online -> direct p2p join PASS.
2. Open group, gateways configured but unreachable, host online -> p2p fallback PASS.
3. Open group, gateways reachable + host online -> smart-select PASS + fanout PASS.
4. Closed invite-only, no gateways, host online -> direct discovery/invite path PASS.

Add checks:
- No gateway HTTP dependency in gateway-disabled scenarios.
- Dial order shows admin-first.
- Join mode and writable SLA still pass.

---

### Rollout / Compatibility
1. Ship worker parser + new fields (backward-compatible).
2. Ship renderer/TUI producers/parsers.
3. Ship matrix scenarios + telemetry assertions.
4. Monitor join mode distribution and dial success/failure rates before making p2p path default-preferred.

No migration required; new cache file is additive.

---

### Assumptions and Defaults
- Closed groups keep discovery hints invite-only.
- Admin host key is the preferred initial dial target.
- Gateway fanout/mirroring remains active when gateways are available.
- Persistent discovery cache is enabled with TTLs as specified.




this plan looks good - but there are some additional considerations I'd like to determine how best to factor into our implementation plan before we proceed:

- the smart-select join selection logic should explicitly prioritize the quickest available path to not only join / initialize the autobase, but also to obtain a valid writer key.  
- the writer key can only be provisioned by the host peer, and can be obtained either through the direct-dial path or from the gateway blind-peer writer pool / invite payload. 
- non-host peers cannot provision a writer key, so if a non-host peer is selected in the join path, the relay will not be locally usable until the host peer comes back online, which would provide a poor UX.

the ideal state solution design will provide a way to ensure that regardless of which join path is chosen, a valid writer key can always be obtained, whether via the host-peer, the gateway blind-peer, or a non-host member peer.  

in order to support the ability for a joining peer to obtain a writerkey from a non-host peer, we would need to explore the most optimal approach to allow the host-peer to safely / reliably / efficiently coordinate with the non-host member peers to maintain a distributed writer-pool / writer key store across the non-host peers.  this should work similar to the public gateway blind-peer service, but should be scoped at the group relay level for only group relays the local peer is a member of.  the solution design will ideally not require significant additive resource overhead on the local peer. 

for next steps, we should determine exactly what autobase data / metadata would need to be provisioned and stored on the local non-host-peers.  would all the same information shared on the public-gateway blind-peer service / writer pool / redis cache, etc be needed in this scenario as well? or would most of this be handled automatically by autobase because the autobase instance is running locally on the peer worker (unlike the public gateway instance), therefore only requiring a smaller subset of information be provisioned and stored on the other peers (ie writer key only, etc)?

please help evaluate the most efficient solution design for enabling a distributed writer-key storage (or any other required writer material for this use case) / retrieval service that can be accessed from the non-host peers during the direct-dial join flow.  please verify exactly what information would need to be provisioned and stored on the non-host peers for the joiner to be able to fully join, replicate the autobase core and apply a valid writer key. once your assessment is complete, please provide an updated implementation plan proposal document with this solution design included in the end-to-end scope. 



---------

# Gateway-Independent Direct Join With Writer-Guaranteed Smart Select (Open + Closed, Host-Signed)

## Summary
Implement a writer-aware direct-join system that prefers the fastest **writable** path (not just the fastest connection), keeps existing public-gateway behavior unchanged, and adds a gateway-independent path where non-host peers can supply writer material for closed/invite joins.

This plan uses:
1. Existing open-group non-host provisioning (`local-provision`) where a writable peer can mint/add a writer on demand.
2. New host-signed distributed closed-invite writer leases (`invite-lease`) replicated to member peers.
3. Smart-select ranking that chooses paths guaranteeing writer material first.
4. Topic + cached peer discovery so direct dialing works without gateway availability.

## Exact Writer Material Required (Verified Against Current Code)
For a joiner to become writable reliably, non-host peers only need to provide:
1. `writerSecret` (required).
2. One expected writer key reference: `writerCoreHex` or `autobaseLocal` or `writerCore` (strongly required for deterministic validation and telemetry correctness).
3. `issuedAt` and `expiresAt` (required for safe lease lifecycle).

For fast replication (not writer injection), recommended but separable:
1. `coreRefs` (writer + system/view refs).
2. `fastForward` checkpoint (`key`, `length`, `signedLength`).

Not required on non-host peers for this service:
1. Gateway Redis records, alias maps, operator policy metadata.
2. Full blind-peer metadata payloads duplicated locally for lease serving.

Reasoning from implementation:
1. Writer injection/validation is in `/Users/essorensen/hypertuna-electron/hypertuna-worker/hypertuna-relay-manager-adapter.mjs` (`validateWriterSecret`, `joinRelay` writer keypair injection).
2. Current lease material shape already uses `{ writerCore, writerCoreHex/autobaseLocal, writerSecret, issuedAt, expiresAt }` in `/Users/essorensen/hypertuna-electron/hypertuna-worker/relay-writer-pool-store.mjs`.
3. Core replication acceleration is handled independently via `/Users/essorensen/hypertuna-electron/hypertuna-worker/relay-core-refs-store.mjs` and `syncActiveRelayCoreRefs` in `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`.

## Public API / Interface / Type Changes
1. Add `39000` metadata tags in `/Users/essorensen/hypertuna-electron/indiepress-dev/src/lib/hypertuna-group-events.ts` and parser support in `/Users/essorensen/hypertuna-electron/indiepress-dev/src/lib/groups.ts`:
   - `['swarm-topic', <topicHex>]`
   - `['host-peer', <swarmPeerKeyHex>]`
   - `['writer-issuer', <nostrPubkeyHex>]`
2. Extend invite payload types in `/Users/essorensen/hypertuna-electron/indiepress-dev/src/types/groups.ts`:
   - `discoveryTopic?: string`
   - `hostPeerKeys?: string[]`
   - `memberPeerKeys?: string[]`
   - `writerIssuerPubkey?: string`
   - `writerLease?: WriterLeaseEnvelope | null` (closed/invite flow)
3. Extend `start-join-flow` payload contract in `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/WorkerBridgeProvider.tsx`, `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/controller.ts`, and `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`:
   - `discoveryTopic`
   - `hostPeerKeys`
   - `memberPeerKeys`
   - `writerIssuerPubkey`
4. Add peer RPC endpoints in `/Users/essorensen/hypertuna-electron/hypertuna-worker/pear-relay-server.mjs`:
   - `GET /join-capabilities/:identifier`
   - `POST /relay/:identifier/writer-lease-sync`
   - `POST /relay/:identifier/writer-lease-claim`
5. Add lease envelope type and signature verification utilities in worker:
   - `WriterLeaseEnvelope` fields: `version`, `leaseId`, `relayKey`, `publicIdentifier`, `scope`, `inviteePubkey`, `tokenHash`, `writerCore`, `writerCoreHex`, `autobaseLocal`, `writerSecret`, `issuedAt`, `expiresAt`, `issuerPubkey`, `issuerPeerKey`, `signature`.

## End-to-End Implementation Plan
1. Discovery + cache foundation.
   - Add persistent peer discovery store module (new file) under `/Users/essorensen/hypertuna-electron/hypertuna-worker` using same pattern as core/writer stores.
   - Cache keys by relay key + public identifier; values include topic, host/member peer keys, last seen capability snapshots, TTL.
   - Wire reads/writes from invite parse, metadata parse, successful joins, and capability probes.

2. Smart-select becomes writer-guarantee-first.
   - In `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js` `start-join-flow`, build candidate peers from:
     - invite/39000 hints,
     - discovery topic peers,
     - persisted cache,
     - gateway status (as fallback source only).
   - Probe peers via `GET /join-capabilities/:identifier` with requester context (`pubkey`, `hasInviteToken`, `tokenHash`).
   - Rank by:
     1. writer guarantee (`invite-payload` > `peer-local-provision` > `peer-invite-lease` > `gateway-open-join` > `mirror-only`),
     2. admin-host first tie-breaker,
     3. measured RTT.
   - Keep existing probe+smart-select gateway behavior; gateway paths remain active fallback/supplement.

3. Closed invite lease issuance on host.
   - In `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/GroupsProvider.tsx`, generate invite token **before** writer provisioning.
   - Pass `inviteToken` + `inviteePubkey` with `provision-writer-for-invitee`.
   - In `/Users/essorensen/hypertuna-electron/hypertuna-worker/index.js`, return host-signed `WriterLeaseEnvelope` with writer material and token hash.
   - Include lease in invite payload (existing encrypted DM flow), preserving current `writerSecret` fields for backward compatibility.

4. Lease replication to non-host peers.
   - Host worker pushes lease envelopes to online member peers via `POST /relay/:identifier/writer-lease-sync`.
   - Receiving peers verify signature using `writerIssuerPubkey` (from metadata/invite/profile), reject invalid/expired envelopes, and persist to extended `/Users/essorensen/hypertuna-electron/hypertuna-worker/relay-writer-pool-store.mjs`.
   - Replication factor default: 3 online member peers per lease, host always keeps local copy.

5. Non-host lease claim during closed direct join.
   - In `/Users/essorensen/hypertuna-electron/hypertuna-worker/pear-relay-server.mjs`, keep `/post/join/:identifier` closed behavior (`pending`) unchanged.
   - In join orchestration, when closed and invite token exists and `/post/join` returns `pending`, attempt `POST /relay/:identifier/writer-lease-claim` against ranked peers.
   - Claim response returns writer material if `inviteePubkey` and `tokenHash` match requester context.
   - Joiner then executes existing invite fallback join locally using returned writer material + invite token.

6. Open-group direct join path (no gateway dependency).
   - Keep existing `local-provision` behavior: any writable open-group peer can provision writer in `/verify-ownership`.
   - Expose this via capability endpoint so smart-select can safely choose non-host peers when host is offline.
   - No distributed open writer-secret pool is introduced (avoids lease collision/reuse overhead).

7. Renderer/TUI wiring and metadata propagation.
   - Update `/Users/essorensen/hypertuna-electron/indiepress-dev/src/providers/WorkerBridgeProvider.tsx` and `/Users/essorensen/hypertuna-electron/hypertuna-tui/src/domain/controller.ts` to pass new discovery/issuer hints without requiring gateway preflight.
   - Maintain gateway preflight as optional enhancement, not prerequisite.

8. Observability and fail-fast signals.
   - Add telemetry in worker:
     - `JOIN_PEER_CAPABILITY_PROBE`
     - `JOIN_PATH_SELECTED`
     - `JOIN_WRITER_SOURCE` (`invite-payload`, `peer-local-provision`, `peer-invite-lease`, `gateway-open-join`, `gateway-mirror`)
   - Preserve existing join/autoconnect writable SLO metrics.

## Test Cases and Scenarios
1. Unit tests for lease envelope.
   - Signature verify pass/fail.
   - Expiry handling.
   - Token hash and invitee pubkey matching.
   - Backward compatibility with legacy writer-pool entries.

2. Worker integration tests.
   - Closed group: host offline, member online with replicated lease, joiner gets lease from member and reaches writable.
   - Closed group: wrong token hash, lease claim denied, smart-select fallback path taken.
   - Open group: host offline, non-host writable member online, join succeeds via `peer-local-provision`.
   - Mixed availability: peer path slower/fails, gateway path still succeeds unchanged.

3. Matrix expansion in `/Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway`.
   - Add scenarios where join payload does **not** preseed writer material, so retrieval path is actually tested.
   - Add new scenarios:
     - `S19` open, no gateways configured, host offline, member online.
     - `S20` closed invite, host offline, member lease available.
     - `S21` closed invite, host offline, no lease available (expected fail-fast reason).
     - `S22` gateway down, peers up, smart-select chooses peer path.
   - Add assertions on telemetry `JOIN_PATH_SELECTED` and `JOIN_WRITER_SOURCE`.

## Assumptions and Defaults (Locked)
1. Scope is open + closed.
2. Security model is host-signed lease envelopes for distributed closed invite writer material.
3. Closed-group admission policy remains unchanged: invite token or explicit approval is still required; this plan does not decentralize policy approval.
4. Open-group non-host writer support uses existing on-demand local provisioning on writable peers; no open writer-secret pool replication.
5. At-rest storage follows existing worker trust model (writer secrets already stored locally today); no additional at-rest encryption in this phase.
6. Gateway architecture (fan-out, blind-peer mirroring, rehydration) remains intact and continues whenever gateways are available.
7. Smart-select must prioritize paths that guarantee writer material before pure latency.
