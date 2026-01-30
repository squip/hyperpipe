# Closed-Join Instrumentation Checklist (Draft)

Goal: convert the current assessment into a methodical, step-by-step checklist of knowns/unknowns and draft instrumentation snippets (no code changes yet).

---

## 0) Scope and flow map

**End-to-end flow (closed invite)**
1) Invite proof generation (worker) → mirror snapshot fetch/append (gateway) → blind-peer pin/hydrate
2) Invite consumption (renderer) → startJoinFlow (worker) → join auth (relay server)
3) Blind-peer fallback hydration (worker) → relay join (worker) → join success / writable events (renderer)

---

## Issue 1: Closed‑join mirror fetch 404 occurs before append (ordering gap)

### Knowns (evidence)
- Gateway receives mirror metadata request, then returns 404.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3430` (mirror metadata request)
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3432` (closed join mirror metadata unavailable)
- Closed‑join append arrives after the 404 and stores metadata.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3434` → `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3441`
- In `ensureInviteMirrorSnapshot`, append happens only on attempts > 0; attempt 0 is fetch-only.
  - `hypertuna-worker/index.js:3032`–`hypertuna-worker/index.js:3096`

### Unknowns → instrumentation needed
**Unknown A:** Did invite proof generation issue multiple attempts? What exact timing?
- **Method(s):** `hypertuna-worker/index.js` → `ensureInviteMirrorSnapshot` (around `:3032`)
- **Needed telemetry:**
  - `attempt`, `elapsedMs`, `inviteTraceId`
  - `resolvedRelayKey`, `resolvedPublicIdentifier`, `relayIdentifier`
  - `action: fetch|append|wait`, `waitMs`
  - `mirrorResult.status`, `mirrorResult.reason`, HTTP status
- **Why:** Confirms whether append was attempted after 404 and how long between attempts.

**Draft snippet (logging only):**
```js
// ensureInviteMirrorSnapshot attempt loop
const attemptStart = Date.now()
console.info('[CJTRACE] invite mirror attempt', {
  attempt,
  inviteTraceId,
  relayIdentifier,
  resolvedRelayKey: previewValue(resolvedRelayKey, 16),
  resolvedPublicIdentifier,
  elapsedMs: Date.now() - attemptStart,
  action: attempt > 0 ? 'append+fetch' : 'fetch'
})
```

**Unknown B:** Gateway received fetch/append with same trace id?
- **Method(s):** `public-gateway/src/PublicGatewayService.mjs` → `#handleRelayMirrorMetadata` and `#handleClosedJoinAppendCores`
- **Needed telemetry:**
  - Ensure trace id is logged for both fetch and append; include `inviteTraceId` in every log line for request/response
- **Why:** Correlate which append fulfilled which fetch.

**Draft snippet:**
```js
this.logger?.info?.({
  traceId: inviteTraceId || null,
  relayKey: identifier,
  path: 'closed-join/append-cores'
}, '[CJTRACE] closed-join append received')
```

---

## Issue 2: Blind‑peer mirror is metadata‑only (no replication)

### Knowns (evidence)
- Worker proceeds with `metadata-only` readiness when all cores are missing.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:70198`
- `ensureBlindPeerMirrorReady` allows metadata-only if `allowMetadataOnly`.
  - `hypertuna-worker/index.js:1635`
- Blind‑peer diagnostics show `remoteLength: null/0` and `peerCount: 0/1` after pin/mirror.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3442`, `:3452`, `:3511`, `:3525`

### Unknowns → instrumentation needed
**Unknown A:** Are blind‑peer swarm connections present and stable?
- **Method(s):** `public-gateway/src/blind-peer/BlindPeerService.mjs` (swarm status logs)
- **Needed telemetry:**
  - `mirrorKey`, `topic`, `connections`, `peers`, connection churn (connect/disconnect timestamps)
- **Why:** Proves whether there is a connectivity issue vs data issue.

**Draft snippet:**
```js
this.logger?.info?.({
  mirrorKey: this.blindPeeringMirrorKey,
  connCount: this.blindPeer?.swarm?.connections?.size ?? null,
  peerCount: this.blindPeer?.swarm?.peers?.size ?? null,
  topic: this.blindPeer?.swarm?.topic ?? null
}, '[CJTRACE] blind-peer swarm stats')
```

**Unknown B:** Do any cores ever receive data (bytes / length changes)?
- **Method(s):** `public-gateway/src/blind-peer/BlindPeerService.mjs` → `#logCoreDiagnostics`
- **Needed telemetry:**
  - `prevRemoteLength`, `newRemoteLength`, `delta`, `lastDownloadedAt`
- **Why:** Confirms if replication starts and stalls or never starts.

**Draft snippet:**
```js
// inside #logCoreDiagnostics
const delta = diagnostics.remoteLength != null && prevRemoteLength != null
  ? diagnostics.remoteLength - prevRemoteLength
  : null
this.logger?.info?.({ key: keyPreview, remoteLength: diagnostics.remoteLength, delta },
  '[CJTRACE] blind-peer core remote-length delta')
```

