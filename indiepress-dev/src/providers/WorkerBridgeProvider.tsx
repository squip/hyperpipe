import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import * as nip19 from '@nostr/tools/nip19'
import {
  electronIpc,
  WorkerStartResult,
  GatewayLogEntry,
  GatewayStatus,
  PublicGatewayStatus,
  RelayEntry
} from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import { useNostr } from '@/providers/NostrProvider'

type WorkerStatusPhase =
  | 'starting'
  | 'waiting-config'
  | 'config-applied'
  | 'initializing'
  | 'gateway-starting'
  | 'gateway-ready'
  | 'relays-loading'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error'

type WorkerStatusState = {
  user: { pubkeyHex?: string | null; userKey?: string | null } | null
  app: { initialized: boolean; mode: string | null; shuttingDown: boolean }
  gateway: { ready: boolean; running: boolean }
  relays: { expected: number; active: number }
}

type WorkerStatusV1 = {
  type: 'status'
  v: 1
  ts: number
  sessionId: string
  phase: WorkerStatusPhase
  message: string
  state: WorkerStatusState
  error?: { message: string; stack?: string | null }
}

type WorkerConfigAppliedV1 = {
  type: 'config-applied'
  v: 1
  ts: number
  sessionId: string
  data: unknown
}

type WorkerLifecycle =
  | 'unavailable'
  | 'needs-auth'
  | 'idle'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'restarting'
  | 'error'

type PublicGatewayTokenResult = {
  relayKey: string
  token: string
  connectionUrl: string
  expiresAt?: number
  ttlSeconds?: number
  gatewayPath?: string
  baseUrl?: string
  issuedForPubkey?: string
  refreshAfter?: number | null
  sequence?: string | null
}

type JoinAuthProgress = 'request' | 'verify' | 'complete'

type JoinFlowPhase =
  | 'idle'
  | 'starting'
  | 'request'
  | 'verify'
  | 'complete'
  | 'success'
  | 'error'

type JoinFlowState = {
  publicIdentifier: string
  phase: JoinFlowPhase
  startedAt: number
  updatedAt: number
  hostPeers?: string[]
  hostPeer?: string | null
  relayKey?: string | null
  authToken?: string | null
  relayUrl?: string | null
  error?: string | null
  writable?: boolean
  expectedWriterActive?: boolean | null
  writableAt?: number | null
  mode?: string | null
  provisional?: boolean | null
}

type JoinFlowWritableCacheEntry = {
  writable: boolean
  writableAt: number | null
  expectedWriterActive?: boolean | null
  mode?: string | null
  updatedAt: number
}

type RelayCreateRequest = {
  name: string
  description?: string
  isPublic?: boolean
  isOpen?: boolean
  fileSharing?: boolean
}

type RelayCreatedPayload = {
  success: boolean
  relayKey?: string
  publicIdentifier?: string
  relayUrl?: string
  authToken?: string
  error?: string
  name?: string
  description?: string
  isPublic?: boolean
  isOpen?: boolean
  fileSharing?: boolean
  gatewayRegistration?: string
  registrationError?: string
  members?: string[]
}

type InviteProof = {
  payload?: {
    relayKey?: string | null
    publicIdentifier?: string | null
    inviteePubkey?: string | null
    authToken?: string | null
    issuedAt?: number | null
    version?: number | null
  }
  signature?: string | null
  scheme?: string | null
} | null

type WorkerBridgeContextValue = {
  isElectron: boolean
  ready: boolean
  lifecycle: WorkerLifecycle
  readinessMessage: string
  autostartEnabled: boolean
  setAutostartEnabled: (enabled: boolean) => void
  sessionStopRequested: boolean
  statusV1: WorkerStatusV1 | null
  configAppliedV1: WorkerConfigAppliedV1 | null
  relays: RelayEntry[]
  gatewayStatus: GatewayStatus | null
  publicGatewayStatus: PublicGatewayStatus | null
  publicGatewayToken: PublicGatewayTokenResult | null
  joinFlows: Record<string, JoinFlowState>
  gatewayLogs: GatewayLogEntry[]
  workerStdout: string[]
  workerStderr: string[]
  lastError: string | null
  getRelayPeerCount: (identifier?: string | null) => number
  getRelayPeerSet: (identifier?: string | null) => Set<string>
  isMemberOnline: (pubkey: string, identifier?: string | null) => boolean
  startWorker: () => Promise<void>
  stopWorker: () => Promise<void>
  restartWorker: () => Promise<void>
  sendToWorker: (message: unknown) => Promise<unknown>
  createRelay: (data: RelayCreateRequest) => Promise<RelayCreatedPayload>
  startJoinFlow: (
    publicIdentifier: string,
    opts?: {
      fileSharing?: boolean
      isOpen?: boolean
      token?: string
      relayKey?: string | null
      relayUrl?: string | null
      inviteProof?: InviteProof
      openJoin?: boolean
    }
  ) => Promise<void>
  clearJoinFlow: (publicIdentifier: string) => void
}

const WorkerBridgeContext = createContext<WorkerBridgeContextValue | undefined>(undefined)

const MAX_LOGS = 500
const MAX_OUTPUT_LINES = 250
const AUTOSTART_KEY = 'hypertuna_worker_autostart_enabled'
const RESTART_DELAYS_MS = [1000, 3000, 10000, 30000]

function makeRequestId(prefix = 'req') {
  return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

function normalizeJoinFlowKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return isHex64(trimmed) ? trimmed.toLowerCase() : trimmed
}

function readAutostartEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem(AUTOSTART_KEY)
    if (stored == null) return true
    return stored === '1' || stored === 'true'
  } catch (_) {
    return true
  }
}

function phaseToLifecycle(phase: WorkerStatusPhase): WorkerLifecycle {
  switch (phase) {
    case 'starting':
    case 'waiting-config':
      return 'starting'
    case 'config-applied':
    case 'initializing':
    case 'gateway-starting':
    case 'gateway-ready':
    case 'relays-loading':
      return 'initializing'
    case 'ready':
      return 'ready'
    case 'stopping':
      return 'stopping'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
  }
}

