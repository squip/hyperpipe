import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_THREE_MODULE_PATH = path.resolve(MODULE_DIR, '..', 'assets', 'three.module.js')
const CDN_THREE_MODULE_URL = 'https://unpkg.com/three@0.165.0/build/three.module.js'

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
    }
  };
})();
`
}

async function loadThreeModuleRuntime() {
  try {
    const source = await fs.readFile(BUNDLED_THREE_MODULE_PATH, 'utf8')
    return {
      source: 'bundled-module',
      moduleSource: source,
      fallbackUrl: null,
      error: null
    }
  } catch (error) {
    return {
      source: 'cdn-module-fallback',
      moduleSource: '',
      fallbackUrl: CDN_THREE_MODULE_URL,
      error: error?.message || String(error)
    }
  }
}

const THREE_RUNTIME = await loadThreeModuleRuntime()

function threeRuntimeBootstrapScript() {
  const moduleSourceLiteral = JSON.stringify(String(THREE_RUNTIME.moduleSource || ''))
  const fallbackUrlLiteral = JSON.stringify(String(THREE_RUNTIME.fallbackUrl || ''))
  const runtimeSourceLiteral = JSON.stringify(String(THREE_RUNTIME.source || 'unknown'))
  const runtimeErrorLiteral = JSON.stringify(String(THREE_RUNTIME.error || ''))
  return `