**Unknown C:** Worker’s mirror summary with `requirePeers=true` at join time
- **Method(s):** `hypertuna-worker/index.js` → join flow (after invite mirror snapshot)
- **Needed telemetry:**
  - `getRelayMirrorSyncSummary(requirePeers:true)` with per-core state
- **Why:** Shows whether blind‑peer is actually reachable from the joiner.

**Draft snippet:**
```js
const summary = manager.getRelayMirrorSyncSummary({
  relayKey: relayIdentifier,
  publicIdentifier,
  coreRefs,
  corestore: relayCorestore,
  requirePeers: true
})
console.info('[CJTRACE] join-flow mirror readiness probe', {
  relayIdentifier,
  summary: summary ? {
    total: summary.total,
    ready: summary.ready,
    missing: summary.missing,
    notReady: summary.notReady
  } : null
})
```

---

## Issue 3: Join‑flow skips mirror fetch even though mirror is metadata‑only

### Knowns (evidence)
- `shouldFetchMirror=false` in join flow for this invite run.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:131849`
- Join mirror decision ignores hydration status; only uses coreRefs / blindPeer existence.
  - `hypertuna-worker/index.js:5853`–`hypertuna-worker/index.js:5867`

### Unknowns → instrumentation needed
**Unknown:** Is the invite mirror snapshot metadata‑only when join flow runs?
- **Method(s):** `hypertuna-worker/index.js` → `start-join-flow` (near `:5682`)
- **Needed telemetry:**
  - include `mirrorHydration` summary fields if provided in invite payload
- **Why:** Demonstrates whether we should have forced a mirror fetch/rehydrate.

**Draft snippet:**
```js
console.info('[CJTRACE] join flow invite mirror', {
  ...existing,
  mirrorHydration: inviteMirrorSnapshot?.hydration || null
})
```

---

## Issue 4: Closed invite triggers open‑join bootstrap

### Knowns (evidence)
- Open‑join bootstrap starts and responds in closed invite run.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:131747` and `:131814`
- Code path allows bootstrap for `closedInvite && hasInviteProof` when writer material missing.
  - `hypertuna-worker/index.js:5743`–`hypertuna-worker/index.js:5752`

### Unknowns → instrumentation needed
**Unknown A:** Which writer fields were missing at decision time?
- **Method(s):** `hypertuna-worker/index.js` near `:5743`
- **Needed telemetry:**
  - `missingWriterCore`, `missingWriterSecret`, `missingWriterCoreHex`, `missingAutobaseLocal`
- **Why:** Confirms why bootstrap was taken.

**Draft snippet:**
```js
console.info('[CJTRACE] join bootstrap decision', {
  relayIdentifier,
  missing: {
    writerCore: !writerCore,
    writerSecret: !writerSecret,
    writerCoreHex: !writerCoreHex,
    autobaseLocal: !autobaseLocal
  },
  closedInvite,
  hasInviteProof
})
```

**Unknown B:** What is the bootstrap response source (pool vs closed‑join)?
- **Method(s):** `fetchOpenJoinBootstrap` (worker) and gateway endpoint
- **Needed telemetry:**
  - `source` field in response and log it in worker
- **Why:** Clarifies whether closed‑invite path is pulling open‑join data.

**Draft snippet:**
```js
console.log('[Worker] Open join bootstrap response', {
  relayIdentifier,
  source: bootstrapResult?.data?.source || null,
  coreRefsCount: bootstrapResult?.data?.cores?.length ?? 0
})
```

---

## Issue 5: Offline closed‑invite join remains read‑only; writer activation never completes

