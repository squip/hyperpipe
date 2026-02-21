import { useEffect, useRef } from 'react'
import { useGroups } from '@/providers/GroupsProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { electronIpc } from '@/services/electron-ipc.service'
import client from '@/services/client.service'
import * as nip19 from '@nostr/tools/nip19'

type MatrixLogEntry = {
  ts: number
  channel: 'worker-stdout' | 'worker-stderr' | 'worker-message'
  data: unknown
}

type MatrixJoinStartArgs = {
  groupId: string
  relayUrl?: string | null
  relayKey?: string | null
  fileSharing?: boolean
  isOpen?: boolean
  openJoin?: boolean
  token?: string | null
  gatewayOrigins?: string[]
  blindPeer?: {
    publicKey?: string | null
    encryptionKey?: string | null
    replicationTopic?: string | null
    maxBytes?: number | null
  } | null
  cores?: { key: string; role?: string | null }[]
  writerCore?: string | null
  writerCoreHex?: string | null
  autobaseLocal?: string | null
  writerSecret?: string | null
  discoveryTopic?: string | null
  hostPeerKeys?: string[]
  memberPeerKeys?: string[]
  writerIssuerPubkey?: string | null
  fastForward?: {
    key?: string | null
    length?: number | null
    signedLength?: number | null
    timeoutMs?: number | null
  } | null
}

type MatrixWaitArgs = {
  publicIdentifier: string
  relayKey?: string | null
  timeoutMs?: number
  intervalMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

const resolveHintedList = (values?: string[] | null) =>
  Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    )
  )