(() => {
  const moduleSource = ${moduleSourceLiteral};
  const runtimeState = {
    source: ${runtimeSourceLiteral},
    fallbackUrl: ${fallbackUrlLiteral},
    startupError: ${runtimeErrorLiteral}
  };
  window.__HT_THREE_RUNTIME_STATE = runtimeState;

  async function loadThree() {
    if (window.THREE) {
      return { ok: true, source: 'existing-global' };
    }

    try {
      if (moduleSource.length > 0) {
        const blob = new Blob([moduleSource], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          const mod = await import(blobUrl);
          window.THREE = mod;
          runtimeState.source = 'bundled-module';
          return { ok: true, source: 'bundled-module' };
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch (error) {
      runtimeState.loadError = String(error && error.message ? error.message : error);
    }

    if (runtimeState.fallbackUrl) {
      try {
        const mod = await import(runtimeState.fallbackUrl);
        window.THREE = mod;
        runtimeState.source = 'cdn-module-fallback';
        return { ok: true, source: 'cdn-module-fallback' };
      } catch (error) {
        runtimeState.loadError = String(error && error.message ? error.message : error);
      }
    }

    return {
      ok: false,
      source: runtimeState.source || 'unavailable',
      error: runtimeState.loadError || runtimeState.startupError || 'Three runtime failed to load'
    };
  }

  window.__HT_THREE_READY = loadThree()
    .then((result) => {
      runtimeState.ready = result && result.ok === true;
      runtimeState.result = result || null;
      return result;
    })
    .catch((error) => {
      const result = {
        ok: false,
        source: runtimeState.source || 'error',
        error: String(error && error.message ? error.message : error)
      };
      runtimeState.ready = false;
      runtimeState.result = result;
      return result;
    });
})();
`
}

function renderPage(payload = {}, context = {}) {
  const pluginId = escapeHtml(context?.pluginId || 'unknown')
  const pluginVersion = escapeHtml(context?.pluginVersion || 'unknown')
  const routePath = escapeHtml(payload?.routePath || '/')
  const defaultSessionId = `${pluginId}-session`

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Three.js Multiplayer Demo</title>
    <style>
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 20% 0%, #152c53, #081326 70%);
        color: #e8f1ff;
      }
      .layout {
        display: grid;
        grid-template-columns: 320px 1fr;
        gap: 12px;
        min-height: 100vh;
        padding: 12px;
        box-sizing: border-box;
      }
      .panel {
        border-radius: 14px;
        border: 1px solid #2a3f69;
        background: #132544e5;
        padding: 12px;
      }
      .panel h1 {
        margin: 0 0 6px;
        font-size: 20px;
      }
      .muted {
        color: #9eb5de;
        font-size: 12px;
      }
      .field {
        display: grid;
        gap: 4px;
        margin-top: 8px;
      }
      .field label {
        font-size: 12px;
        color: #9eb5de;
      }
      input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid #49669b;
        background: #0d1a33;
        color: #e8f1ff;
        padding: 8px 10px;
      }
      .controls {
        display: grid;
        gap: 8px;
        margin: 12px 0 8px;
      }
      button {
        border: 1px solid #4c76bc;
        border-radius: 10px;
        background: #1f3b6d;
        color: #e8f1ff;
        font-weight: 600;
        padding: 8px 10px;
        cursor: pointer;
      }
      button:hover {
        background: #2a4f89;
      }
      #status {
        display: inline-flex;
        border-radius: 999px;
        border: 1px solid #47689d;
        background: #122746;
        color: #d3e4ff;
        padding: 4px 10px;
        font-size: 12px;
      }
      #log {
        margin: 8px 0 0;
        border-radius: 10px;
        background: #081020;
        border: 1px solid #28406a;
        min-height: 170px;
        max-height: 320px;
        overflow: auto;
        padding: 10px;
        font-size: 11px;
        white-space: pre-wrap;
      }
      #scene {
        border-radius: 14px;
        border: 1px solid #2a3f69;
        background: #050912;
        min-height: 420px;
        overflow: hidden;
      }
      .hint {
        margin-top: 6px;
        color: #8da7d8;
        font-size: 11px;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <script>
      ${threeRuntimeBootstrapScript()}
    </script>
  </head>
  <body>
    <main class="layout">
      <section class="panel">
        <h1>Three.js Multiplayer Demo</h1>
        <div class="muted">Plugin <code>${pluginId}</code> v${pluginVersion}</div>
        <div class="muted">Route <code>${routePath}</code></div>

        <div class="field">
          <label for="sessionId">Session ID</label>
          <input id="sessionId" value="${escapeHtml(defaultSessionId)}" />
        </div>
        <div class="field">
          <label for="localPeerId">Local Peer ID</label>
          <input id="localPeerId" value="peer-${Date.now().toString(36).slice(-6)}" />
        </div>
        <div class="field">
          <label for="remotePeerId">Remote Peer ID</label>
          <input id="remotePeerId" placeholder="peer-other" />
        </div>
        <div class="field">
          <label for="relayUrls">Relay URLs (optional)</label>
          <input id="relayUrls" placeholder="wss://relay.damus.io, wss://nos.lol" />
        </div>

        <div class="controls">
          <button id="createBtn">Create Session</button>
          <button id="joinBtn">Join Session</button>
          <button id="connectBtn">Connect (Offer)</button>
          <button id="disconnectBtn">Disconnect</button>
          <button id="listBtn">List Sessions</button>
          <button id="statsBtn">Get Service Stats</button>
        </div>

        <div id="status">Ready</div>
        <div class="hint">
          Use arrow keys to move the local cube. State sync is sent over WebRTC data channel, while SDP/ICE uses host signaling.
        </div>
        <pre id="log"></pre>
      </section>
      <section id="scene"></section>
    </main>
    <script>
      ${bridgeClientScript()}

      const logEl = document.getElementById('log');
      const sceneRoot = document.getElementById('scene');
      const statusEl = document.getElementById('status');
      const sessionInput = document.getElementById('sessionId');
      const localPeerInput = document.getElementById('localPeerId');
      const remotePeerInput = document.getElementById('remotePeerId');
      const relayInput = document.getElementById('relayUrls');
      const threeRuntimeState = window.__HT_THREE_RUNTIME_STATE || {};

      const state = {
        joined: false,
        pc: null,
        dataChannel: null,
        remotePeerId: '',
        pendingIce: [],
        localPosition: { x: 0, y: 0, z: 0 },
        remotePosition: { x: 2, y: 0, z: 0 },
        pressed: new Set()
      };

      function appendLog(label, payload) {
        const line = '[' + new Date().toISOString() + '] ' + label + '\\n' +
          JSON.stringify(payload, null, 2) + '\\n\\n';
        logEl.textContent = line + logEl.textContent;
      }

      function setStatus(text) {
        statusEl.textContent = text || 'Ready';
      }

      function currentSessionId() {
        return String(sessionInput.value || '').trim();
      }

      function currentLocalPeerId() {
        return String(localPeerInput.value || '').trim();
      }

      function currentRemotePeerId() {
        return String(remotePeerInput.value || '').trim();
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
        const data = {
          sessionId,
          fromPeerId,
          signalType,
          payload: signalPayload || null
        };
        const toPeerId = String(targetPeerId || '').trim();
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

      function handleIncomingState(payload) {
        if (!payload || typeof payload !== 'object') return;
        state.remotePosition = {
          x: Number(payload.x) || 0,
          y: Number(payload.y) || 0,
          z: Number(payload.z) || 0
        };
      }

      function sendStateSnapshot() {
        if (!state.dataChannel || state.dataChannel.readyState !== 'open') return;
        const message = {
          type: 'state',
          x: state.localPosition.x,
          y: state.localPosition.y,
          z: state.localPosition.z,
          ts: Date.now()
        };
        try {
          state.dataChannel.send(JSON.stringify(message));
        } catch (_) {}
      }

      function bindDataChannel(channel) {
        if (!channel) return;
        state.dataChannel = channel;
        channel.onopen = () => {
          setStatus('Data channel open');
          appendLog('datachannel.open', {
            label: channel.label || 'state',
            readyState: channel.readyState
          });
        };
        channel.onclose = () => {
          setStatus('Data channel closed');
          appendLog('datachannel.close', {
            label: channel.label || 'state',
            readyState: channel.readyState
          });
        };
        channel.onerror = (error) => {
          appendLog('datachannel.error', {
            message: String(error && error.message ? error.message : error)
          });
        };
        channel.onmessage = (event) => {
          let payload = null;
          try {
            payload = JSON.parse(String(event.data || '{}'));
          } catch (_) {
            payload = null;
          }
          if (!payload || payload.type !== 'state') return;
          handleIncomingState(payload);
        };
      }

      function closePeerConnection() {
        if (state.dataChannel) {
          try { state.dataChannel.close(); } catch (_) {}
        }
        state.dataChannel = null;
        state.pendingIce = [];

        if (state.pc) {
          try { state.pc.ondatachannel = null; } catch (_) {}
          try { state.pc.onicecandidate = null; } catch (_) {}
          try { state.pc.onconnectionstatechange = null; } catch (_) {}
          try { state.pc.close(); } catch (_) {}
        }
        state.pc = null;
      }

      function buildPeerConnection(remotePeerId) {
        if (!remotePeerId) {
          throw new Error('Remote peer ID is required');
        }
        if (state.pc && state.remotePeerId === remotePeerId) return state.pc;

        closePeerConnection();
        state.remotePeerId = remotePeerId;
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onconnectionstatechange = () => {
          setStatus('Connection: ' + String(pc.connectionState || 'unknown'));
          appendLog('pc.connectionState', {
            state: pc.connectionState || null,
            remotePeerId
          });
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
            ))
          ).catch(() => {});
        };

        pc.ondatachannel = (event) => {
          bindDataChannel(event.channel);
        };

        state.pc = pc;
        return pc;
      }

      async function applyRemoteIceCandidate(pc, payload) {
        if (!payload || typeof payload !== 'object') return;
        const candidate = new RTCIceCandidate(payload);
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

      async function createSession() {
        const sessionId = currentSessionId();
        if (!sessionId) throw new Error('Session ID is required');
        const relayUrls = parseRelayUrls();
        return bridgeMedia('media-create-session', {
          sessionId,
          metadata: {
            pluginId: '${pluginId}',
            mode: 'threejs-webrtc-datachannel',
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
            role: 'multiplayer-client',
            signaling: relayUrls.length ? { relayUrls } : null
          }
        });
        state.joined = true;
        setStatus('Joined session as ' + peerId);
        return response;
      }

      async function createOfferConnection() {
        if (!state.joined) throw new Error('Join the session before connecting');
        const remotePeerId = currentRemotePeerId();
        if (!remotePeerId) throw new Error('Remote peer ID is required');
        const pc = buildPeerConnection(remotePeerId);
        const channel = pc.createDataChannel('state-sync');
        bindDataChannel(channel);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return bridgeMedia('media-send-signal', buildSignalData('offer', pc.localDescription, remotePeerId));
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
          const payload = signal.payload && typeof signal.payload === 'object' ? signal.payload : null;
          if (!payload || !payload.type || !payload.sdp) return;
          const pc = buildPeerConnection(fromPeerId);
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await flushPendingIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await bridgeMedia('media-send-signal', buildSignalData('answer', pc.localDescription, fromPeerId));
          setStatus('Answered offer from ' + fromPeerId);
          return;
        }

        if (signalType === 'answer') {
          const payload = signal.payload && typeof signal.payload === 'object' ? signal.payload : null;
          if (!state.pc || !payload || !payload.type || !payload.sdp) return;
          await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
          await flushPendingIce(state.pc);
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
          appendLog('remote disconnect', { fromPeerId });
          closePeerConnection();
          setStatus('Remote peer disconnected');
        }
      }

      document.getElementById('createBtn').addEventListener('click', () => {
        run('media-create-session', createSession).catch(() => {});
      });
      document.getElementById('joinBtn').addEventListener('click', () => {
        run('media-join-session', joinSession).catch(() => {});
      });
      document.getElementById('connectBtn').addEventListener('click', () => {
        run('create-offer', createOfferConnection).catch(() => {});
      });
      document.getElementById('disconnectBtn').addEventListener('click', () => {
        run('disconnect', async () => {
          const remotePeerId = state.remotePeerId || currentRemotePeerId();
          if (remotePeerId) {
            await bridgeMedia('media-send-signal', buildSignalData('bye', null, remotePeerId), 8000);
          }
          closePeerConnection();
          return { ok: true };
        }).catch(() => {});
      });
      document.getElementById('listBtn').addEventListener('click', () => {
        run('media-list-sessions', () => bridgeMedia('media-list-sessions', {})).catch(() => {});
      });
      document.getElementById('statsBtn').addEventListener('click', () => {
        run('media-get-stats', () => bridgeMedia('media-get-stats', {})).catch(() => {});
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
        if (messageType.startsWith('media-')) {
          appendLog('event:' + messageType, detail);
        }
      });

      window.addEventListener('keydown', (event) => {
        if (event.key.startsWith('Arrow')) state.pressed.add(event.key);
      });
      window.addEventListener('keyup', (event) => {
        if (event.key.startsWith('Arrow')) state.pressed.delete(event.key);
      });

      function initScene() {
        if (!window.THREE || typeof window.THREE.Scene !== 'function') {
          const source = String(threeRuntimeState.source || 'unknown');
          const error = String((threeRuntimeState.result && threeRuntimeState.result.error) || threeRuntimeState.loadError || threeRuntimeState.startupError || 'window.THREE undefined');
          const guidance = source === 'bundled-module'
            ? 'Bundled Three.js module failed to initialize.'
            : 'CDN fallback could not be loaded. Check network access to unpkg.';
          sceneRoot.innerHTML = '<div style="padding:14px;color:#e9f1ff">Three.js failed to load. ' + guidance + '</div>';
          appendLog('threejs', {
            loaded: false,
            reason: 'window.THREE undefined',
            runtimeSource: source,
            runtimeError: error
          });
          return;
        }

        const { THREE } = window;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x040913);

        const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 100);
        camera.position.set(0, 5, 8);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        sceneRoot.appendChild(renderer.domElement);

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(5, 10, 4);
        scene.add(dir);

        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(24, 24),
          new THREE.MeshStandardMaterial({ color: 0x0d1d36, roughness: 0.92, metalness: 0.02 })
        );
        floor.rotation.x = -Math.PI / 2;
        scene.add(floor);

        const localCube = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.8, 0.8),
          new THREE.MeshStandardMaterial({ color: 0x38e27e })
        );
        localCube.position.y = 0.45;
        scene.add(localCube);

        const remoteCube = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.8, 0.8),
          new THREE.MeshStandardMaterial({ color: 0xf86a6a })
        );
        remoteCube.position.set(state.remotePosition.x, 0.45, state.remotePosition.z);
        scene.add(remoteCube);

        function resize() {
          const width = Math.max(320, sceneRoot.clientWidth);
          const height = Math.max(380, sceneRoot.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        }

        function animate() {
          const speed = 0.06;
          if (state.pressed.has('ArrowUp')) state.localPosition.z -= speed;
          if (state.pressed.has('ArrowDown')) state.localPosition.z += speed;
          if (state.pressed.has('ArrowLeft')) state.localPosition.x -= speed;
          if (state.pressed.has('ArrowRight')) state.localPosition.x += speed;

          localCube.position.set(state.localPosition.x, 0.45, state.localPosition.z);
          remoteCube.position.set(state.remotePosition.x, 0.45, state.remotePosition.z);

          sendStateSnapshot();
          renderer.render(scene, camera);
          requestAnimationFrame(animate);
        }

        window.addEventListener('resize', resize);
        resize();
        animate();
        appendLog('threejs', { loaded: true });
      }

      window.addEventListener('beforeunload', () => {
        closePeerConnection();
      });

      Promise.resolve(window.__HT_THREE_READY)
        .then((result) => {
          if (!result || result.ok !== true) {
            initScene();
            return;
          }
          initScene();
        })
        .catch(() => {
          initScene();
        });
      appendLog('ready', {
        pluginId: '${pluginId}',
        sessionId: currentSessionId(),
        message: 'Join same session from another app instance, then connect peers for real WebRTC datachannel sync.'
      });
      setStatus('Ready');
    </script>
  </body>
</html>`
}

export async function handleInvoke(payload = {}, context = {}) {
  if (payload?.type === 'render-route') {
    return {
      html: renderPage(payload, context)
    }
  }
  return {
    ok: true,
    payload
  }
}

export async function activate(context = {}) {
  context?.emit?.('threejs-multiplayer-demo-activated', {
    pluginId: context?.pluginId || null,
    pluginVersion: context?.pluginVersion || null
  })
}
