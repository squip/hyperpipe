import type { RelayService as IRelayService } from './types.js'
import type { RelayEntry } from './types.js'
import type { WorkerHost } from '../runtime/workerHost.js'
import { waitForWorkerEvent } from '../runtime/waitForWorkerEvent.js'

export class RelayService implements IRelayService {
  private workerHost: WorkerHost

  constructor(workerHost: WorkerHost) {
    this.workerHost = workerHost
  }

  async getRelays(): Promise<RelayEntry[]> {
    const sent = await this.workerHost.send({ type: 'get-relays' })
    if (!sent.success) {
      throw new Error(sent.error || 'Failed to request relays')
    }

    const event = await waitForWorkerEvent(
      this.workerHost,
      (msg) => msg.type === 'relay-update' && Array.isArray((msg as { relays?: unknown }).relays),
      8_000
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
  }): Promise<Record<string, unknown>> {
    const sent = await this.workerHost.send({
      type: 'create-relay',
      data: {
        ...input
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to send create-relay command')
    }

    const event = await waitForWorkerEvent(
      this.workerHost,
      (msg) => msg.type === 'relay-created' || msg.type === 'error',
      60_000
    )

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
    const sent = await this.workerHost.send({
      type: 'join-relay',
      data: {
        ...input
      }
    })

    if (!sent.success) {
      throw new Error(sent.error || 'Failed to send join-relay command')
    }

    const event = await waitForWorkerEvent(
      this.workerHost,
      (msg) => msg.type === 'relay-joined' || msg.type === 'error',
      90_000
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
    openJoin?: boolean
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