const decodeNpubToHex = (value?: string | null): string | undefined => {
  const trimmed = String(value || '').trim()
  if (!trimmed || !trimmed.startsWith('npub')) return undefined
  try {
    const decoded = nip19.decode(trimmed)
    return decoded.type === 'npub' && isHex64(decoded.data) ? decoded.data.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

export default function MatrixE2EBridge({ enabled }: { enabled: boolean }): null {
  const { nsecLogin, pubkey, nsecHex, publish } = useNostr()
  const { createHypertunaRelayGroup, sendInvites, fetchGroupDetail, getProvisionalGroupMetadata, invites } = useGroups()
  const {
    ready,
    startWorker,
    stopWorker,
    restartWorker,
    startJoinFlow,
    joinFlows,
    relays,
    sendToWorker
  } = useWorkerBridge()

  const readyRef = useRef(ready)
  const pubkeyRef = useRef(pubkey)
  const nsecHexRef = useRef(nsecHex)
  const createGroupRef = useRef(createHypertunaRelayGroup)
  const sendInvitesRef = useRef(sendInvites)
  const fetchGroupDetailRef = useRef(fetchGroupDetail)
  const getProvisionalGroupMetadataRef = useRef(getProvisionalGroupMetadata)
  const startWorkerRef = useRef(startWorker)
  const stopWorkerRef = useRef(stopWorker)
  const restartWorkerRef = useRef(restartWorker)
  const startJoinFlowRef = useRef(startJoinFlow)
  const sendToWorkerRef = useRef(sendToWorker)
  const publishRef = useRef(publish)
  const joinFlowsRef = useRef(joinFlows)
  const relaysRef = useRef(relays)
  const invitesRef = useRef(invites)
  const logBufferRef = useRef<MatrixLogEntry[]>([])
  const logSinksRef = useRef<Set<(entry: MatrixLogEntry) => void>>(new Set())

  useEffect(() => {
    readyRef.current = ready
  }, [ready])
  useEffect(() => {
    pubkeyRef.current = pubkey
  }, [pubkey])
  useEffect(() => {
    nsecHexRef.current = nsecHex
  }, [nsecHex])
  useEffect(() => {
    createGroupRef.current = createHypertunaRelayGroup
  }, [createHypertunaRelayGroup])
  useEffect(() => {
    sendInvitesRef.current = sendInvites
  }, [sendInvites])
  useEffect(() => {
    fetchGroupDetailRef.current = fetchGroupDetail
  }, [fetchGroupDetail])
  useEffect(() => {
    getProvisionalGroupMetadataRef.current = getProvisionalGroupMetadata
  }, [getProvisionalGroupMetadata])
  useEffect(() => {
    startWorkerRef.current = startWorker
  }, [startWorker])
  useEffect(() => {
    stopWorkerRef.current = stopWorker
  }, [stopWorker])
  useEffect(() => {
    restartWorkerRef.current = restartWorker
  }, [restartWorker])
  useEffect(() => {
    startJoinFlowRef.current = startJoinFlow
  }, [startJoinFlow])
  useEffect(() => {
    publishRef.current = publish
  }, [publish])
  useEffect(() => {
    sendToWorkerRef.current = sendToWorker
  }, [sendToWorker])
  useEffect(() => {
    joinFlowsRef.current = joinFlows
  }, [joinFlows])
  useEffect(() => {
    relaysRef.current = relays
  }, [relays])
  useEffect(() => {
    invitesRef.current = invites
  }, [invites])

  useEffect(() => {
    if (!enabled) return
    if (!electronIpc.isElectron()) return

    const pushLog = (channel: MatrixLogEntry['channel'], data: unknown) => {
      const entry: MatrixLogEntry = { ts: Date.now(), channel, data }
      const next = [...logBufferRef.current, entry]
      logBufferRef.current = next.length > 4000 ? next.slice(next.length - 4000) : next
      for (const sink of logSinksRef.current) {
        try {
          sink(entry)
        } catch (_err) {
          // Ignore sink failures to keep streaming stable.
        }
      }
    }

    const unsubscribers = [
      electronIpc.onWorkerStdout((line) => pushLog('worker-stdout', line)),
      electronIpc.onWorkerStderr((line) => pushLog('worker-stderr', line)),
      electronIpc.onWorkerMessage((message) => pushLog('worker-message', message))
    ]

    return () => {
      unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe()
        } catch (_err) {
          // noop
        }
      })
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    const probeWorkerIdentity = async () => {
      if (!electronIpc.isElectron()) return false
      try {
        const response = await (window as any).electronAPI.sendToWorkerAwait({
          message: { type: 'get-worker-identity' },
          timeoutMs: 15_000
        })
        if (!response?.success) return false
        const workerPubkey = String(response?.data?.pubkeyHex || '').trim().toLowerCase()
        if (!isHex64(workerPubkey)) return false
        const expectedPubkey = String(pubkeyRef.current || '').trim().toLowerCase()
        if (isHex64(expectedPubkey) && workerPubkey !== expectedPubkey) {
          return false
        }
        return true
      } catch {
        return false
      }
    }

    const waitForReady = async (timeoutMs: number) => {
      const startedAt = Date.now()
      while (!readyRef.current && Date.now() - startedAt < timeoutMs) {
        await sleep(250)
      }
      return readyRef.current
    }

    const ensureWorkerReady = async () => {
      const identityStartedAt = Date.now()
      while (
        !(isHex64(pubkeyRef.current) && isHex64(nsecHexRef.current))
        && Date.now() - identityStartedAt < 30_000
      ) {
        await sleep(200)
      }
      if (!(isHex64(pubkeyRef.current) && isHex64(nsecHexRef.current))) {
        throw new Error('nostr-identity-not-ready')
      }
      if (!readyRef.current) {
        await startWorkerRef.current()
      }
      if (await waitForReady(90_000)) {
        return
      }
      if (await probeWorkerIdentity()) {
        return
      }
      try {
        await restartWorkerRef.current()
      } catch {
        await startWorkerRef.current()
      }
      if (await waitForReady(90_000)) {
        return
      }
      if (await probeWorkerIdentity()) {
        return
      }
      throw new Error('worker-ready-timeout')
    }

    const waitForJoinWritable = async (args: MatrixWaitArgs) => {
      const identifier = String(args.publicIdentifier || '').trim()
      const relayKey = typeof args.relayKey === 'string' ? args.relayKey.trim() : null
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : 120_000
      const intervalMs = Number.isFinite(args.intervalMs) ? Number(args.intervalMs) : 500
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const flow = joinFlowsRef.current[identifier]
        if (flow?.phase === 'error') {
          throw new Error(flow.error || 'join-flow-error')
        }
        if (flow?.writable === true) {
          return { source: 'join-flow', flow }
        }
        const relay = relaysRef.current.find((entry) => {
          if (relayKey && entry.relayKey === relayKey) return true
          return entry.publicIdentifier === identifier
        })
        if (relay?.writable === true) {
          return { source: 'relay', relay }
        }
        await sleep(intervalMs)
      }
      throw new Error(`join-writable-timeout:${timeoutMs}`)
    }

    const fetchGroupNotesFromRelay = async ({
      groupId,
      relayUrl,
      limit = 50
    }: {
      groupId: string
      relayUrl: string
      limit?: number
    }) => {
      const normalizedGroupId = String(groupId || '').trim()
      const normalizedRelayUrl = String(relayUrl || '').trim()
      if (!normalizedGroupId) throw new Error('group-id-required')
      if (!normalizedRelayUrl) throw new Error('relay-url-required')
      const filter = {
        kinds: [1],
        '#h': [normalizedGroupId],
        limit: Number.isFinite(limit) ? Math.max(1, Math.trunc(Number(limit))) : 50
      }
      return await client.fetchEvents([normalizedRelayUrl], filter as any)
    }

    const bridge = {
      async loginWithNsec(args: { nsec: string; password?: string }) {
        const nsec = String(args?.nsec || '').trim()
        if (!nsec) throw new Error('nsec-required')
        const loginPubkey = await nsecLogin(nsec, args?.password)
        if (isHex64(loginPubkey)) {
          pubkeyRef.current = loginPubkey.toLowerCase()
        }
        await ensureWorkerReady()
        const startedAt = Date.now()
        while (!pubkeyRef.current && Date.now() - startedAt < 30_000) {
          await sleep(200)
        }
        if (!pubkeyRef.current) throw new Error('login-pubkey-timeout')
        return { pubkey: pubkeyRef.current }
      },
      async createHypertunaRelayGroup(args: {
        name: string
        about?: string
        isPublic?: boolean
        isOpen?: boolean
        picture?: string
        fileSharing?: boolean
        gateways?: Array<{ origin: string; operatorPubkey: string; policy: 'OPEN' | 'CLOSED' }>
      }) {
        await ensureWorkerReady()
        return await createGroupRef.current({
          name: args.name,
          about: args.about,
          isPublic: args.isPublic !== false,
          isOpen: args.isOpen !== false,
          picture: args.picture,
          fileSharing: args.fileSharing,
          gateways: args.gateways
        })
      },
      async sendInvites(args: {
        groupId: string
        invitees: string[]
        relay?: string
        options?: {
          isOpen?: boolean
          name?: string
          about?: string
          picture?: string
          authorizedMemberPubkeys?: string[]
        }
      }) {
        await ensureWorkerReady()
        return await sendInvitesRef.current(args.groupId, args.invitees, args.relay, args.options)
      },
      async fetchGroupDetail(args: {
        groupId: string
        relay?: string
        preferRelay?: boolean
        discoveryOnly?: boolean
      }) {
        await ensureWorkerReady()
        return await fetchGroupDetailRef.current(args.groupId, args.relay, {
          preferRelay: args.preferRelay,
          discoveryOnly: args.discoveryOnly
        })
      },
      async startJoinLikeGroupPage(args: MatrixJoinStartArgs) {
        await ensureWorkerReady()
        const groupId = String(args?.groupId || '').trim()
        if (!groupId) throw new Error('group-id-required')

        const invite = invitesRef.current.find((entry) => entry.groupId === groupId) || null
        const detail = await fetchGroupDetailRef.current(groupId, args.relayUrl || invite?.relayUrl || undefined, {
          preferRelay: true
        }).catch(() => null)
        const provisional = getProvisionalGroupMetadataRef.current(
          groupId,
          args.relayUrl || invite?.relayUrl || undefined
        )
        const metadata = detail?.metadata || provisional || null

        const token = args.token ?? invite?.token ?? null
        const relayKey = args.relayKey || invite?.relayKey || null
        const relayUrl = args.relayUrl || invite?.relayUrl || null
        const isOpen = typeof args.isOpen === 'boolean'
          ? args.isOpen
          : (metadata?.isOpen !== false)
        const openJoin = typeof args.openJoin === 'boolean'
          ? args.openJoin
          : (isOpen && !(token && token.trim()))
        const inferredWriterIssuer =
          args.writerIssuerPubkey
          || invite?.writerIssuerPubkey
          || metadata?.writerIssuerPubkey
          || decodeNpubToHex(groupId.split(':')?.[0] || '')

        if (token && sendToWorkerRef.current && pubkeyRef.current) {
          sendToWorkerRef.current({
            type: 'update-auth-data',
            data: {
              relayKey,
              publicIdentifier: groupId,
              pubkey: pubkeyRef.current,
              token
            }
          }).catch(() => {})
        }

        await startJoinFlowRef.current(groupId, {
          fileSharing: typeof args.fileSharing === 'boolean' ? args.fileSharing : isOpen,
          isOpen,
          openJoin,
          token: token || undefined,
          relayKey: relayKey || undefined,
          relayUrl: relayUrl || undefined,
          gatewayOrigins: args.gatewayOrigins || invite?.gatewayOrigins,
          blindPeer: args.blindPeer || invite?.blindPeer,
          cores: args.cores || invite?.cores,
          writerCore: args.writerCore || invite?.writerCore,
          writerCoreHex: args.writerCoreHex || invite?.writerCoreHex,
          autobaseLocal: args.autobaseLocal || invite?.autobaseLocal,
          writerSecret: args.writerSecret || invite?.writerSecret,
          discoveryTopic: args.discoveryTopic || invite?.discoveryTopic || metadata?.discoveryTopic || undefined,
          hostPeerKeys: resolveHintedList(
            args.hostPeerKeys
              || invite?.hostPeerKeys
              || metadata?.hostPeerKeys
          ),
          memberPeerKeys: resolveHintedList(
            args.memberPeerKeys
              || invite?.memberPeerKeys
              || metadata?.memberPeerKeys
          ),
          writerIssuerPubkey: inferredWriterIssuer || undefined,
          fastForward: args.fastForward || invite?.fastForward || undefined
        })
        return { started: true }
      },
      async waitForJoinWritable(args: MatrixWaitArgs) {
        return await waitForJoinWritable(args)
      },
      async waitForAutoConnectWritable(args: MatrixWaitArgs) {
        return await waitForJoinWritable(args)
      },
      async publishGroupNote(args: {
        groupId: string
        relayUrl: string
        content: string
      }) {
        await ensureWorkerReady()
        const groupId = String(args?.groupId || '').trim()
        const relayUrl = String(args?.relayUrl || '').trim()
        const content = String(args?.content || '').trim()
        if (!groupId) throw new Error('group-id-required')
        if (!relayUrl) throw new Error('relay-url-required')
        if (!content) throw new Error('note-content-required')
        const draftEvent = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['h', groupId]],
          content
        }
        const event = await publishRef.current(draftEvent as any, { specifiedRelayUrls: [relayUrl] })
        return {
          id: event?.id || null,
          pubkey: event?.pubkey || null,
          content
        }
      },
      async fetchGroupNotes(args: {
        groupId: string
        relayUrl: string
        limit?: number
      }) {
        await ensureWorkerReady()
        const events = await fetchGroupNotesFromRelay({
          groupId: args?.groupId || '',
          relayUrl: args?.relayUrl || '',
          limit: args?.limit
        })
        return Array.isArray(events) ? events : []
      },
      async waitForGroupNote(args: {
        groupId: string
        relayUrl: string
        noteId?: string | null
        content?: string | null
        authorPubkey?: string | null
        timeoutMs?: number
        intervalMs?: number
      }) {
        await ensureWorkerReady()
        const groupId = String(args?.groupId || '').trim()
        const relayUrl = String(args?.relayUrl || '').trim()
        const noteId = String(args?.noteId || '').trim()
        const content = String(args?.content || '').trim()
        const authorPubkey = String(args?.authorPubkey || '').trim().toLowerCase()
        const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args?.timeoutMs) : 60_000
        const intervalMs = Number.isFinite(args?.intervalMs) ? Number(args?.intervalMs) : 1_000
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
          const events = await fetchGroupNotesFromRelay({ groupId, relayUrl, limit: 100 })
          const matched = (Array.isArray(events) ? events : []).find((event: any) => {
            if (noteId && event?.id !== noteId) return false
            if (content && String(event?.content || '').trim() !== content) return false
            if (authorPubkey && String(event?.pubkey || '').trim().toLowerCase() !== authorPubkey) return false
            if (!noteId && !content && !authorPubkey) return true
            return true
          })
          if (matched) return matched
          await sleep(intervalMs)
        }
        throw new Error(`group-note-timeout:${timeoutMs}`)
      },
      async openGroupPage(args: {
        groupId: string
        relayUrl?: string | null
      }) {
        const groupId = String(args?.groupId || '').trim()
        const relayUrl = String(args?.relayUrl || '').trim()
        if (!groupId) throw new Error('group-id-required')
        const encodedGroupId = encodeURIComponent(groupId)
        const nextUrl = relayUrl
          ? `/groups/${encodedGroupId}?relay=${encodeURIComponent(relayUrl)}`
          : `/groups/${encodedGroupId}`
        window.history.pushState({}, '', nextUrl)
        window.dispatchEvent(new PopStateEvent('popstate'))
        return { url: nextUrl }
      },
      async waitForVisibleText(args: {
        text: string
        timeoutMs?: number
        intervalMs?: number
      }) {
        const text = String(args?.text || '')
        if (!text) throw new Error('text-required')
        const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args?.timeoutMs) : 60_000
        const intervalMs = Number.isFinite(args?.intervalMs) ? Number(args?.intervalMs) : 500
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
          const bodyText = String(document?.body?.innerText || '')
          if (bodyText.includes(text)) {
            return { visible: true }
          }
          await sleep(intervalMs)
        }
        throw new Error(`visible-text-timeout:${timeoutMs}`)
      },
      async restartWorker() {
        await restartWorkerRef.current()
        return { success: true }
      },
      async stopWorker() {
        await stopWorkerRef.current()
        return { success: true }
      },
      async sendWorkerMessage(message: unknown) {
        return await sendToWorkerRef.current(message)
      },
      async sendWorkerAwait(message: unknown, timeoutMs?: number) {
        if (!electronIpc.isElectron()) throw new Error('electron-unavailable')
        return await (window as any).electronAPI.sendToWorkerAwait({
          message,
          timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : undefined
        })
      },
      getRelays() {
        return relaysRef.current
      },
      subscribeLogs(
        callback: ((entry: MatrixLogEntry) => void) | null,
        opts?: { replay?: number }
      ) {
        if (typeof callback !== 'function') {
          return () => {}
        }
        const replay = Number.isFinite(opts?.replay) ? Math.max(0, Math.trunc(Number(opts?.replay))) : 0
        if (replay > 0) {
          logBufferRef.current.slice(-replay).forEach((entry) => {
            try {
              callback(entry)
            } catch (_err) {
              // noop
            }
          })
        }
        logSinksRef.current.add(callback)
        return () => {
          logSinksRef.current.delete(callback)
        }
      },
      getRecentLogs(limit = 200) {
        const size = Number.isFinite(limit) ? Math.max(1, Math.trunc(Number(limit))) : 200
        return logBufferRef.current.slice(-size)
      }
    }

    ;(window as any).__HT_MATRIX_E2E__ = bridge
    return () => {
      if ((window as any).__HT_MATRIX_E2E__ === bridge) {
        delete (window as any).__HT_MATRIX_E2E__
      }
      logSinksRef.current.clear()
    }
  }, [enabled, nsecLogin])

  return null
}
