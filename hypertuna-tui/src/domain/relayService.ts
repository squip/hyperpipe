import type { RelayService as IRelayService } from './types.js'
import type { RelayEntry } from './types.js'
import type { WorkerHost } from '../runtime/workerHost.js'

export class RelayService implements IRelayService {
  private workerHost: WorkerHost

  constructor(workerHost: WorkerHost) {
    this.workerHost = workerHost
  }

  private async sendAndWaitForEvent<T extends Record<string, unknown>>(
    command: Record<string, unknown>,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs: number,
    sendError: string
  ): Promise<T> {
    const timeout = Math.max(1_000, Math.min(Math.trunc(timeoutMs || 0), 300_000))

    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const off = this.workerHost.onMessage((raw) => {
        if (settled) return
        if (!raw || typeof raw !== 'object') return
        const message = raw as Record<string, unknown>
        if (!predicate(message)) return
        settled = true
        clearTimeout(timeoutId)
        off()
        resolve(message as T)
      })

      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        off()
        reject(new Error(`Timed out waiting for worker event after ${timeout}ms`))
      }, timeout)

      this.workerHost.send(command as any)
        .then((sent) => {
          if (settled) return
          if (sent.success) return
          settled = true
          clearTimeout(timeoutId)
          off()
          reject(new Error(sent.error || sendError))
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          off()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  async getRelays(): Promise<RelayEntry[]> {
    const event = await this.sendAndWaitForEvent<{ relays?: RelayEntry[] }>(
      { type: 'get-relays' },
      (msg) => msg.type === 'relay-update' && Array.isArray((msg as { relays?: unknown }).relays),
      8_000,
      'Failed to request relays'
    )

    return ((event as unknown as { relays?: RelayEntry[] }).relays || [])
  }

  async createRelay(input: {
    name: string
    description?: string
    isPublic?: boolean
    isOpen?: boolean
    fileSharing?: boolean
    picture?: string
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
  }): Promise<Record<string, unknown>> {
    let event: Record<string, unknown>
    try {
      event = await this.sendAndWaitForEvent<Record<string, unknown>>(
        {
          type: 'create-relay',
          data: {
            ...input
          }
        },
        (msg) => msg.type === 'relay-created' || msg.type === 'error',
        25_000,
        'Failed to send create-relay command'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Timed out waiting for worker event')) {
        return {
          pending: true
        }
      }
      throw error
    }

    if (event.type === 'error') {
      throw new Error(String((event as { message?: string }).message || 'create-relay failed'))
    }

    return ((event as { data?: Record<string, unknown> }).data || {})
  }

  async joinRelay(input: {
    relayKey?: string
    publicIdentifier?: string
    relayUrl?: string
    authToken?: string
    fileSharing?: boolean
  }): Promise<Record<string, unknown>> {
    const event = await this.sendAndWaitForEvent<Record<string, unknown>>(
      {
        type: 'join-relay',
        data: {
          ...input
        }
      },
      (msg) => msg.type === 'relay-joined' || msg.type === 'error',
      90_000,
      'Failed to send join-relay command'
    )

    if (event.type === 'error') {
      throw new Error(String((event as { message?: string }).message || 'join-relay failed'))
    }

    return ((event as { data?: Record<string, unknown> }).data || {})
  }

  async startJoinFlow(input: {
    publicIdentifier: string
    fileSharing?: boolean
    isOpen?: boolean
    token?: string
    relayKey?: string
    relayUrl?: string
    gatewayOrigin?: string | null
    gatewayId?: string | null
    directJoinOnly?: boolean
    discoveryTopic?: string | null
    hostPeerKeys?: string[]
    leaseReplicaPeerKeys?: string[]
    writerIssuerPubkey?: string | null
    writerLeaseEnvelope?: Record<string, unknown> | null
    gatewayAccess?: {
      version?: string | null
      authMethod?: string | null
      grantId?: string | null
      gatewayId?: string | null
      gatewayOrigin?: string | null
      scopes?: string[]
    } | null
    openJoin?: boolean
    hostPeers?: string[]
    blindPeer?: {
      publicKey?: string | null
      encryptionKey?: string | null
      replicationTopic?: string | null
      maxBytes?: number | null
    } | null
    cores?: Array<{
      key: string
      role?: string | null
    }>
    writerCore?: string | null
    writerCoreHex?: string | null
    autobaseLocal?: string | null
    writerSecret?: string | null
    fastForward?: {
      key?: string | null
      length?: number | null
      signedLength?: number | null
      timeoutMs?: number | null
    } | null
  }): Promise<void> {
    const sent = await this.workerHost.send({
      type: 'start-join-flow',
      data: {
        ...input
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to start join flow')
    }
  }

  async disconnectRelay(relayKey: string, publicIdentifier?: string): Promise<void> {
    const sent = await this.workerHost.send({
      type: 'disconnect-relay',
      data: {
        relayKey,
        publicIdentifier
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to disconnect relay')
    }
  }

  async leaveGroup(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    saveRelaySnapshot?: boolean
    saveSharedFiles?: boolean
  }): Promise<Record<string, unknown>> {
    const data = await this.workerHost.request<Record<string, unknown>>({
      type: 'leave-group',
      data: {
        ...input
      }
    }, 180_000)

    return data || {}
  }
}
