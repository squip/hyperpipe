diff --git a/hypertuna-worker/index.js b/hypertuna-worker/index.js
--- a/hypertuna-worker/index.js
+++ b/hypertuna-worker/index.js
@@
 function resolveHostPeersFromGatewayStatus(status, identifier) {
   if (!status || !identifier) return []
   const peerRelayMap = status?.peerRelayMap
   if (!peerRelayMap || typeof peerRelayMap !== 'object') return []
   const localPeerKeyRaw = status?.ownPeerPublicKey || config?.swarmPublicKey || deriveSwarmPublicKey(config)
   const localPeerKey = typeof localPeerKeyRaw === 'string' ? localPeerKeyRaw.trim().toLowerCase() : null
   const candidates = [identifier]
   if (typeof identifier === 'string' && identifier.includes(':')) {
     candidates.push(identifier.replace(':', '/'))
   }
-  for (const candidate of candidates) {
+  const peerRelayMapKeys = Object.keys(peerRelayMap)
+  const peerRelayMapPreview = peerRelayMapKeys.length > 6
+    ? peerRelayMapKeys.slice(0, 6)
+    : peerRelayMapKeys
+  let resolvedPeers = []
+  let matchedCandidate = null
+  for (const candidate of candidates) {
     if (!candidate) continue
     const entry = peerRelayMap?.[candidate]
     const peers = Array.isArray(entry?.peers) ? entry.peers : []
     if (!peers.length) continue
     const normalized = peers
       .map((key) => String(key || '').trim().toLowerCase())
       .filter(Boolean)
       .filter((key) => !localPeerKey || key !== localPeerKey)
-    if (normalized.length) return normalized
+    if (normalized.length) {
+      resolvedPeers = normalized
+      matchedCandidate = candidate
+      break
+    }
   }
-  return []
+  if (peerRelayMapKeys.length) {
+    console.info(`${CJTRACE_TAG} gateway host peers`, {
+      identifier,
+      candidates,
+      matchedCandidate,
+      localPeerKey: previewValue(localPeerKey, 16),
+      peerRelayMapSize: peerRelayMapKeys.length,
+      peerRelayMapPreview,
+      peersCount: resolvedPeers.length,
+      peersPreview: resolvedPeers.slice(0, 5)
+    })
+  }
+  return resolvedPeers
 }
@@
   let lastMirror = null
   let lastReadiness = null
 
   for (let attempt = 0; attempt <= attempts; attempt += 1) {
+    const attemptStartedAt = Date.now()
+    console.info(`${CJTRACE_TAG} invite mirror attempt`, {
+      relayIdentifier,
+      relayKey: previewValue(resolvedRelayKey || relayIdentifier, 16),
+      publicIdentifier: resolvedPublicIdentifier || publicIdentifier || null,
+      attempt,
+      attempts,
+      closedJoin,
+      hasRelayManager: !!relayManager,
+      hasAppend,
+      action: attempt > 0 ? 'append+fetch' : 'fetch',
+      backoffMs,
+      startedAt: attemptStartedAt,
+      inviteTraceId
+    })
     if (attempt > 0) {
       if (relayManager && hasAppend) {
         try {
@@
     }
 
     await ensurePublicGatewaySettingsLoaded()
-    const mirrorResult = await fetchRelayMirrorMetadata(relayIdentifier, {
+    const fetchStartedAt = Date.now()
+    const mirrorResult = await fetchRelayMirrorMetadata(relayIdentifier, {
       reason: `${reason}-fetch-${attempt}`,
       preferClosedJoin: true,
       traceId: inviteTraceId
     })
+    const fetchElapsedMs = Date.now() - fetchStartedAt
     lastMirror = mirrorResult
     if (mirrorResult?.status !== 'ok' || !mirrorResult.data) {
       console.warn('[Worker] Invite mirror fetch failed', {
         relayIdentifier,
         attempt,
         status: mirrorResult?.status ?? null,
         reason: mirrorResult?.reason ?? null,
-        inviteTraceId
+        origin: mirrorResult?.origin || null,
+        fetchElapsedMs,
+        inviteTraceId
       })
       continue
     }
@@
       hasViewRole: lastReadiness.hasViewRole,
       coreRefsPreview: lastReadiness.coreRefsPreview,
       origin: mirrorResult.origin || null,
+      fetchElapsedMs,
       inviteTraceId
     })
@@
           const bootstrapEligible = openJoinAllowed || (closedInvite && hasInviteProof)
-          const shouldAttemptJoinBootstrap = bootstrapEligible
-            && (!writerCore || !writerSecret || !writerCoreHex || !autobaseLocal)
+          const missingWriterCore = !writerCore
+          const missingWriterSecret = !writerSecret
+          const missingWriterCoreHex = !writerCoreHex
+          const missingAutobaseLocal = !autobaseLocal
+          const shouldAttemptJoinBootstrap = bootstrapEligible
+            && (missingWriterCore || missingWriterSecret || missingWriterCoreHex || missingAutobaseLocal)
+          if (bootstrapEligible) {
+            console.info(`${CJTRACE_TAG} join bootstrap decision`, {
+              publicIdentifier,
+              relayIdentifier: joinRelayKey || publicIdentifier || null,
+              openJoin,
+              closedInvite,
+              hasInviteProof,
+              bootstrapEligible,
+              shouldAttemptJoinBootstrap,
+              missing: {
+                writerCore: missingWriterCore,
+                writerSecret: missingWriterSecret,
+                writerCoreHex: missingWriterCoreHex,
+                autobaseLocal: missingAutobaseLocal
+              },
+              inviteTraceId
+            })
+          }
           if (shouldAttemptJoinBootstrap) {
@@
           console.info(`${CJTRACE_TAG} join flow mirror decision`, {
             publicIdentifier,
             relayIdentifier: joinRelayKey || publicIdentifier || null,
             openJoin,
             closedInvite,
             hostPeersCount: hostPeers.length,
             hostPeersSource,
             hasBlindPeer: !!blindPeer?.publicKey,
             coreRefsCount: coreRefs.length,
             coreRefsSource,
             inviteMirrorSource,
             inviteMirrorIsPool,
             expectedWriterRef: expectedWriterRef ? previewValue(expectedWriterRef, 16) : null,
             expectedWriterMissing,
             closedInviteNeedsMirror,
             mirrorFetchReason,
             shouldFetchMirror
           })
+          if (closedInvite && blindPeeringManager?.started
+            && typeof blindPeeringManager.getRelayMirrorSyncSummary === 'function') {
+            const probeIdentifier = joinRelayKey || publicIdentifier || null
+            if (probeIdentifier) {
+              const mirrorProbe = blindPeeringManager.getRelayMirrorSyncSummary({
+                relayKey: probeIdentifier,
+                publicIdentifier,
+                coreRefs,
+                requirePeers: true
+              })
+              const mirrorStatesPreview = Array.isArray(mirrorProbe?.states)
+                ? mirrorProbe.states.slice(0, 5).map((state) => ({
+                    key: previewValue(state?.key, 16),
+                    peerCount: state?.peerCount ?? null,
+                    remoteLength: state?.remoteLength ?? null,
+                    remoteContiguousLength: state?.remoteContiguousLength ?? null,
+                    ready: state?.ready ?? null
+                  }))
+                : null
+              console.info(`${CJTRACE_TAG} join flow mirror probe`, {
+                publicIdentifier,
+                relayIdentifier: probeIdentifier,
+                total: mirrorProbe?.total ?? null,
+                missing: mirrorProbe?.missing ?? null,
+                notReady: mirrorProbe?.notReady ?? null,
+                ready: mirrorProbe?.ready ?? null,
+                requirePeers: true,
+                statesPreview: mirrorStatesPreview,
+                inviteTraceId
+              })
+            }
+          }
           if (shouldFetchMirror) {



///


diff --git a/hypertuna-worker/pear-relay-server.mjs b/hypertuna-worker/pear-relay-server.mjs
--- a/hypertuna-worker/pear-relay-server.mjs
+++ b/hypertuna-worker/pear-relay-server.mjs
@@
     // Send initial progress message to the desktop UI
     if (global.sendMessage) {
-      global.sendMessage({
-        type: 'join-auth-progress',
-        data: {
-          publicIdentifier,
-          status: 'request',
-          inviteTraceId: inviteTraceId || null
-        }
-      });
+      const progressPayload = {
+        publicIdentifier,
+        status: 'request',
+        inviteTraceId: inviteTraceId || null,
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        openJoin,
+        closedInvite
+      };
+      global.sendMessage({
+        type: 'join-auth-progress',
+        data: progressPayload
+      });
+      console.info('[CJTRACE] join-auth-progress emit', {
+        publicIdentifier,
+        status: 'request',
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        openJoin,
+        closedInvite,
+        inviteTraceId: inviteTraceId || null
+      });
     }
@@
     // Send 'verify' progress update to the desktop UI
     if (global.sendMessage) {
-      global.sendMessage({
-        type: 'join-auth-progress',
-        data: {
-          publicIdentifier,
-          status: 'verify',
-          inviteTraceId: inviteTraceId || null
-        }
-      });
+      const progressPayload = {
+        publicIdentifier,
+        status: 'verify',
+        inviteTraceId: inviteTraceId || null,
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        hostPeer: selectedPeerKey || null
+      };
+      global.sendMessage({
+        type: 'join-auth-progress',
+        data: progressPayload
+      });
+      console.info('[CJTRACE] join-auth-progress emit', {
+        publicIdentifier,
+        status: 'verify',
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        hostPeer: selectedPeerKey || null,
+        inviteTraceId: inviteTraceId || null
+      });
     }
@@
     // Treat verify response as the final result
     if (global.sendMessage) {
-      global.sendMessage({
-        type: 'join-auth-progress',
-        data: {
-          publicIdentifier,
-          status: 'complete',
-          inviteTraceId: inviteTraceId || null
-        }
-      });
+      const progressPayload = {
+        publicIdentifier,
+        status: 'complete',
+        inviteTraceId: inviteTraceId || null,
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        hostPeer: selectedPeerKey || null
+      };
+      global.sendMessage({
+        type: 'join-auth-progress',
+        data: progressPayload
+      });
+      console.info('[CJTRACE] join-auth-progress emit', {
+        publicIdentifier,
+        status: 'complete',
+        relayKey: inviteRelayKey || null,
+        relayUrl: inviteRelayUrl || null,
+        hostPeer: selectedPeerKey || null,
+        inviteTraceId: inviteTraceId || null
+      });
     }
@@
-        let relayWaitResult = await waitForRelayWriterActivation({
+        let relayWaitResult = await waitForRelayWriterActivation({
           relayKey: fallbackRelayKey,
           expectedWriterKey,
           timeoutMs: BLIND_PEER_JOIN_WRITABLE_TIMEOUT_MS,
-          reason: 'blind-peer-fallback'
+          reason: 'blind-peer-fallback',
+          inviteTraceId
         });
@@
-              relayWaitResult = await waitForRelayWriterActivation({
+              relayWaitResult = await waitForRelayWriterActivation({
                 relayKey: fallbackRelayKey,
                 expectedWriterKey,
                 timeoutMs: Math.min(BLIND_PEER_JOIN_WRITABLE_TIMEOUT_MS, 15000),
-                reason: 'blind-peer-retry'
+                reason: 'blind-peer-retry',
+                inviteTraceId
               });
@@
-          scheduleLateWriterRecovery({
+          scheduleLateWriterRecovery({
             relayKey: fallbackRelayKey,
             expectedWriterKey,
             publicIdentifier,
             authToken: inviteToken,
             relayUrl: inviteRelayUrl,
             mode: 'blind-peer-offline',
             requireWritable: true,
-            reason: 'blind-peer-fallback'
+            reason: 'blind-peer-fallback',
+            inviteTraceId
           });
@@
-        if (global.sendMessage) {
-          global.sendMessage({
-            type: 'join-auth-success',
-            data: {
-              publicIdentifier,
-              relayKey: fallbackRelayKey,
-              authToken: inviteToken,
-              relayUrl: inviteRelayUrl || null,
-              hostPeer: blindPeerKey || null,
-              mode: 'blind-peer-offline',
-              provisional: false,
-              inviteTraceId: inviteTraceId || null
-            }
-          });
+        if (global.sendMessage) {
+          const successPayload = {
+            publicIdentifier,
+            relayKey: fallbackRelayKey,
+            authToken: inviteToken,
+            relayUrl: inviteRelayUrl || null,
+            hostPeer: blindPeerKey || null,
+            mode: 'blind-peer-offline',
+            provisional: false,
+            inviteTraceId: inviteTraceId || null
+          };
+          console.info('[CJTRACE] join-auth-success emit', {
+            publicIdentifier,
+            relayKey: fallbackRelayKey,
+            relayUrl: inviteRelayUrl || null,
+            mode: 'blind-peer-offline',
+            inviteTraceId: inviteTraceId || null
+          });
+          global.sendMessage({
+            type: 'join-auth-success',
+            data: successPayload
+          });
         }
         return;
       }
@@
-        const relayWaitResult = await waitForRelayWriterActivation({
+        const relayWaitResult = await waitForRelayWriterActivation({
           relayKey: fallbackRelayKey,
           expectedWriterKey,
           timeoutMs: BLIND_PEER_JOIN_WRITABLE_TIMEOUT_MS,
-          reason: 'open-offline'
+          reason: 'open-offline',
+          inviteTraceId
         });
@@
-          scheduleLateWriterRecovery({
+          scheduleLateWriterRecovery({
             relayKey: fallbackRelayKey,
             expectedWriterKey,
             publicIdentifier,
             authToken: fallbackToken,
             relayUrl: resolvedRelayUrl,
             mode: 'open-offline',
             requireWritable: true,
-            reason: 'open-offline'
+            reason: 'open-offline',
+            inviteTraceId
           });
@@
-        if (global.sendMessage) {
-          global.sendMessage({
-            type: 'join-auth-success',
-            data: {
-              publicIdentifier,
-              relayKey: fallbackRelayKey,
-              authToken: fallbackToken,
-              relayUrl: resolvedRelayUrl || null,
-              hostPeer: blindPeerKey || null,
-              mode: 'open-offline',
-              provisional: !inviteToken,
-              inviteTraceId: inviteTraceId || null
-            }
-          });
+        if (global.sendMessage) {
+          const successPayload = {
+            publicIdentifier,
+            relayKey: fallbackRelayKey,
+            authToken: fallbackToken,
+            relayUrl: resolvedRelayUrl || null,
+            hostPeer: blindPeerKey || null,
+            mode: 'open-offline',
+            provisional: !inviteToken,
+            inviteTraceId: inviteTraceId || null
+          };
+          console.info('[CJTRACE] join-auth-success emit', {
+            publicIdentifier,
+            relayKey: fallbackRelayKey,
+            relayUrl: resolvedRelayUrl || null,
+            mode: 'open-offline',
+            inviteTraceId: inviteTraceId || null
+          });
+          global.sendMessage({
+            type: 'join-auth-success',
+            data: successPayload
+          });
         }
         return;
       }
@@
-    const directWaitResult = await waitForRelayWriterActivation({
+    const directWaitResult = await waitForRelayWriterActivation({
       relayKey,
       expectedWriterKey: finalExpectedWriterKey,
       timeoutMs: DIRECT_JOIN_WRITABLE_TIMEOUT_MS,
-      reason: 'direct-join'
+      reason: 'direct-join',
+      inviteTraceId
     });
@@
-        scheduleLateWriterRecovery({
+        scheduleLateWriterRecovery({
           relayKey,
           expectedWriterKey: finalExpectedWriterKey,
           publicIdentifier: finalIdentifier,
           authToken,
           relayUrl,
           mode: 'direct-join',
           requireWritable: true,
-          reason: 'direct-join'
+          reason: 'direct-join',
+          inviteTraceId
         });
       }
     }
@@
-    if (global.sendMessage) {
-      global.sendMessage({
-        type: 'join-auth-success',
-        data: {
-          publicIdentifier: finalIdentifier,
-          relayKey,
-          authToken,
-          relayUrl,
-          hostPeer: selectedPeerKey,
-          mode: 'direct-join',
-          provisional: false,
-          inviteTraceId: inviteTraceId || null
-        }
-      });
+    if (global.sendMessage) {
+      const successPayload = {
+        publicIdentifier: finalIdentifier,
+        relayKey,
+        authToken,
+        relayUrl,
+        hostPeer: selectedPeerKey,
+        mode: 'direct-join',
+        provisional: false,
+        inviteTraceId: inviteTraceId || null
+      };
+      console.info('[CJTRACE] join-auth-success emit', {
+        publicIdentifier: finalIdentifier,
+        relayKey,
+        relayUrl,
+        mode: 'direct-join',
+        inviteTraceId: inviteTraceId || null
+      });
+      global.sendMessage({
+        type: 'join-auth-success',
+        data: successPayload
+      });
     }
@@
 async function waitForRelayWriterActivation(options = {}) {
   const {
     relayKey,
     expectedWriterKey = null,
     timeoutMs = 10000,
-    reason = 'unknown'
+    reason = 'unknown',
+    inviteTraceId = null
   } = options;
   if (!relayKey) return { ok: false, reason, relayKey: null };
@@
   const relayManager = activeRelays.get(relayKey);
   if (!relayManager?.relay) {
-    console.warn('[RelayServer] waitForRelayWriterActivation: relay manager missing', { relayKey, reason });
+    console.warn('[RelayServer] waitForRelayWriterActivation: relay manager missing', {
+      relayKey,
+      reason,
+      inviteTraceId
+    });
     return { ok: false, reason, relayKey };
   }
@@
     } catch (error) {
       console.warn('[RelayServer] waitForRelayWriterActivation: relay.ready() failed', {
         relayKey,
         reason,
+        inviteTraceId,
         error: error?.message || error
       });
     }
   }
@@
     return {
       relayKey,
       reason,
       context,
+      inviteTraceId,
       writable: relay?.writable ?? null,
       activeWriters: relay?.activeWriters?.size ?? null,
       writerSample: sampleActiveWriterKeys(relay),
@@
       const writerSetPayload = {
         relayKey,
         reason,
+        inviteTraceId,
         expectedWriter: expectedHex,
         expectedWriterPresent: expectedPresent,
         viewVersion: snap.viewVersion ?? null,
         viewCoreLength: snap.viewCoreLength ?? null,
         viewCoreRemoteLength: snap.viewCoreRemoteLength ?? null,
         activeWritersTotal: writerSet.total ?? null,
         activeWritersPreview: writerSet.preview,
         activeWritersTruncated: writerSet.truncated
       };
@@
 function scheduleLateWriterRecovery(options = {}) {
   const {
     relayKey,
     expectedWriterKey = null,
     publicIdentifier = null,
     authToken = null,
     relayUrl = null,
     mode = 'unknown',
     timeoutMs = LATE_WRITER_RECOVERY_TIMEOUT_MS,
     requireWritable = true,
-    reason = 'unknown'
+    reason = 'unknown',
+    inviteTraceId = null
   } = options;
@@
   console.log('[RelayServer] Scheduling late writer recovery', {
     relayKey,
     reason,
     mode,
     requireWritable,
     timeoutMs,
-    expectedWriter: previewWriterKey(normalizeWriterKey(expectedWriterKey))
+    expectedWriter: previewWriterKey(normalizeWriterKey(expectedWriterKey)),
+    inviteTraceId
   });
@@
   const task = waitForRelayWriterActivation({
     relayKey,
     expectedWriterKey: waitKey,
     timeoutMs,
-    reason: `${reason}-late`
+    reason: `${reason}-late`,
+    inviteTraceId
   }).then((result) => {


///


diff --git a/hypertuna-worker/hypertuna-relay-manager-bare.mjs b/hypertuna-worker/hypertuna-relay-manager-bare.mjs
--- a/hypertuna-worker/hypertuna-relay-manager-bare.mjs
+++ b/hypertuna-worker/hypertuna-relay-manager-bare.mjs
@@
     setupSwarmListeners() {
       this.swarm.on('connection', async (connection, peerInfo) => {
         const peerKey = b4a.toString(peerInfo.publicKey, 'hex');
-        console.log('\rPeer joined', peerKey.substring(0, 16));
+        const peerKeyPreview = peerKey.substring(0, 16);
+        console.log('\rPeer joined', peerKeyPreview);
         
         // Track peer
         this.peers.set(peerKey, {
           connection,
           connectedAt: new Date(),
           info: peerInfo
         });
         
         const mux = new Protomux(connection);
         console.log('Initialized Protomux on the connection');
         
+        let addWriterOpenedAt = null;
         const addWriterProtocol = mux.createChannel({
           protocol: 'add-writer',
           onopen: () => {
+            addWriterOpenedAt = Date.now();
             console.log('add-writer protocol opened!');
+            console.info('[CJTRACE] add-writer protocol opened', {
+              peer: peerKeyPreview
+            });
           },
-          onclose: () => {
+          onclose: (err) => {
+            const durationMs = addWriterOpenedAt ? Date.now() - addWriterOpenedAt : null;
             console.log('add-writer protocol closed!');
+            console.info('[CJTRACE] add-writer protocol closed', {
+              peer: peerKeyPreview,
+              durationMs,
+              error: err?.message || err || null
+            });
             // Remove peer on disconnect
             this.peers.delete(peerKey);
           }
         });


///

diff --git a/public-gateway/src/PublicGatewayService.mjs b/public-gateway/src/PublicGatewayService.mjs
--- a/public-gateway/src/PublicGatewayService.mjs
+++ b/public-gateway/src/PublicGatewayService.mjs
@@
       if (!relayKey && this.#isHexRelayKey(trimmedIdentifier)) {
         relayKey = trimmedIdentifier.toLowerCase();
       }
+      this.logger?.info?.( {
+        identifier: trimmedIdentifier || null,
+        resolvedRelayKey: relayKey || null,
+        hasRecord: !!record,
+        closedJoinRequested,
+        traceId: inviteTraceId || null
+      }, `${CJTRACE_TAG} mirror metadata resolved`);
@@
     const authEvent = req.body?.authEvent || req.body?.event || null;
     if (!authEvent || typeof authEvent !== 'object') {
       return res.status(400).json({ error: 'missing-auth-event' });
     }
+    const authEventId = typeof authEvent?.id === 'string' ? authEvent.id.slice(0, 16) : null;
+    const authEventPubkey = typeof authEvent?.pubkey === 'string' ? authEvent.pubkey.slice(0, 16) : null;
+    this.logger?.info?.( {
+      relayKey: identifier,
+      authEventId,
+      authEventPubkey,
+      authEventKind: authEvent?.kind ?? null,
+      tagCount: Array.isArray(authEvent?.tags) ? authEvent.tags.length : null,
+      traceId: inviteTraceId || null
+    }, `${CJTRACE_TAG} closed join auth event`);


///

diff --git a/public-gateway/src/blind-peer/BlindPeerService.mjs b/public-gateway/src/blind-peer/BlindPeerService.mjs
--- a/public-gateway/src/blind-peer/BlindPeerService.mjs
+++ b/public-gateway/src/blind-peer/BlindPeerService.mjs
@@
     this.blindPeeringSwarm = null;
     this.blindPeeringStore = null;
     this.blindPeeringSwarmLogInterval = null;
     this.blindPeeringMirrorKey = null;
     this.blindPeeringClientKey = null;
+    this.blindPeeringTopicKey = null;
     this.blindPeeringKeyPath = this.config?.blindPeeringKeyPath
       ? resolve(this.config.blindPeeringKeyPath)
       : null;
@@
     this.hygieneStats = {
       totalRuns: 0,
       lastRunAt: null,
       lastDurationMs: null,
       lastResult: null,
       lastError: null,
       lastBytesFreed: 0,
       lastEvictions: 0
     };
     this.coreMetadata = new Map();
+    this.coreDiagnosticsPrev = new Map();
     this.dispatcherAssignments = new Map();
@@
     const blindPeeringTopic = this.blindPeering?.topic || this.blindPeering?.topicKey || null;
     const blindPeeringTopicKey = toKeyString(blindPeeringTopic);
+    this.blindPeeringTopicKey = blindPeeringTopicKey;
     const swarmKeyPairPublicKey = toKeyString(swarm?.keyPair?.publicKey || persistedKeyPair?.publicKey || null);
@@
       this.blindPeeringSwarmLogInterval = setInterval(() => {
         const hasConnections = swarm && Object.prototype.hasOwnProperty.call(swarm, 'connections');
         const connectionsValue = hasConnections ? swarm.connections : null;
         const connectionsType = connectionsValue
           ? (connectionsValue.constructor?.name || typeof connectionsValue)
           : (hasConnections ? 'null' : 'absent');
         const connectionCount = Number.isFinite(connectionsValue?.size)
           ? connectionsValue.size
           : (Array.isArray(connectionsValue) ? connectionsValue.length : null);
+        const hasPeers = swarm && Object.prototype.hasOwnProperty.call(swarm, 'peers');
+        const peersValue = hasPeers ? swarm.peers : null;
+        const peersType = peersValue
+          ? (peersValue.constructor?.name || typeof peersValue)
+          : (hasPeers ? 'null' : 'absent');
+        const peerCount = Number.isFinite(peersValue?.size)
+          ? peersValue.size
+          : (Array.isArray(peersValue) ? peersValue.length : null);
         this.logger?.info?.({
           mirrorKey,
           clientKey,
+          topic: this.blindPeeringTopicKey || null,
           connectionCount,
           hasConnections,
           connectionsType,
+          peerCount,
+          hasPeers,
+          peersType,
           reason: 'interval'
         }, `${CJTRACE_TAG} blind peering swarm status`);
       }, 30000).unref();
     }
@@
   async #logCoreDiagnostics({
     key,
     context = 'unknown',
     identifier = null,
     reason = null,
     type = null,
     role = null,
     priority = null,
     announce = null
   } = {}) {
     const diagnostics = await this.#describeCoreDiagnostics(key);
     if (!diagnostics) return;
     const keyPreview = diagnostics.key ? diagnostics.key.slice(0, 16) : null;
     const hasLocalData = Number.isFinite(diagnostics.localLength) ? diagnostics.localLength > 0 : null;
     const hasPeers = Number.isFinite(diagnostics.peerCount) ? diagnostics.peerCount > 0 : null;
+    const prevSnapshot = this.coreDiagnosticsPrev?.get(diagnostics.key) || null;
+    const prevRemoteLength = Number.isFinite(prevSnapshot?.remoteLength) ? prevSnapshot.remoteLength : null;
+    const prevPeerCount = Number.isFinite(prevSnapshot?.peerCount) ? prevSnapshot.peerCount : null;
+    const remoteLengthDelta = Number.isFinite(diagnostics.remoteLength) && Number.isFinite(prevRemoteLength)
+      ? diagnostics.remoteLength - prevRemoteLength
+      : null;
+    const peerCountDelta = Number.isFinite(diagnostics.peerCount) && Number.isFinite(prevPeerCount)
+      ? diagnostics.peerCount - prevPeerCount
+      : null;
     this.logger?.info?.({
       context,
       identifier,
       reason,
       type,
       role,
       priority,
       announce,
       key: keyPreview,
       status: diagnostics.status || null,
       store: diagnostics.store || null,
       localLength: diagnostics.localLength ?? null,
       contiguousLength: diagnostics.contiguousLength ?? null,
       byteLength: diagnostics.byteLength ?? null,
       fork: diagnostics.fork ?? null,
       remoteLength: diagnostics.remoteLength ?? null,
+      prevRemoteLength,
+      remoteLengthDelta,
       remoteContiguousLength: diagnostics.remoteContiguousLength ?? null,
       peerCount: diagnostics.peerCount ?? null,
+      prevPeerCount,
+      peerCountDelta,
       lastSeenAt: diagnostics.lastSeenAt ?? null,
       hasLocalData,
       hasPeers,
       mirrorKey: this.blindPeeringMirrorKey || null,
       clientKey: this.blindPeeringClientKey || null
     }, `${CJTRACE_TAG} blind peer core diagnostics`);
+    if (this.coreDiagnosticsPrev && diagnostics.key) {
+      this.coreDiagnosticsPrev.set(diagnostics.key, {
+        remoteLength: Number.isFinite(diagnostics.remoteLength) ? diagnostics.remoteLength : null,
+        peerCount: Number.isFinite(diagnostics.peerCount) ? diagnostics.peerCount : null,
+        updatedAt: Date.now()
+      });
+    }
   }


///

diff --git a/indiepress-dev/src/providers/WorkerBridgeProvider.tsx b/indiepress-dev/src/providers/WorkerBridgeProvider.tsx
--- a/indiepress-dev/src/providers/WorkerBridgeProvider.tsx
+++ b/indiepress-dev/src/providers/WorkerBridgeProvider.tsx
@@
           case 'join-auth-success': {
             const identifier = msg?.data?.publicIdentifier
             if (!identifier) break
+            console.info('[CJTRACE] join-auth-success received', {
+              publicIdentifier: identifier,
+              relayKey: msg?.data?.relayKey ? String(msg?.data?.relayKey).slice(0, 16) : null,
+              relayUrl: msg?.data?.relayUrl ? String(msg?.data?.relayUrl).slice(0, 80) : null,
+              mode: msg?.data?.mode ?? null,
+              provisional: msg?.data?.provisional ?? null,
+              inviteTraceId: msg?.data?.inviteTraceId || null
+            })
             setJoinFlows((prev) => {

///


diff --git a/hypertuna-worker/index.js b/hypertuna-worker/index.js
--- a/hypertuna-worker/index.js
+++ b/hypertuna-worker/index.js
@@
       const dataBlindPeer = data.blindPeer || data.blind_peer || null
       console.log('[Worker] Open join bootstrap response', {
         relayIdentifier,
         origin: base,
+        source: data.source || data.mirrorSource || data.mirror_source || null,
         relayKey: previewValue(data.relayKey || data.relay_key, 16),
         publicIdentifier: data.publicIdentifier || data.public_identifier || null,
         hasWriterCore: !!data.writerCore,
@@
   let lastError = null
+  let lastHttpStatus = null
+  let lastOrigin = null
   const inviteTraceId = normalizeTraceId(traceId)
 
   for (const origin of originList) {
     if (!origin) continue
+    lastOrigin = origin
     const query = preferClosedJoin ? '?closedJoin=1' : ''
     const url = `${origin.replace(/\/$/, '')}/api/relays/${encodedRelay}/mirror${query}`
@@
       const headers = inviteTraceId ? { 'x-invite-trace': inviteTraceId } : undefined
       const response = await fetchImpl(url, { signal: controller?.signal, headers })
       if (!response.ok) {
+        lastHttpStatus = response.status
         lastError = new Error(`status ${response.status}`)
         continue
       }
+      lastHttpStatus = response.status
       const data = await response.json().catch(() => null)
       if (!data || typeof data !== 'object') {
         lastError = new Error('invalid-payload')
         continue
@@
       console.log('[Worker] Mirror metadata response', {
         relayKey,
         origin,
         resolvedRelayKey: previewValue(data.relayKey || data.relay_key, 16),
@@
-      return { status: 'ok', origin, data, inviteTraceId }
+      return { status: 'ok', origin, data, inviteTraceId, httpStatus: response.status }
     } catch (error) {
       lastError = error
     } finally {
       if (timer) clearTimeout(timer)
     }
   }
 
   if (lastError) {
     console.warn('[Worker] Mirror metadata fetch failed', {
       relayKey,
       reason,
       inviteTraceId,
       error: lastError?.message || lastError
     })
   }
-  return { status: 'error', reason: 'mirror-unavailable', error: lastError }
+  return {
+    status: 'error',
+    reason: 'mirror-unavailable',
+    error: lastError,
+    origin: lastOrigin || null,
+    httpStatus: lastHttpStatus
+  }
 }
@@
-  for (let attempt = 0; attempt <= attempts; attempt += 1) {
-    const attemptStartedAt = Date.now()
+  for (let attempt = 0; attempt <= attempts; attempt += 1) {
+    const attemptStartedAt = Date.now()
+    const waitMs = attempt > 0 ? backoffMs * Math.pow(2, attempt - 1) : 0
     console.info(`${CJTRACE_TAG} invite mirror attempt`, {
       relayIdentifier,
       relayKey: previewValue(resolvedRelayKey || relayIdentifier, 16),
       publicIdentifier: resolvedPublicIdentifier || publicIdentifier || null,
       attempt,
       attempts,
       closedJoin,
       hasRelayManager: !!relayManager,
       hasAppend,
       action: attempt > 0 ? 'append+fetch' : 'fetch',
       backoffMs,
+      waitMs,
       startedAt: attemptStartedAt,
       inviteTraceId
     })
@@
-      const waitMs = backoffMs * Math.pow(2, attempt - 1)
       if (waitMs > 0) await delay(waitMs)
     }
@@
       console.warn('[Worker] Invite mirror fetch failed', {
         relayIdentifier,
         attempt,
         status: mirrorResult?.status ?? null,
         reason: mirrorResult?.reason ?? null,
+        httpStatus: mirrorResult?.httpStatus ?? null,
         origin: mirrorResult?.origin || null,
         fetchElapsedMs,
         inviteTraceId
       })
       continue
     }
@@
-          const inviteMirrorSnapshot = normalizeInviteMirrorSnapshot(
+          const inviteMirrorSnapshot = normalizeInviteMirrorSnapshot(
             data.mirrorSnapshot || data.mirror_snapshot || data.inviteMirror || data.invite_mirror || data.mirror
           )
           const inviteTraceId = normalizeTraceId(data.inviteTraceId)
             || normalizeTraceId(inviteMirrorSnapshot?.inviteTraceId)
             || null
+          const inviteMirrorReadiness = data.mirrorReadiness || data.mirror_readiness || null
+          const inviteMirrorHydration = data.mirrorHydration || data.mirror_hydration || null
+          const inviteMirrorReadinessSummary = inviteMirrorReadiness && typeof inviteMirrorReadiness === 'object'
+            ? {
+                ready: inviteMirrorReadiness.ready ?? null,
+                reason: inviteMirrorReadiness.reason ?? null,
+                mirrorSource: inviteMirrorReadiness.mirrorSource || null,
+                updatedAt: inviteMirrorReadiness.updatedAt ?? null,
+                coreRefsCount: inviteMirrorReadiness.coreRefsCount ?? null,
+                requiredCount: inviteMirrorReadiness.requiredCount ?? null,
+                requiredMissingCount: inviteMirrorReadiness.requiredMissingCount ?? null
+              }
+            : null
+          const inviteMirrorHydrationSummary = inviteMirrorHydration && typeof inviteMirrorHydration === 'object'
+            ? {
+                status: inviteMirrorHydration.status ?? null,
+                ready: inviteMirrorHydration.ready ?? null,
+                reason: inviteMirrorHydration.reason ?? null,
+                missing: inviteMirrorHydration.summary?.missing ?? null,
+                notReady: inviteMirrorHydration.summary?.notReady ?? null,
+                total: inviteMirrorHydration.summary?.total ?? null
+              }
+            : null
           const coreRefsInput = closedInvite
             ? []
             : (Array.isArray(data.cores) ? data.cores : [])
@@
             console.info(`${CJTRACE_TAG} join flow invite mirror`, {
               publicIdentifier,
               relayIdentifier: mirrorRelayKey || joinRelayKey || publicIdentifier || null,
               mirrorSource: inviteMirrorSnapshot.mirrorSource || null,
               updatedAt: inviteMirrorSnapshot.updatedAt ?? null,
               fetchedAt: inviteMirrorSnapshot.fetchedAt ?? null,
+              mirrorReadiness: inviteMirrorReadinessSummary,
+              mirrorHydration: inviteMirrorHydrationSummary,
               hasBlindPeer: !!blindPeer?.publicKey,
               mirrorCoreRefsCount: mirrorCoreRefs.length,
               mirrorCoreRefsInput: mirrorCoreStats.inputCount,
///


diff --git a/hypertuna-worker/hypertuna-relay-manager-bare.mjs b/hypertuna-worker/hypertuna-relay-manager-bare.mjs
--- a/hypertuna-worker/hypertuna-relay-manager-bare.mjs
+++ b/hypertuna-worker/hypertuna-relay-manager-bare.mjs
@@
-            console.info('[CJTRACE] add-writer protocol closed', {
-              peer: peerKeyPreview,
-              durationMs,
-              error: err?.message || err || null
-            });
+            console.info('[CJTRACE] add-writer protocol closed', {
+              peer: peerKeyPreview,
+              durationMs,
+              closeCode: err?.code ?? null,
+              closeReason: err?.reason ?? err?.message ?? null,
+              error: err?.message || err || null
+            });

///


diff --git a/public-gateway/src/PublicGatewayService.mjs b/public-gateway/src/PublicGatewayService.mjs
--- a/public-gateway/src/PublicGatewayService.mjs
+++ b/public-gateway/src/PublicGatewayService.mjs
@@
     const inviteTraceId = normalizeTraceId(
       req.get?.('x-invite-trace')
       || req.get?.('x-invite-trace-id')
       || req.get?.('x-trace-id')
     );
+    this.logger?.info?.( {
+      relayKey: identifier,
+      traceId: inviteTraceId || null,
+      path: 'closed-join/append-cores'
+    }, `${CJTRACE_TAG} closed join append received`);
@@
     this.logger?.info?.({
       relayKey,
       identifier,
       reason,
       coreEntriesCount: normalized.length,
+      announce: true,
+      priority: 5,
+      type: 'relay-mirror',
       roleTally: roleTally.size ? Object.fromEntries(roleTally.entries()) : null,
       coreEntriesPreview: normalized.slice(0, 10),
       traceId: traceId || null
     }, '[CJTRACE] relay mirror pin request');

///


diff --git a/public-gateway/src/blind-peer/BlindPeerService.mjs b/public-gateway/src/blind-peer/BlindPeerService.mjs
--- a/public-gateway/src/blind-peer/BlindPeerService.mjs
+++ b/public-gateway/src/blind-peer/BlindPeerService.mjs
@@
       remoteLength: diagnostics.remoteLength ?? null,
       prevRemoteLength,
       remoteLengthDelta,
       remoteContiguousLength: diagnostics.remoteContiguousLength ?? null,
       peerCount: diagnostics.peerCount ?? null,
       prevPeerCount,
       peerCountDelta,
       lastSeenAt: diagnostics.lastSeenAt ?? null,
+      lastDownloadedAt: diagnostics.lastSeenAt ?? null,
       hasLocalData,
       hasPeers,
       mirrorKey: this.blindPeeringMirrorKey || null,
       clientKey: this.blindPeeringClientKey || null
     }, `${CJTRACE_TAG} blind peer core diagnostics`);
