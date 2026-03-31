function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function bridgeClientScript() {
  return `
(() => {
  const pending = new Map();
  let sequence = 0;

  function nextId() {
    sequence += 1;
    return 'bridge-' + Date.now().toString(16) + '-' + sequence.toString(16);
  }

  function send(action, payload = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const requestId = nextId();
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Bridge timeout for ' + action));
      }, Math.max(1000, timeoutMs));

      pending.set(requestId, { resolve, reject, timer });
      window.parent.postMessage(
        {
          __htpluginBridge: true,
          kind: 'request',
          requestId,
          action,
          payload
        },
        '*'
      );
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.__htpluginBridge !== true) return;

    if (message.kind === 'response') {
      const pendingRequest = pending.get(message.requestId);
      if (!pendingRequest) return;
      window.clearTimeout(pendingRequest.timer);
      pending.delete(message.requestId);
      if (message.success === false) {
        pendingRequest.reject(new Error(String(message.error || 'Bridge request failed')));
      } else {
        pendingRequest.resolve(message.data || null);
      }
      return;
    }

    if (message.kind === 'event') {
      const detail = message.payload && typeof message.payload === 'object'
        ? { ...message.payload, bridgeEventType: message.eventType || null }
        : { bridgeEventType: message.eventType || null };
      window.dispatchEvent(new CustomEvent('htplugin:event', { detail }));
    }
  });

  window.htPluginBridge = {
    request: send,
    mediaCommand(type, data = {}, timeoutMs = 12000) {
      return send('media-command', { type, data, timeoutMs }, timeoutMs);
    },
    workerCommand(type, data = {}, timeoutMs = 12000) {
      return send('worker-command', { type, data, timeoutMs }, timeoutMs);
    },
    pluginInvoke(payload = {}, timeoutMs = 12000) {
      return send('plugin-invoke', { payload, timeoutMs }, timeoutMs);
    }
  };
})();
`
}