### Knowns (evidence)
- “Relay isn’t writable yet” + “Relay writer sync deferred (read‑only)” logged.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:134601`, `:135142`
- Writer sync explicitly short‑circuits when relay is read‑only.
  - `hypertuna-worker/index.js:943` and `:1508`
- Writer activation requires `relay.writable === true` or expected writer active.
  - `hypertuna-worker/pear-relay-server.mjs:2588`

### Unknowns → instrumentation needed
**Unknown A:** Relay view state on writer activation timeout (view length, peers, remote length)
- **Method(s):** `hypertuna-worker/pear-relay-server.mjs` → `waitForRelayWriterActivation`
- **Needed telemetry:**
  - Already included in snapshot, but ensure log on timeout includes `inviteTraceId`
- **Why:** Shows whether relay view can see any remote data.

**Draft snippet:**
```js
console.warn('[RelayServer] waitForRelayWriterActivation timeout', {
  ...snap,
  inviteTraceId
})
```

**Unknown B:** Add‑writer protocol close reason
- **Method(s):** add‑writer protocol handler (where logs “Opened add‑writer protocol”)
- **Needed telemetry:**
  - `peerId`, `closeCode`, `closeReason`, `durationMs`
- **Why:** Confirms whether the protocol is being rejected or just timing out.

**Draft snippet:**
```js
protocol.on('close', (err) => {
  console.warn('[CJTRACE] add-writer closed', {
    peer: peerId,
    error: err?.message || null,
    durationMs: Date.now() - openedAt
  })
})
```

---

## Issue 6: Join flow never emits success; UI stuck at “request”

### Knowns (evidence)
- Join flow progress hits `request` with null relayKey/relayUrl/writable.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:134552`
- No `join-auth-success` observed in worker log.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log` (no matches)
- Renderer relies on `join-auth-success` to move to “success.”
  - `indiepress-dev/src/providers/WorkerBridgeProvider.tsx:1184`

### Unknowns → instrumentation needed
**Unknown A:** Is `global.sendMessage` called for join-auth-success and relay-writable?
- **Method(s):** `hypertuna-worker/pear-relay-server.mjs` (success emission block)
- **Needed telemetry:**
  - `sending: true`, `payload`, `inviteTraceId`, and result of `sendMessage` if it returns
- **Why:** Confirms whether success is emitted and with what payload.

**Draft snippet:**
```js
console.log('[CJTRACE] join-auth-success emit', {
  publicIdentifier,
  relayKey: fallbackRelayKey,
  relayUrl: inviteRelayUrl,
  inviteTraceId
})
```

**Unknown B:** Renderer receipt of join-auth-success and relay-writable
- **Method(s):** `indiepress-dev/src/providers/WorkerBridgeProvider.tsx` → message handler
- **Needed telemetry:**
  - Log when these messages are received with key fields
- **Why:** Verifies whether the issue is in worker emission or renderer handling.

---

## Issue 7: Relay key / identifier normalization mismatch in join state

### Knowns (evidence)
- Join flow input has relayKey, but join flow progress logs null relayKey/relayUrl.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:131721` vs `:134552`
- `normalizeRelayKeyHex` requires 64‑char hex; non‑hex becomes null.
  - `hypertuna-worker/index.js:174`

### Unknowns → instrumentation needed
**Unknown:** Are relayKey/relayUrl present in join‑auth progress payloads?
- **Method(s):** `hypertuna-worker/pear-relay-server.mjs` → `join-auth-progress` emission
- **Needed telemetry:**
  - Include relayKey, relayUrl, and hostPeer in progress payload; log on send
- **Why:** Proves whether nulls originate in worker or renderer.

---

## Issue 8: Closed‑join mirror roles are `mirror-core` not `invite-writer`

### Knowns (evidence)
- Closed‑join append role tally is `{mirror-core: 9}` (no invite-writer).
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:3438`
- Open‑join pool uses invite-writer roles.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/public-gateway.log:2951`

### Unknowns → instrumentation needed
**Unknown:** Does role affect blind‑peer replication priority/announce?
- **Method(s):** `public-gateway/src/blind-peer/BlindPeerService.mjs` → `pinMirrorCores`
- **Needed telemetry:**
  - Log role → priority/announce decisions and any special handling
- **Why:** Confirms whether role semantics are part of replication failure.

---

## Issue 9: Host peer resolution yields only blind‑peer

### Knowns (evidence)
- Join flow starts with no host peers, later uses blind‑peer only.
  - `test-logs/CLOSED-JOIN-WORKFLOW/test11/worker.log:131721`, `:134305`
- Gateway-status fallback exists but only runs if blind‑peer doesn’t set host peers.
  - `hypertuna-worker/index.js:6062`

### Unknowns → instrumentation needed
**Unknown:** What was in gateway peerRelayMap for this relay at join time?
- **Method(s):** `hypertuna-worker/index.js` → `resolveHostPeersFromGatewayStatus`
- **Needed telemetry:**
  - Log `peerRelayMap` keys, matched candidate, and resolved peers
- **Why:** Determines if direct host peers were actually available.

---

# Appendix: Draft instrumentation snippets (quick copy/paste)

## Worker (hypertuna-worker/index.js)
- `ensureInviteMirrorSnapshot` (attempt loop): log attempt timings and fetch/append actions.
- `start-join-flow`:
  - log missing writer material before bootstrap
  - add mirror readiness probe (`getRelayMirrorSyncSummary`) before `shouldFetchMirror` decision

## Worker (hypertuna-worker/pear-relay-server.mjs)
- `startJoinAuthentication`: log emission of join-auth progress/success with relayKey/relayUrl
- `waitForRelayWriterActivation`: include inviteTraceId in timeout snapshot

## Public Gateway (public-gateway/src/PublicGatewayService.mjs)
- `#handleRelayMirrorMetadata` and `#handleClosedJoinAppendCores`: ensure traceId is logged for each request/response

## Blind Peer (public-gateway/src/blind-peer/BlindPeerService.mjs)
- swarm connection stats
- per‑core remoteLength changes and replication events

---

## Notes
- All snippets are draft logging only; no behavioral changes.
- Prefer `CJTRACE` tag for correlation with existing logs.