function readinessMessageForStatus(status: WorkerStatusV1 | null): string {
  if (!status) return 'Stopped'

  const active = status.state?.relays?.active ?? 0
  const expected = status.state?.relays?.expected ?? 0
  const gatewayReady = status.state?.gateway?.ready ?? false

  switch (status.phase) {
    case 'starting':
      return 'Starting Hypertuna worker…'
    case 'waiting-config':
      return 'Waiting for account config…'
    case 'config-applied':
      return 'Config applied. Initializing…'
    case 'initializing':
      return 'Initializing relay server…'
    case 'gateway-starting':
      return 'Starting gateway…'
    case 'gateway-ready':
      return gatewayReady ? 'Gateway ready.' : 'Gateway not ready (timeout).'
    case 'relays-loading':
      return 'Loading relays…'
    case 'ready': {
      const suffix = expected > 0 ? ` (${active}/${expected} relays active)` : ''
      const gatewaySuffix = gatewayReady ? '' : ' (gateway not ready)'
      return `Ready${suffix}${gatewaySuffix}`
    }
    case 'stopping':
      return 'Stopping…'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return status.error?.message ? `Error: ${status.error.message}` : 'Error'
  }
}

export function WorkerBridgeProvider({ children }: PropsWithChildren) {
  const nostr = useNostr()
  const pubkeyHex = nostr.pubkey
  const nsecHex = nostr.nsecHex
  const userKey = useMemo(() => (pubkeyHex ? pubkeyHex.toLowerCase() : null), [pubkeyHex])
  const identityReady = isHex64(pubkeyHex) && isHex64(nsecHex)

  const [autostartEnabled, setAutostartEnabledState] = useState(readAutostartEnabled)
  const [sessionStopRequested, setSessionStopRequested] = useState(false)
  const [lifecycle, setLifecycle] = useState<WorkerLifecycle>(() =>
    isElectron() ? 'idle' : 'unavailable'
  )
  const [statusV1, setStatusV1] = useState<WorkerStatusV1 | null>(null)
  const [configAppliedV1, setConfigAppliedV1] = useState<WorkerConfigAppliedV1 | null>(null)
  const [relays, setRelays] = useState<RelayEntry[]>([])
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [publicGatewayStatus, setPublicGatewayStatus] = useState<PublicGatewayStatus | null>(null)
  const [publicGatewayToken, setPublicGatewayToken] = useState<PublicGatewayTokenResult | null>(null)
  const [joinFlows, setJoinFlows] = useState<Record<string, JoinFlowState>>({})
  const [gatewayLogs, setGatewayLogs] = useState<GatewayLogEntry[]>([])
  const [workerStdout, setWorkerStdout] = useState<string[]>([])
  const [workerStderr, setWorkerStderr] = useState<string[]>([])
  const [lastError, setLastError] = useState<string | null>(null)
  const [peerRelayMap, setPeerRelayMap] = useState<
    Map<
      string,
      {
        peers: Set<string>
        peerCount: number
        status?: string
        lastActive?: number | string | null
        createdAt?: number | string | null
        metadata?: unknown
      }
    >
  >(new Map())
  const [peerDetails, setPeerDetails] = useState<
    Map<
      string,
      {
        nostrPubkeyHex?: string | null
        relays?: string[]
        relayCount?: number
        lastSeen?: number | string | null
        status?: string
        mode?: string | null
        address?: string | null
      }
    >
  >(new Map())

  const restartAttemptRef = useRef(0)
  const restartTimeoutRef = useRef<number | null>(null)
  const lastIdentityRef = useRef<{ pubkeyHex: string | null; nsecHex: string | null; userKey: string | null } | null>(null)
  const warmSessionIdsRef = useRef(new Set<string>())
  const inFlightStartRef = useRef(false)
  const autostartEnabledRef = useRef(autostartEnabled)
  const sessionStopRequestedRef = useRef(sessionStopRequested)
  const identityReadyRef = useRef(identityReady)
  const joinFlowWritableCacheRef = useRef<Map<string, JoinFlowWritableCacheEntry>>(new Map())
  const relayCreateResolversRef = useRef<
    Array<{
      resolve: (payload: RelayCreatedPayload) => void
      reject: (err: Error) => void
      timeoutId: number
    }>
  >([])
  const pendingRepliesRef = useRef<
    Map<
      string,
      {
        resolve: (value: any) => void
        reject: (err: Error) => void
        timeoutId: number
        type: string
      }
    >
  >(new Map())

  useEffect(() => {
    autostartEnabledRef.current = autostartEnabled
  }, [autostartEnabled])

  useEffect(() => {
    sessionStopRequestedRef.current = sessionStopRequested
  }, [sessionStopRequested])

  useEffect(() => {
    identityReadyRef.current = identityReady
  }, [identityReady])

  const clearRestartTimeout = useCallback(() => {
    if (restartTimeoutRef.current == null) return
    window.clearTimeout(restartTimeoutRef.current)
    restartTimeoutRef.current = null
  }, [])

  const applyPeerTelemetry = useCallback((status: GatewayStatus | null | undefined) => {
    if (!status) {
      setPeerRelayMap(new Map())
      setPeerDetails(new Map())
      return
    }
    if (status.peerRelayMap) {
      const next = new Map<
        string,
        {
          peers: Set<string>
          peerCount: number
          status?: string
          lastActive?: number | string | null
          createdAt?: number | string | null
          metadata?: unknown
        }
      >()
      Object.entries(status.peerRelayMap).forEach(([identifier, info]) => {
        if (!identifier) return
        const peerArr = Array.isArray(info?.peers) ? info.peers : []
        next.set(identifier, {
          peers: new Set(peerArr.filter(Boolean).map((p) => String(p))),
          peerCount:
            typeof info?.peerCount === 'number'
              ? info.peerCount
              : peerArr.filter(Boolean).length,
          status: info?.status,
          lastActive: info?.lastActive ?? null,
          createdAt: info?.createdAt ?? null,
          metadata: info?.metadata
        })
      })
      console.info('[WorkerBridge] peerRelayMap keys', Array.from(next.keys()))
      setPeerRelayMap(next)
    }
    if (status.peerDetails) {
      const nextDetails = new Map<
        string,
        {
          nostrPubkeyHex?: string | null
          relays?: string[]
          relayCount?: number
          lastSeen?: number | string | null
          status?: string
          mode?: string | null
          address?: string | null
        }
      >()
      Object.entries(status.peerDetails).forEach(([key, info]) => {
        if (!key) return
        nextDetails.set(key, {
          nostrPubkeyHex: info?.nostrPubkeyHex || null,
          relays: Array.isArray(info?.relays) ? info.relays : [],
          relayCount:
            typeof info?.relayCount === 'number'
              ? info.relays?.length ?? 0
              : info?.relayCount,
          lastSeen: info?.lastSeen ?? null,
          status: info?.status,
          mode: info?.mode ?? null,
          address: info?.address ?? null
        })
      })
      console.info('[WorkerBridge] peerDetails keys', Array.from(nextDetails.keys()))
      setPeerDetails(nextDetails)
    }
  }, [])

  const setAutostartEnabled = useCallback((enabled: boolean) => {
    autostartEnabledRef.current = enabled
    setAutostartEnabledState(enabled)
    try {
      window.localStorage.setItem(AUTOSTART_KEY, enabled ? '1' : '0')
    } catch (err) {
      void err
    }
  }, [])

  const buildWorkerConfig = useCallback(() => {
    if (!isHex64(pubkeyHex) || !isHex64(nsecHex)) {
      throw new Error('Hypertuna worker requires a local nsec/ncryptsec account in Electron.')
    }
    if (!userKey) {
      throw new Error('Hypertuna worker requires a userKey for per-account isolation.')
    }
    let nostr_npub: string | null = null
    try {
      nostr_npub = nip19.npubEncode(pubkeyHex.toLowerCase())
    } catch (err) {
      void err
    }
    return {
      nostr_pubkey_hex: pubkeyHex.toLowerCase(),
      nostr_nsec_hex: nsecHex.toLowerCase(),
      nostr_npub: nostr_npub || undefined,
      userKey
    }
  }, [pubkeyHex, nsecHex, userKey])

  const startWorkerInternal = useCallback(
    async ({ resetRestartAttempts }: { resetRestartAttempts: boolean }) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      if (!identityReady) throw new Error('Hypertuna worker requires nsec/ncryptsec login in Electron.')

      if (inFlightStartRef.current) return
      inFlightStartRef.current = true

      clearRestartTimeout()
      if (resetRestartAttempts) restartAttemptRef.current = 0
      setLastError(null)
      setLifecycle('starting')

      try {
        const config = buildWorkerConfig()
        const res: WorkerStartResult = await electronIpc.startWorker(config)
        if (!res?.success) {
          throw new Error(res?.error || 'Failed to start worker')
        }
      } finally {
        inFlightStartRef.current = false
      }
    },
    [buildWorkerConfig, clearRestartTimeout, identityReady]
  )

  const clearJoinFlow = useCallback((publicIdentifier: string) => {
    const key = String(publicIdentifier || '').trim()
    if (!key) return
    setJoinFlows((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const readJoinFlowWritableCache = useCallback(
    (publicIdentifier?: string | null, relayKey?: string | null) => {
      const relayKeyKey = normalizeJoinFlowKey(relayKey)
      if (relayKeyKey) {
        const cached = joinFlowWritableCacheRef.current.get(relayKeyKey)
        if (cached) return cached
      }
      const identifierKey = normalizeJoinFlowKey(publicIdentifier)
      if (identifierKey) {
        const cached = joinFlowWritableCacheRef.current.get(identifierKey)
        if (cached) return cached
      }
      return null
    },
    []
  )

  const updateJoinFlowWritableCache = useCallback(
    (
      publicIdentifier: string | null | undefined,
      relayKey: string | null | undefined,
      patch: Partial<JoinFlowWritableCacheEntry>
    ) => {
      const keys = [normalizeJoinFlowKey(publicIdentifier), normalizeJoinFlowKey(relayKey)]
        .filter(Boolean) as string[]
      if (!keys.length) return null
      const now = Date.now()
      let updated: JoinFlowWritableCacheEntry | null = null
      keys.forEach((key) => {
        const existing = joinFlowWritableCacheRef.current.get(key)
        const next: JoinFlowWritableCacheEntry = {
          writable: existing?.writable ?? false,
          writableAt: existing?.writableAt ?? null,
          expectedWriterActive: existing?.expectedWriterActive ?? null,
          mode: existing?.mode ?? null,
          updatedAt: now,
          ...patch
        }
        joinFlowWritableCacheRef.current.set(key, next)
        updated = next
      })
      return updated
    },
    []
  )

  const startJoinFlowInternal = useCallback(
    async (
      publicIdentifier: string,
      opts?: {
        fileSharing?: boolean
        isOpen?: boolean
        token?: string
        relayKey?: string | null
        relayUrl?: string | null
        inviteProof?: InviteProof
        openJoin?: boolean
      }
    ) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      const identifier = String(publicIdentifier || '').trim()
      if (!identifier || !identifier.includes(':')) {
        throw new Error('Expected a public identifier in the form npub:relayName')
      }

      setJoinFlows((prev) => ({
        ...prev,
        [identifier]: {
          publicIdentifier: identifier,
          phase: 'starting',
          startedAt: Date.now(),
          updatedAt: Date.now(),
          error: null
        }
      }))

      if (!statusV1) {
        await startWorkerInternal({ resetRestartAttempts: false })
      }

      // The gateway is the source of truth for relay host peers. Ensure it's running.
      if (!gatewayStatus?.running) {
        await electronIpc.sendToWorker({ type: 'start-gateway', options: {} }).catch(() => {})
      }

      // Refresh gateway status so peerRelayMap is as current as possible.
      await electronIpc.sendToWorker({ type: 'get-gateway-status' }).catch(() => {})

      const fileSharing = opts?.fileSharing !== false

      // Best-effort host peer discovery fast-path; worker has a fallback too.
      let hostPeers: string[] | undefined
      try {
        const peerRelayMap = gatewayStatus?.peerRelayMap
        const entry =
          peerRelayMap?.[identifier] ||
          (identifier.includes(':') ? peerRelayMap?.[identifier.replace(':', '/')] : null)
        if (Array.isArray(entry?.peers) && entry.peers.length) {
          hostPeers = entry.peers.map((p) => String(p || '').trim()).filter(Boolean)
        }
      } catch (err) {
        void err
      }

      const data: any = {
        publicIdentifier: identifier,
        fileSharing,
        isOpen: typeof opts?.isOpen === 'boolean' ? opts.isOpen : undefined,
        openJoin: opts?.openJoin === true,
        token: opts?.token,
        relayKey: opts?.relayKey || undefined,
        relayUrl: opts?.relayUrl || undefined,
        inviteProof: opts?.inviteProof
      }
      if (hostPeers && hostPeers.length) data.hostPeers = hostPeers

      console.info('[WorkerBridge] startJoinFlow sending to worker', {
        publicIdentifier: identifier,
        hostPeersCount: hostPeers?.length || 0,
        relayKey: opts?.relayKey ? String(opts.relayKey).slice(0, 16) : null,
        relayUrl: opts?.relayUrl ? String(opts.relayUrl).slice(0, 80) : null,
        hasToken: !!opts?.token,
        hasInviteProof: !!opts?.inviteProof,
        inviteProofScheme: opts?.inviteProof?.scheme || null,
        inviteProofVersion: opts?.inviteProof?.payload?.version ?? null,
        inviteProofIssuedAt: opts?.inviteProof?.payload?.issuedAt ?? null,
        isOpen: typeof opts?.isOpen === 'boolean' ? opts.isOpen : null,
        openJoin: opts?.openJoin === true,
        fileSharing
      })

      await electronIpc.sendToWorker({ type: 'start-join-flow', data })

      setJoinFlows((prev) => {
        const current = prev[identifier]
        if (!current) return prev
        return {
          ...prev,
          [identifier]: {
            ...current,
            hostPeers,
            updatedAt: Date.now()
          }
        }
      })
    },
    [gatewayStatus, startWorkerInternal, statusV1]
  )

  const createRelayInternal = useCallback(
    async (data: RelayCreateRequest): Promise<RelayCreatedPayload> => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      if (!data?.name?.trim()) throw new Error('Relay name is required')

      if (!statusV1) {
        await startWorkerInternal({ resetRestartAttempts: false })
      }

      return await new Promise<RelayCreatedPayload>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          const pending = relayCreateResolversRef.current
          const idx = pending.findIndex((r) => r.timeoutId === timeoutId)
          if (idx >= 0) pending.splice(idx, 1)
          reject(new Error('Timed out waiting for relay-created'))
        }, 60_000)

        relayCreateResolversRef.current.push({
          timeoutId,
          resolve: (payload) => {
            window.clearTimeout(timeoutId)
            resolve(payload)
          },
          reject: (err) => {
            window.clearTimeout(timeoutId)
            reject(err)
          }
        })

        electronIpc
          .sendToWorker({ type: 'create-relay', data })
          .then((res) => {
            if (res?.success) return
            const pending = relayCreateResolversRef.current
            const current = pending.find((r) => r.timeoutId === timeoutId)
            if (current) {
              pending.splice(pending.indexOf(current), 1)
              window.clearTimeout(timeoutId)
              current.reject(new Error(res?.error || 'Worker rejected create-relay'))
            } else {
              reject(new Error(res?.error || 'Worker rejected create-relay'))
            }
          })
          .catch((err) => {
            const pending = relayCreateResolversRef.current
            const current = pending.find((r) => r.timeoutId === timeoutId)
            if (current) {
              pending.splice(pending.indexOf(current), 1)
              window.clearTimeout(timeoutId)
              current.reject(err instanceof Error ? err : new Error(String(err)))
            } else {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
      })
    },
    [startWorkerInternal, statusV1]
  )

  const warmWorkerState = useCallback(
    async (sessionId: string) => {
      if (warmSessionIdsRef.current.has(sessionId)) return
      warmSessionIdsRef.current.add(sessionId)

      try {
        const [gwStatus, gwLogs, pgStatus] = await Promise.allSettled([
          electronIpc.getGatewayStatus(),
          electronIpc.getGatewayLogs(),
          electronIpc.getPublicGatewayStatus()
        ])

        if (gwStatus.status === 'fulfilled' && gwStatus.value?.success) {
          const status = gwStatus.value.status || null
          setGatewayStatus(status)
          applyPeerTelemetry(status)
        }
        if (gwLogs.status === 'fulfilled' && gwLogs.value?.success && Array.isArray(gwLogs.value.logs)) {
          setGatewayLogs(gwLogs.value.logs.slice(-MAX_LOGS))
        }
        if (pgStatus.status === 'fulfilled' && pgStatus.value?.success) {
          setPublicGatewayStatus(pgStatus.value.status || null)
        }
      } catch (err) {
        void err
      }

      electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})
    },
    [applyPeerTelemetry, setGatewayLogs, setGatewayStatus, setPublicGatewayStatus]
  )

  const stopWorkerInternal = useCallback(
    async ({ markSessionStopped }: { markSessionStopped: boolean }) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      clearRestartTimeout()
      restartAttemptRef.current = 0
      warmSessionIdsRef.current.clear()
      if (markSessionStopped) {
        sessionStopRequestedRef.current = true
        setSessionStopRequested(true)
      }

      setLifecycle('stopping')
      setLastError(null)

      const res = await electronIpc.stopWorker()
      if (!res?.success) {
        setLastError(res?.error || 'Failed to stop worker')
      }

      setStatusV1(null)
      setConfigAppliedV1(null)
      setRelays([])
      setGatewayStatus(null)
      setPublicGatewayStatus(null)
      setPublicGatewayToken(null)
      setJoinFlows({})
      applyPeerTelemetry(null)
      relayCreateResolversRef.current.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId)
        reject(new Error('Worker stopped'))
      })
      relayCreateResolversRef.current = []
      setLifecycle('stopped')
    },
    [applyPeerTelemetry, clearRestartTimeout]
  )

  const scheduleAutoRestart = useCallback(() => {
    clearRestartTimeout()

    const attempt = restartAttemptRef.current + 1
    restartAttemptRef.current = attempt
    const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)]

    if (attempt > RESTART_DELAYS_MS.length) {
      setLifecycle('error')
      setLastError('Worker crashed repeatedly. Click Restart to try again.')
      return
    }

    setLifecycle('restarting')
    setLastError(`Worker exited. Restarting in ${Math.round(delay / 1000)}s (attempt ${attempt})…`)

    restartTimeoutRef.current = window.setTimeout(() => {
      startWorkerInternal({ resetRestartAttempts: false }).catch((err) => {
        setLifecycle('error')
        setLastError(err?.message || String(err))
      })
    }, delay)
  }, [clearRestartTimeout, startWorkerInternal])

  useEffect(() => {
    if (!isElectron()) return

    const unsubscribers: Array<() => void> = []

    unsubscribers.push(
      electronIpc.onWorkerMessage((msg) => {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'status' && msg.v === 1) {
          const status = msg as WorkerStatusV1
          setStatusV1(status)
          setLifecycle(phaseToLifecycle(status.phase))
          if (status.phase === 'ready') {
            restartAttemptRef.current = 0
          }
          warmWorkerState(status.sessionId)
          return
        }
        if (msg.type === 'config-applied' && msg.v === 1) {
          const applied = msg as WorkerConfigAppliedV1
          setConfigAppliedV1(applied)
          warmWorkerState(applied.sessionId)
          return
        }
        switch (msg.type) {
          case 'relay-update':
            if (Array.isArray(msg.relays)) {
              console.info('[WorkerBridge] relay-update received', msg.relays.map((r: any) => ({
                relayKey: r.relayKey,
                publicIdentifier: r.publicIdentifier,
                connectionUrl: r.connectionUrl,
                userAuthToken: r.userAuthToken,
                requiresAuth: r.requiresAuth
              })))
              setRelays(msg.relays)
            }
            break
          case 'relay-created':
            if (relayCreateResolversRef.current.length) {
              const resolver = relayCreateResolversRef.current.shift()
              if (resolver) {
                const payload = (msg?.data || {}) as RelayCreatedPayload
                if (payload?.success) resolver.resolve(payload)
                else resolver.reject(new Error(payload?.error || 'Failed to create relay'))
              }
            }
            // let relay-update events drive the main list; optionally merge here
            break
          case 'relay-joined':
            // let relay-update events drive the main list; optionally merge here
            break
          case 'relay-disconnected':
            setRelays((prev) => prev.filter((r) => r.relayKey !== msg?.data?.relayKey))
            break
          case 'gateway-status':
            setGatewayStatus(msg.status || null)
            applyPeerTelemetry(msg.status || null)
            break
          case 'gateway-started':
            setGatewayStatus(msg.status || null)
            applyPeerTelemetry(msg.status || null)
            break
          case 'gateway-logs':
            if (Array.isArray(msg.logs)) {
              const next = [...msg.logs].slice(-MAX_LOGS)
              setGatewayLogs(next)
            }
            break
          case 'gateway-log':
            if (msg.entry) {
              const message = typeof msg.entry.message === 'string' ? msg.entry.message : ''
              if (message.includes('Open join pool')) {
                console.info('[GatewayLog]', msg.entry)
              }
              setGatewayLogs((prev) => {
                const next = [...prev, msg.entry]
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
              })
            }
            break
          case 'gateway-stopped':
            setGatewayStatus(msg.status || null)
            applyPeerTelemetry(msg.status || null)
            break
          case 'public-gateway-status':
            setPublicGatewayStatus(msg.state || msg.status || null)
            break
          case 'public-gateway-config':
            // could cache config if needed
            break
          case 'public-gateway-token':
            if (msg.result && typeof msg.result === 'object') {
              setPublicGatewayToken(msg.result as PublicGatewayTokenResult)
            }
            break
          case 'public-gateway-token-error':
            setLastError(msg.error || 'Failed to issue public gateway token')
            break
          case 'members-updated':
          case 'auth-data-removed':
          case 'auth-data-updated':
            electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})
            break
          case 'provision-writer-for-invitee:result':
          case 'provision-writer-for-invitee:error': {
            const requestId = (msg as any)?.requestId
            let matchedKey: string | null = null
            if (requestId && pendingRepliesRef.current.has(requestId)) {
              matchedKey = requestId
            } else {
              for (const [key, entry] of pendingRepliesRef.current.entries()) {
                if (entry.type === 'provision-writer-for-invitee') {
                  matchedKey = key
                  break
                }
              }
            }
            if (matchedKey) {
              const pending = pendingRepliesRef.current.get(matchedKey)
              pendingRepliesRef.current.delete(matchedKey)
              if (pending) {
                window.clearTimeout(pending.timeoutId)
                if (msg.type === 'provision-writer-for-invitee:result') {
                  pending.resolve((msg as any).data ?? null)
                } else {
                  pending.reject(new Error((msg as any)?.error || 'Worker provisioning failed'))
                }
              }
            }
            break
          }
          case 'generate-invite-proof:result':
          case 'generate-invite-proof:error': {
            const requestId = (msg as any)?.requestId
            let matchedKey: string | null = null
            if (requestId && pendingRepliesRef.current.has(requestId)) {
              matchedKey = requestId
            } else {
              for (const [key, entry] of pendingRepliesRef.current.entries()) {
                if (entry.type === 'generate-invite-proof') {
                  matchedKey = key
                  break
                }
              }
            }
            if (matchedKey) {
              const pending = pendingRepliesRef.current.get(matchedKey)
              pendingRepliesRef.current.delete(matchedKey)
              if (pending) {
                window.clearTimeout(pending.timeoutId)
                if (msg.type === 'generate-invite-proof:result') {
                  pending.resolve((msg as any).data ?? null)
                } else {
                  pending.reject(new Error((msg as any)?.error || 'Invite proof generation failed'))
                }
              }
            }
            break
          }
          case 'join-auth-progress': {
            const identifier = msg?.data?.publicIdentifier
            const progress: JoinAuthProgress | null =
              msg?.data?.status === 'request' || msg?.data?.status === 'verify' || msg?.data?.status === 'complete'
                ? msg.data.status
                : null
            if (!identifier || !progress) break
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const cachedWritable = readJoinFlowWritableCache(
                identifier,
                msg?.data?.relayKey || current?.relayKey
              )
              const stickyWritable = current?.writable === true || cachedWritable?.writable === true
              const stickyWritableAt = current?.writableAt ?? cachedWritable?.writableAt ?? null
              const stickyExpectedWriterActive =
                current?.expectedWriterActive ?? cachedWritable?.expectedWriterActive ?? null
              const stickyMode = current?.mode ?? cachedWritable?.mode ?? null
              const nextPhase = current?.phase === 'success' ? 'success' : progress
              if (current?.phase !== nextPhase) {
                console.info('[CJTRACE] join flow progress', {
                  publicIdentifier: identifier,
                  phase: nextPhase,
                  previousPhase: current?.phase || null,
                  relayKey: (msg?.data?.relayKey || current?.relayKey) ? String(msg?.data?.relayKey || current?.relayKey).slice(0, 16) : null,
                  relayUrl: msg?.data?.relayUrl ? String(msg?.data?.relayUrl).slice(0, 80) : current?.relayUrl || null,
                  writable: current?.writable ?? null,
                  expectedWriterActive: stickyExpectedWriterActive ?? null,
                  mode: stickyMode ?? null
                })
              }
              if (cachedWritable?.writable && !current?.writable) {
                console.info('[WorkerBridge] join flow writable cache applied', {
                  publicIdentifier: identifier,
                  relayKey: current?.relayKey ?? null,
                  phase: nextPhase,
                  writableAt: cachedWritable.writableAt,
                  expectedWriterActive: cachedWritable.expectedWriterActive ?? null,
                  mode: cachedWritable.mode ?? null
                })
              }
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: nextPhase,
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: current?.hostPeer ?? null,
                  relayKey: current?.relayKey ?? null,
                  authToken: current?.authToken ?? null,
                  relayUrl: current?.relayUrl ?? null,
                  error: null,
                  mode: stickyMode,
                  provisional: current?.provisional ?? null,
                  writable: stickyWritable ? true : current?.writable,
                  writableAt: stickyWritable ? stickyWritableAt : current?.writableAt ?? null,
                  expectedWriterActive: stickyExpectedWriterActive
                }
              }
            })
            break
          }
          case 'join-auth-success': {
            const identifier = msg?.data?.publicIdentifier
            if (!identifier) break
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const cachedWritable = readJoinFlowWritableCache(
                identifier,
                msg?.data?.relayKey || current?.relayKey
              )
              const stickyWritable = current?.writable === true || cachedWritable?.writable === true
              const stickyWritableAt = current?.writableAt ?? cachedWritable?.writableAt ?? null
              const stickyExpectedWriterActive =
                current?.expectedWriterActive ?? cachedWritable?.expectedWriterActive ?? null
              if (cachedWritable?.writable && !current?.writable) {
                console.info('[WorkerBridge] join flow writable cache applied', {
                  publicIdentifier: identifier,
                  relayKey: msg?.data?.relayKey || current?.relayKey || null,
                  phase: 'success',
                  writableAt: cachedWritable.writableAt,
                  expectedWriterActive: cachedWritable.expectedWriterActive ?? null,
                  mode: cachedWritable.mode ?? null
                })
              }
              console.info('[CJTRACE] join flow success', {
                publicIdentifier: identifier,
                relayKey: (msg?.data?.relayKey || current?.relayKey) ? String(msg?.data?.relayKey || current?.relayKey).slice(0, 16) : null,
                relayUrl: msg?.data?.relayUrl ? String(msg?.data?.relayUrl).slice(0, 80) : current?.relayUrl || null,
                writable: stickyWritable ? true : current?.writable ?? null,
                writableAt: stickyWritable ? stickyWritableAt : current?.writableAt ?? null,
                expectedWriterActive: stickyExpectedWriterActive ?? null,
                mode: msg?.data?.mode ?? current?.mode ?? cachedWritable?.mode ?? null
              })
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: 'success',
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: msg?.data?.hostPeer || null,
                  relayKey: msg?.data?.relayKey || null,
                  authToken: msg?.data?.authToken || null,
                  relayUrl: msg?.data?.relayUrl || null,
                  error: null,
                  mode: msg?.data?.mode ?? current?.mode ?? cachedWritable?.mode ?? null,
                  provisional: msg?.data?.provisional ?? current?.provisional ?? null,
                  writable: stickyWritable ? true : current?.writable,
                  writableAt: stickyWritable ? stickyWritableAt : current?.writableAt ?? null,
                  expectedWriterActive: stickyExpectedWriterActive
                }
              }
            })
            // Let relay-update events hydrate the full list, but trigger a refresh just in case.
            electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})
            break
          }
          case 'join-auth-error': {
            const identifier = msg?.data?.publicIdentifier
            const errorText = msg?.data?.error || 'Join authentication failed'
            if (!identifier) break
            console.info('[CJTRACE] join flow error', {
              publicIdentifier: identifier,
              relayKey: msg?.data?.relayKey ? String(msg?.data?.relayKey).slice(0, 16) : null,
              relayUrl: msg?.data?.relayUrl ? String(msg?.data?.relayUrl).slice(0, 80) : null,
              error: errorText
            })
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: 'error',
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: current?.hostPeer ?? null,
                  relayKey: current?.relayKey ?? null,
                  authToken: current?.authToken ?? null,
                  relayUrl: current?.relayUrl ?? null,
                  error: errorText,
                  mode: current?.mode ?? null,
                  provisional: current?.provisional ?? null
                }
              }
            })
            setLastError(errorText)
            break
          }
          case 'relay-writable': {
            const data = (msg as any)?.data || {}
            const identifier = data.publicIdentifier
            if (!identifier) break
            const isWritable = data.writable === true
            if (isWritable) {
              const writableAt = Date.now()
              updateJoinFlowWritableCache(identifier, data.relayKey ?? null, {
                writable: true,
                writableAt,
                expectedWriterActive: data.expectedWriterActive ?? null,
                mode: data.mode ?? null
              })
              console.info('[WorkerBridge] join flow writable cached', {
                publicIdentifier: identifier,
                relayKey: data.relayKey ?? null,
                writableAt,
                expectedWriterActive: data.expectedWriterActive ?? null,
                mode: data.mode ?? null
              })
            }
            console.info('[WorkerBridge] relay-writable received', {
              publicIdentifier: identifier,
              relayKey: data.relayKey,
              mode: data.mode,
              writable: data.writable,
              expectedWriterActive: data.expectedWriterActive
            })
            console.info('[CJTRACE] relay writable', {
              publicIdentifier: identifier,
              relayKey: data.relayKey ? String(data.relayKey).slice(0, 16) : null,
              relayUrl: data.relayUrl ? String(data.relayUrl).slice(0, 80) : null,
              writable: data.writable === true,
              expectedWriterActive: data.expectedWriterActive ?? null,
              mode: data.mode ?? null
            })
            setJoinFlows((prev) => {
              const current = prev[identifier]
              if (!current) return prev
              if (!isWritable) {
                return {
                  ...prev,
                  [identifier]: {
                    ...current,
                    updatedAt: Date.now(),
                    relayKey: data.relayKey ?? current.relayKey,
                    relayUrl: data.relayUrl ?? current.relayUrl,
                    authToken: data.authToken ?? current.authToken,
                    mode: data.mode ?? current.mode,
                    expectedWriterActive: data.expectedWriterActive ?? current.expectedWriterActive,
                    writable: data.writable ?? current.writable
                  }
                }
              }
              return {
                ...prev,
                [identifier]: {
                  ...current,
                  phase: current.phase === 'error' ? current.phase : 'success',
                  updatedAt: Date.now(),
                  relayKey: data.relayKey ?? current.relayKey,
                  relayUrl: data.relayUrl ?? current.relayUrl,
                  authToken: data.authToken ?? current.authToken,
                  mode: data.mode ?? current.mode,
                  expectedWriterActive: data.expectedWriterActive ?? current.expectedWriterActive,
                  writable: true,
                  writableAt: Date.now()
                }
              }
            })
            break
          }
          case 'error':
          case 'gateway-error':
          case 'public-gateway-error':
            setLastError(msg.message || 'Unknown worker error')
            break
          default:
            break
        }
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerError((err) => {
        setLastError(err?.message || String(err))
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerExit((code) => {
        warmSessionIdsRef.current.clear()
        setStatusV1(null)
        setConfigAppliedV1(null)
        setRelays([])
        setGatewayStatus(null)
        setPublicGatewayStatus(null)
        setPublicGatewayToken(null)
        setJoinFlows({})
        relayCreateResolversRef.current.forEach(({ reject, timeoutId }) => {
          window.clearTimeout(timeoutId)
          reject(new Error(`Worker exited (${code})`))
        })
        relayCreateResolversRef.current = []
        setLifecycle('stopped')

        const message = `Worker exited (${code})`
        if (sessionStopRequestedRef.current) {
          setLastError(message)
          return
        }
        if (!autostartEnabledRef.current) {
          setLastError(message)
          return
        }
        if (!identityReadyRef.current) {
          setLastError(message)
          return
        }
        setLastError(message)
        scheduleAutoRestart()
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerStdout((data) => {
        setWorkerStdout((prev) => {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          const next = [...prev, ...lines]
          return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next
        })
        if (isElectron() && electronIpc.appendLogLine) {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          lines.forEach((line) => {
            electronIpc.appendLogLine(`[${new Date().toISOString()}] [WORKER STDOUT] ${line}\n`).catch(() => {})
          })
        }
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerStderr((data) => {
        setWorkerStderr((prev) => {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          const next = [...prev, ...lines]
          return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next
        })
        if (isElectron() && electronIpc.appendLogLine) {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          lines.forEach((line) => {
            electronIpc.appendLogLine(`[${new Date().toISOString()}] [WORKER STDERR] ${line}\n`).catch(() => {})
          })
        }
      })
    )

    return () => {
      unsubscribers.forEach((u) => {
        try {
          u()
        } catch (err) {
          void err
        }
      })
    }
  }, [scheduleAutoRestart, warmWorkerState])

  useEffect(() => {
    return () => {
      pendingRepliesRef.current.forEach(({ timeoutId }) => window.clearTimeout(timeoutId))
      pendingRepliesRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!isElectron()) {
      setLifecycle('unavailable')
      return
    }

    const next = { pubkeyHex: pubkeyHex ?? null, nsecHex: nsecHex ?? null, userKey }
    const prev = lastIdentityRef.current
    lastIdentityRef.current = next

    const prevReady = prev ? isHex64(prev.pubkeyHex) && isHex64(prev.nsecHex) : false
    const nextReady = identityReady
    const identityChanged = !!(
      prev &&
      (prev.pubkeyHex !== next.pubkeyHex || prev.nsecHex !== next.nsecHex || prev.userKey !== next.userKey)
    )

    const workerIsActive =
      lifecycle === 'starting' ||
      lifecycle === 'initializing' ||
      lifecycle === 'ready' ||
      lifecycle === 'restarting'

    if (identityChanged && prevReady) {
      if (!nextReady) {
        if (workerIsActive) {
          stopWorkerInternal({ markSessionStopped: false }).catch(() => {})
        }
        setLifecycle('needs-auth')
        return
      }

      if (workerIsActive) {
        stopWorkerInternal({ markSessionStopped: false })
          .catch(() => {})
          .finally(() => {
            startWorkerInternal({ resetRestartAttempts: true }).catch((err) => {
              setLifecycle('error')
              setLastError(err?.message || String(err))
            })
          })
        return
      }

      if (autostartEnabled && !sessionStopRequested) {
        startWorkerInternal({ resetRestartAttempts: true }).catch(() => {})
      }
      return
    }

    if (!nextReady) {
      setLifecycle('needs-auth')
      return
    }

    if (autostartEnabled && !sessionStopRequested && !workerIsActive && !statusV1) {
      startWorkerInternal({ resetRestartAttempts: true }).catch(() => {})
    }
  }, [
    autostartEnabled,
    identityReady,
    lifecycle,
    nsecHex,
    pubkeyHex,
    sessionStopRequested,
    startWorkerInternal,
    statusV1,
    stopWorkerInternal
  ])

  useEffect(() => {
    if (!isElectron()) return
    if (lifecycle !== 'ready') return

    let cancelled = false
    const poll = async () => {
      try {
        const res = await electronIpc.getGatewayStatus()
        if (!res?.success) return
        if (cancelled) return
        setGatewayStatus(res.status || null)
        applyPeerTelemetry(res.status || null)
      } catch (err) {
        void err
      }
    }

    poll()
    const id = window.setInterval(poll, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [applyPeerTelemetry, lifecycle])

  const ready = statusV1?.phase === 'ready'

  const readinessMessage = useMemo(() => {
    if (!isElectron()) return 'Desktop-only'
    if (!identityReady) return 'Login with nsec/ncryptsec to enable Hypertuna services.'
    if (lifecycle === 'restarting' || lifecycle === 'starting' || lifecycle === 'initializing') {
      return readinessMessageForStatus(statusV1)
    }
    if (lifecycle === 'ready') return readinessMessageForStatus(statusV1)
    if (lifecycle === 'stopping') return 'Stopping…'
    if (lifecycle === 'stopped' || lifecycle === 'idle') return 'Stopped'
    if (lifecycle === 'error') return lastError ? `Error: ${lastError}` : readinessMessageForStatus(statusV1)
    return readinessMessageForStatus(statusV1)
  }, [identityReady, lastError, lifecycle, statusV1])

  const getRelayPeerEntry = useCallback(
    (identifier?: string | null) => {
      if (!identifier) return null
      const candidates = new Set<string>()
      candidates.add(identifier)
      candidates.add(identifier.replace(':', '/'))
      // strip protocol and trailing slash
      try {
        const parsed = new URL(identifier)
        candidates.add(parsed.host + parsed.pathname)
        candidates.add(parsed.host)
      } catch (_) {
        void _
      }
      let entry: typeof peerRelayMap extends Map<string, infer V> ? V | null : null = null
      for (const key of candidates) {
        const found = peerRelayMap.get(key)
        if (found) {
          entry = found
          break
        }
      }
      if (entry) return entry
      // fuzzy fallback: look for keys that contain the identifier fragment
      for (const [key, value] of peerRelayMap.entries()) {
        if (!identifier) continue
        if (key.includes(identifier) || identifier.includes(key)) {
          return value
        }
      }
      return null
    },
    [peerRelayMap]
  )

  const getRelayPeerCount = useCallback(
    (identifier?: string | null) => {
      const entry = getRelayPeerEntry(identifier)
      if (!entry) return 0
      if (typeof entry.peerCount === 'number') return entry.peerCount
      return entry.peers?.size ?? 0
    },
    [getRelayPeerEntry]
  )

  const getRelayPeerSet = useCallback(
    (identifier?: string | null) => {
      const entry = getRelayPeerEntry(identifier)
      if (!entry) return new Set<string>()
      return entry.peers instanceof Set ? entry.peers : new Set<string>()
    },
    [getRelayPeerEntry]
  )

  const isMemberOnline = useCallback(
    (pubkey: string, identifier?: string | null) => {
      if (!pubkey) return false
      const normalized = pubkey.toLowerCase()
      const peers = getRelayPeerSet(identifier)
      for (const peerKey of peers) {
        const detail = peerDetails.get(peerKey)
        if (!detail?.nostrPubkeyHex) continue
        if (detail.nostrPubkeyHex.toLowerCase() === normalized) return true
      }
      return false
    },
    [getRelayPeerSet, peerDetails]
  )

  const value = useMemo<WorkerBridgeContextValue>(
    () => ({
      isElectron: isElectron(),
      ready,
      lifecycle,
      readinessMessage,
      autostartEnabled,
      setAutostartEnabled,
      sessionStopRequested,
      statusV1,
      configAppliedV1,
      relays,
      gatewayStatus,
      publicGatewayStatus,
      publicGatewayToken,
      joinFlows,
      gatewayLogs,
      workerStdout,
      workerStderr,
      lastError,
      getRelayPeerCount,
      getRelayPeerSet,
      isMemberOnline,
      startWorker: async () => {
        setSessionStopRequested(false)
        await startWorkerInternal({ resetRestartAttempts: true })
      },
      stopWorker: async () => {
        await stopWorkerInternal({ markSessionStopped: true })
      },
      restartWorker: async () => {
        setSessionStopRequested(false)
        await stopWorkerInternal({ markSessionStopped: false }).catch(() => {})
        await startWorkerInternal({ resetRestartAttempts: true })
      },
      sendToWorker: async (message: unknown) => {
        if (!isElectron()) throw new Error('Electron IPC unavailable')
        if (!statusV1) {
          await startWorkerInternal({ resetRestartAttempts: false })
        }
        const msgType = (message as any)?.type
        const expectsReply = msgType === 'provision-writer-for-invitee' || msgType === 'generate-invite-proof'
        if (expectsReply) {
          const requestId =
            (message as any)?.requestId ||
            makeRequestId(msgType === 'generate-invite-proof' ? 'invite-proof' : 'provision-writer')
          const payload = { ...(message as any), requestId }
          const promise = new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
              pendingRepliesRef.current.delete(requestId)
              reject(new Error('Worker reply timeout'))
            }, 15000)
            pendingRepliesRef.current.set(requestId, {
              resolve,
              reject,
              timeoutId,
              type: msgType
            })
          })
          await electronIpc.sendToWorker(payload)
          return promise
        }

        const res = await electronIpc.sendToWorker(message)
        if (res && typeof res === 'object' && 'success' in res && (res as any).success === false) {
          throw new Error((res as any).error || 'Worker rejected message')
        }
        return res
      },
      createRelay: async (data: RelayCreateRequest) => {
        return await createRelayInternal(data)
      },
      startJoinFlow: async (
        publicIdentifier: string,
        opts?: {
          fileSharing?: boolean
          token?: string
          relayKey?: string | null
          relayUrl?: string | null
          inviteProof?: InviteProof
          openJoin?: boolean
        }
      ) => {
        await startJoinFlowInternal(publicIdentifier, opts)
      },
      clearJoinFlow
    }),
    [
      autostartEnabled,
      clearJoinFlow,
      configAppliedV1,
      gatewayLogs,
      gatewayStatus,
      joinFlows,
      lastError,
      lifecycle,
      createRelayInternal,
      publicGatewayStatus,
      publicGatewayToken,
      readinessMessage,
      ready,
      relays,
      sessionStopRequested,
      setAutostartEnabled,
      startJoinFlowInternal,
      startWorkerInternal,
      statusV1,
      stopWorkerInternal,
      workerStderr,
      workerStdout
    ]
  )

  return <WorkerBridgeContext.Provider value={value}>{children}</WorkerBridgeContext.Provider>
}

export function useWorkerBridge() {
  const ctx = useContext(WorkerBridgeContext)
  if (!ctx) throw new Error('useWorkerBridge must be used within WorkerBridgeProvider')
  return ctx
}