function renderAudioRoom(payload = {}, context = {}) {
  const pluginId = escapeHtml(context?.pluginId || 'unknown')
  const pluginVersion = escapeHtml(context?.pluginVersion || 'unknown')
  const routePath = escapeHtml(payload?.routePath || '/')
  const defaultSessionId = `${pluginId}-room`

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>P2P Audio/Video Room</title>
    <style>
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: linear-gradient(150deg, #f7faff, #e5eef9);
        color: #14243a;
      }
      .wrap {
        max-width: 1120px;
        margin: 0 auto;
        padding: 16px;
      }
      .card {
        border: 1px solid #c8d7ef;
        border-radius: 14px;
        background: #ffffffeb;
        box-shadow: 0 12px 28px #35558914;
        padding: 14px;
        margin-bottom: 12px;
      }
      h1 { margin: 0 0 4px; font-size: 24px; }
      h2 { margin: 0 0 8px; font-size: 16px; }
      .muted { color: #4d607b; font-size: 12px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .field {
        display: grid;
        gap: 4px;
      }
      .field label {
        font-size: 12px;
        color: #3a4c69;
      }
      input[type="text"] {
        border: 1px solid #abc1e4;
        border-radius: 10px;
        padding: 8px 10px;
        background: #f8fbff;
        color: #123;
        width: 100%;
        box-sizing: border-box;
      }
      .checks {
        display: flex;
        gap: 12px;
        align-items: center;
        font-size: 13px;
      }
      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
        margin-top: 10px;
      }
      button {
        border: 1px solid #87a6d3;
        border-radius: 10px;
        background: #f0f6ff;
        color: #173568;
        padding: 9px 10px;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover {
        background: #e2eeff;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 4px 10px;
        border: 1px solid #b7cae8;
        background: #eef5ff;
        color: #123a6f;
        font-size: 12px;
        margin-top: 10px;
      }
      .layout {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .media-slot {
        border: 1px solid #c4d6ef;
        border-radius: 12px;
        background: #f4f8ff;
        padding: 8px;
      }
      .media-slot h3 {
        margin: 0 0 6px;
        font-size: 13px;
        color: #355180;
      }
      video {
        width: 100%;
        min-height: 220px;
        background: #090f17;
        border-radius: 10px;
      }
      pre {
        margin: 0;
        background: #081322;
        color: #dbe9ff;
        border-radius: 12px;
        padding: 12px;
        min-height: 190px;
        max-height: 350px;
        overflow: auto;
        font-size: 11px;
        white-space: pre-wrap;
      }
      code {
        background: #e9f0ff;
        border-radius: 6px;
        padding: 1px 5px;
      }
      @media (max-width: 940px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <h1>P2P Audio/Video Room</h1>
        <div class="muted">
          Plugin <code>${pluginId}</code> v${pluginVersion} on <code>${routePath}</code>
        </div>
        <div class="grid" style="margin-top:10px">
          <div class="field">
            <label for="sessionId">Session ID</label>
            <input id="sessionId" type="text" value="${escapeHtml(defaultSessionId)}" />
          </div>
          <div class="field">
            <label for="localPeerId">Local Peer ID</label>
            <input id="localPeerId" type="text" value="peer-${Date.now().toString(36).slice(-6)}" />
          </div>
          <div class="field">
            <label for="remotePeerId">Remote Peer ID</label>
            <input id="remotePeerId" type="text" placeholder="peer-other" />
          </div>
          <div class="field">
            <label for="relayUrls">Relay URLs (optional, comma separated)</label>
            <input id="relayUrls" type="text" placeholder="wss://relay.damus.io, wss://nos.lol" />
          </div>
        </div>
        <div class="checks" style="margin-top:10px">
          <label><input id="videoToggle" type="checkbox" checked /> Enable local camera</label>
          <label><input id="autoAnswerToggle" type="checkbox" checked /> Auto-answer incoming offers</label>
        </div>
        <div class="controls">
          <button id="statusBtn">Service Status</button>
          <button id="createBtn">Create Session</button>
          <button id="joinBtn">Join Session</button>
          <button id="leaveBtn">Leave Session</button>
          <button id="startMediaBtn">Start Mic/Camera</button>
          <button id="stopMediaBtn">Stop Local Media</button>
          <button id="offerBtn">Start Call (Send Offer)</button>
          <button id="hangupBtn">Hang Up</button>
          <button id="listSessionsBtn">List Sessions</button>
          <button id="recordingsBtn">List Recordings</button>
        </div>
        <div class="status" id="statusBadge">Idle</div>
      </section>

      <section class="layout">
        <section class="card media-slot">
          <h3>Local Preview</h3>
          <video id="localVideo" autoplay playsinline muted></video>
        </section>
        <section class="card media-slot">
          <h3>Remote Stream</h3>
          <video id="remoteVideo" autoplay playsinline></video>
        </section>
      </section>

      <section class="card">
        <h2>Event + Action Log</h2>
        <pre id="log"></pre>
      </section>
    </main>
    <script>
      ${bridgeClientScript()}

      const localVideoEl = document.getElementById('localVideo');
      const remoteVideoEl = document.getElementById('remoteVideo');
      const logEl = document.getElementById('log');
      const statusBadge = document.getElementById('statusBadge');

      const sessionInput = document.getElementById('sessionId');
      const localPeerInput = document.getElementById('localPeerId');
      const remotePeerInput = document.getElementById('remotePeerId');
      const relayInput = document.getElementById('relayUrls');
      const videoToggle = document.getElementById('videoToggle');
      const autoAnswerToggle = document.getElementById('autoAnswerToggle');

      const state = {
        joined: false,
        pc: null,
        remotePeerId: '',
        localStream: null,
        remoteStream: new MediaStream(),
        pendingIce: []
      };

      remoteVideoEl.srcObject = state.remoteStream;

      function appendLog(label, payload) {
        const line = '[' + new Date().toISOString() + '] ' + label + '\\n' +
          JSON.stringify(payload, null, 2) + '\\n\\n';
        logEl.textContent = line + logEl.textContent;
      }

      function setStatus(text) {
        statusBadge.textContent = text || 'Idle';
      }

      function currentSessionId() {
        return (sessionInput.value || '').trim();
      }

      function currentLocalPeerId() {
        return (localPeerInput.value || '').trim();
      }

      function currentRemotePeerId() {
        return (remotePeerInput.value || '').trim();
      }

      function parseRelayUrls() {
        const raw = String(relayInput.value || '');
        return Array.from(new Set(
          raw
            .split(/[\\s,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
        ));
      }

      function buildSignalData(signalType, signalPayload, targetPeerId) {
        const sessionId = currentSessionId();
        const fromPeerId = currentLocalPeerId();
        if (!sessionId) throw new Error('Session ID is required');
        if (!fromPeerId) throw new Error('Local peer ID is required');
        if (!signalType) throw new Error('signalType is required');
        const data = {
          sessionId,
          fromPeerId,
          signalType,
          payload: signalPayload || null
        };
        const toPeerId = (targetPeerId || '').trim();
        if (toPeerId) data.toPeerId = toPeerId;
        const relayUrls = parseRelayUrls();
        if (relayUrls.length) data.signaling = { relayUrls };
        return data;
      }

      async function bridgeMedia(type, data = {}, timeoutMs = 16000) {
        const result = await window.htPluginBridge.mediaCommand(type, data, timeoutMs);
        if (result && result.success === false) {
          throw new Error(String(result.error || 'Command failed'));
        }
        return result;
      }

      async function run(label, fn) {
        try {
          const result = await fn();
          appendLog(label + ' ok', result);
          return result;
        } catch (error) {
          appendLog(label + ' error', { message: String(error && error.message ? error.message : error) });
          throw error;
        }
      }

      function closePeerConnection({ preserveRemoteStream = false } = {}) {
        if (state.pc) {
          try { state.pc.ontrack = null; } catch (_) {}
          try { state.pc.onicecandidate = null; } catch (_) {}
          try { state.pc.onconnectionstatechange = null; } catch (_) {}
          try { state.pc.close(); } catch (_) {}
        }
        state.pc = null;
        state.pendingIce = [];
        if (!preserveRemoteStream) {
          state.remoteStream = new MediaStream();
          remoteVideoEl.srcObject = state.remoteStream;
        }
      }

      function addLocalTracksToPeerConnection(pc) {
        if (!pc || !state.localStream) return;
        const existingTrackIds = new Set(
          pc.getSenders()
            .map((sender) => sender && sender.track && sender.track.id)
            .filter(Boolean)
        );
        state.localStream.getTracks().forEach((track) => {
          if (existingTrackIds.has(track.id)) return;
          pc.addTrack(track, state.localStream);
        });
      }

      function buildPeerConnection(remotePeerId) {
        if (!remotePeerId) {
          throw new Error('Remote peer ID is required');
        }

        if (state.pc && state.remotePeerId === remotePeerId) {
          return state.pc;
        }

        closePeerConnection({ preserveRemoteStream: false });
        state.remotePeerId = remotePeerId;
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onconnectionstatechange = () => {
          setStatus('Connection: ' + String(pc.connectionState || 'unknown'));
          appendLog('pc.connectionState', { state: pc.connectionState || null, remotePeerId });
        };

        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          const targetPeerId = state.remotePeerId || currentRemotePeerId();
          if (!targetPeerId) return;
          run('media-send-signal(ice)', () =>
            bridgeMedia('media-send-signal', buildSignalData(
              'ice',
              event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
              targetPeerId
            ), 16000)
          ).catch(() => {});
        };

        pc.ontrack = (event) => {
          const stream = event.streams && event.streams[0] ? event.streams[0] : null;
          if (stream) {
            state.remoteStream = stream;
            remoteVideoEl.srcObject = state.remoteStream;
            return;
          }
          if (event.track) {
            state.remoteStream.addTrack(event.track);
            remoteVideoEl.srcObject = state.remoteStream;
          }
        };

        state.pc = pc;
        addLocalTracksToPeerConnection(pc);
        return pc;
      }

      async function startLocalMedia() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia is unavailable in this plugin iframe context');
        }
        if (state.localStream) return state.localStream;

        const wantVideo = !!videoToggle.checked;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: wantVideo
        });
        state.localStream = stream;
        localVideoEl.srcObject = stream;
        addLocalTracksToPeerConnection(state.pc);

        if (state.joined) {
          const remote = currentRemotePeerId() || state.remotePeerId || null;
          const payload = {
            hasAudio: stream.getAudioTracks().length > 0,
            hasVideo: stream.getVideoTracks().length > 0,
            remotePeerId: remote
          };
          run('media-update-stream-metadata', () =>
            bridgeMedia('media-update-stream-metadata', {
              sessionId: currentSessionId(),
              peerId: currentLocalPeerId(),
              stream: payload
            })
          ).catch(() => {});
        }

        setStatus('Local media active');
        return stream;
      }

      function stopLocalMedia() {
        if (!state.localStream) return;
        state.localStream.getTracks().forEach((track) => {
          try { track.stop(); } catch (_) {}
        });
        state.localStream = null;
        localVideoEl.srcObject = null;
        setStatus('Local media stopped');
      }

      async function createSession() {
        const sessionId = currentSessionId();
        if (!sessionId) throw new Error('Session ID is required');
        const relayUrls = parseRelayUrls();
        return bridgeMedia('media-create-session', {
          sessionId,
          metadata: {
            pluginId: '${pluginId}',
            mode: 'webrtc-av-room',
            signaling: relayUrls.length ? { relayUrls } : null
          }
        });
      }

      async function joinSession() {
        const sessionId = currentSessionId();
        const peerId = currentLocalPeerId();
        if (!sessionId) throw new Error('Session ID is required');
        if (!peerId) throw new Error('Local peer ID is required');
        const relayUrls = parseRelayUrls();
        const response = await bridgeMedia('media-join-session', {
          sessionId,
          peerId,
          metadata: {
            pluginId: '${pluginId}',
            role: 'participant',
            signaling: relayUrls.length ? { relayUrls } : null
          }
        });
        state.joined = true;
        setStatus('Joined session as ' + peerId);
        return response;
      }

      async function leaveSession() {
        const sessionId = currentSessionId();
        const peerId = currentLocalPeerId();
        if (!sessionId || !peerId) throw new Error('sessionId + local peer ID are required');
        if (state.remotePeerId) {
          try {
            await bridgeMedia('media-send-signal', buildSignalData('bye', null, state.remotePeerId), 8000);
          } catch (_) {}
        }
        const result = await bridgeMedia('media-leave-session', {
          sessionId,
          peerId
        });
        state.joined = false;
        closePeerConnection({ preserveRemoteStream: false });
        setStatus('Left session');
        return result;
      }

      async function createOffer() {
        if (!state.joined) throw new Error('Join session before starting a call');
        await startLocalMedia();
        const targetPeerId = currentRemotePeerId();
        if (!targetPeerId) throw new Error('Remote peer ID is required');

        const pc = buildPeerConnection(targetPeerId);
        addLocalTracksToPeerConnection(pc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        setStatus('Offer created');
        return bridgeMedia('media-send-signal', buildSignalData('offer', pc.localDescription, targetPeerId), 16000);
      }

      async function applyRemoteIceCandidate(pc, candidatePayload) {
        if (!candidatePayload || typeof candidatePayload !== 'object') return;
        const candidate = new RTCIceCandidate(candidatePayload);
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          state.pendingIce.push(candidate);
          return;
        }
        await pc.addIceCandidate(candidate);
      }

      async function flushPendingIce(pc) {
        if (!pc || !state.pendingIce.length) return;
        const pending = state.pendingIce.splice(0, state.pendingIce.length);
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (error) {
            appendLog('ice.apply.failed', { message: String(error && error.message ? error.message : error) });
          }
        }
      }

      async function handleIncomingSignal(signal) {
        if (!signal || typeof signal !== 'object') return;
        if (String(signal.sessionId || '') !== currentSessionId()) return;
        const localPeerId = currentLocalPeerId();
        if (!localPeerId) return;
        if (signal.toPeerId && String(signal.toPeerId) !== localPeerId) return;
        if (String(signal.fromPeerId || '') === localPeerId) return;

        const signalType = String(signal.signalType || '');
        const fromPeerId = String(signal.fromPeerId || '').trim();
        if (!signalType || !fromPeerId) return;
        if (!state.remotePeerId) state.remotePeerId = fromPeerId;
        if (!currentRemotePeerId()) remotePeerInput.value = fromPeerId;

        if (signalType === 'offer') {
          if (!state.joined) {
            appendLog('offer ignored', { reason: 'not joined' });
            return;
          }
          if (autoAnswerToggle.checked) {
            await startLocalMedia().catch((error) => {
              appendLog('auto-start-media failed', { message: String(error && error.message ? error.message : error) });
            });
          }
          const pc = buildPeerConnection(fromPeerId);
          const payload = signal.payload && typeof signal.payload === 'object' ? signal.payload : null;
          if (!payload || !payload.type || !payload.sdp) {
            appendLog('offer invalid', { signal });
            return;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await flushPendingIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await bridgeMedia('media-send-signal', buildSignalData('answer', pc.localDescription, fromPeerId), 16000);
          setStatus('Answered offer from ' + fromPeerId);
          return;
        }

        if (signalType === 'answer') {
          const pc = state.pc;
          const payload = signal.payload && typeof signal.payload === 'object' ? signal.payload : null;
          if (!pc || !payload || !payload.type || !payload.sdp) return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await flushPendingIce(pc);
          setStatus('Remote answer applied');
          return;
        }

        if (signalType === 'ice') {
          const payload = signal.payload && typeof signal.payload === 'object' ? signal.payload : null;
          if (!payload) return;
          const pc = state.pc || buildPeerConnection(fromPeerId);
          await applyRemoteIceCandidate(pc, payload);
          return;
        }

        if (signalType === 'bye') {
          appendLog('remote hangup', { fromPeerId });
          closePeerConnection({ preserveRemoteStream: false });
          setStatus('Remote peer ended call');
          return;
        }
      }

      document.getElementById('statusBtn').addEventListener('click', () => {
        run('media-get-service-status', () => bridgeMedia('media-get-service-status', {})).catch(() => {});
      });

      document.getElementById('createBtn').addEventListener('click', () => {
        run('media-create-session', createSession).catch(() => {});
      });

      document.getElementById('joinBtn').addEventListener('click', () => {
        run('media-join-session', joinSession).catch(() => {});
      });

      document.getElementById('leaveBtn').addEventListener('click', () => {
        run('media-leave-session', leaveSession).catch(() => {});
      });

      document.getElementById('startMediaBtn').addEventListener('click', () => {
        run('start-local-media', startLocalMedia).catch(() => {});
      });

      document.getElementById('stopMediaBtn').addEventListener('click', () => {
        stopLocalMedia();
        appendLog('local-media-stopped', {});
      });

      document.getElementById('offerBtn').addEventListener('click', () => {
        run('create-offer', createOffer).catch(() => {});
      });

      document.getElementById('hangupBtn').addEventListener('click', () => {
        run('send-bye', async () => {
          const targetPeerId = state.remotePeerId || currentRemotePeerId();
          if (targetPeerId) {
            await bridgeMedia('media-send-signal', buildSignalData('bye', null, targetPeerId), 8000);
          }
          closePeerConnection({ preserveRemoteStream: false });
          return { ok: true };
        }).catch(() => {});
      });

      document.getElementById('listSessionsBtn').addEventListener('click', () => {
        run('media-list-sessions', () => bridgeMedia('media-list-sessions', {})).catch(() => {});
      });

      document.getElementById('recordingsBtn').addEventListener('click', () => {
        run('media-list-recordings', () => bridgeMedia('media-list-recordings', {})).catch(() => {});
      });

      window.addEventListener('htplugin:event', (event) => {
        const detail = event.detail || {};
        const messageType = String(detail.type || '');
        if (!messageType) return;

        if (messageType === 'media-session-signal') {
          handleIncomingSignal(detail.signal).catch((error) => {
            appendLog('signal-handle-failed', { message: String(error && error.message ? error.message : error) });
          });
          return;
        }

        if (messageType === 'media-session-participant-joined' || messageType === 'media-session-participant-left') {
          appendLog('event:' + messageType, detail);
          return;
        }

        if (messageType.startsWith('media-')) {
          appendLog('event:' + messageType, detail);
        }
      });

      window.addEventListener('beforeunload', () => {
        closePeerConnection({ preserveRemoteStream: false });
        stopLocalMedia();
      });

      appendLog('ready', {
        pluginId: '${pluginId}',
        version: '${pluginVersion}',
        message: 'Join the same session ID on two app instances, then exchange offers for real WebRTC audio/video.'
      });
      setStatus('Ready');
    </script>
  </body>
</html>`
}

export async function handleInvoke(payload = {}, context = {}) {
  if (payload?.type === 'render-route') {
    return {
      html: renderAudioRoom(payload, context)
    }
  }
  return {
    ok: true,
    payload
  }
}

export async function activate(context = {}) {
  context?.emit?.('p2p-audio-room-activated', {
    pluginId: context?.pluginId || null,
    pluginVersion: context?.pluginVersion || null
  })
}
