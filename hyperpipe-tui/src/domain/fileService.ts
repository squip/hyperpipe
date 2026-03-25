import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Filter } from 'nostr-tools'
import type {
  FileDeleteResult,
  FileDownloadResult,
  FileScope,
  FileService as IFileService
} from './types.js'
import { NostrClient } from './nostrClient.js'
import type { WorkerHost } from '../runtime/workerHost.js'
import { parseGroupFileRecordFromEvent } from '../lib/group-files.js'

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.txt':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    case '.json':
      return 'application/json'
    case '.pdf':
      return 'application/pdf'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.mp3':
      return 'audio/mpeg'
    default:
      return 'application/octet-stream'
  }
}

export class FileService implements IFileService {
  private workerHost: WorkerHost
  private client: NostrClient

  constructor(workerHost: WorkerHost, client: NostrClient) {
    this.workerHost = workerHost
    this.client = client
  }

  async uploadFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    filePath: string
    localRelayBaseUrl?: string
    metadata?: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    const buffer = await fs.readFile(input.filePath)
    const fileHash = createHash('sha256').update(buffer).digest('hex')
    const fileName = path.basename(input.filePath)

    const payload: Record<string, unknown> = {
      relayKey: input.relayKey || undefined,
      publicIdentifier: input.publicIdentifier || undefined,
      identifier: input.publicIdentifier || input.relayKey || undefined,
      fileHash,
      fileId: fileName,
      buffer: buffer.toString('base64'),
      localRelayBaseUrl: input.localRelayBaseUrl,
      metadata: {
        fileName,
        size: buffer.length,
        mimeType: guessMime(input.filePath),
        ...(input.metadata || {})
      }
    }

    const data = await this.workerHost.request<Record<string, unknown>>({
      type: 'upload-file',
      data: payload
    }, 120_000)

    return data || {}
  }

  async fetchGroupFiles(relays: string[], groupId?: string, limit = 500) {
    const filter: Filter = {
      kinds: [1063],
      limit
    }

    if (groupId) {
      filter['#h'] = [groupId]
    }

    const events = await this.client.query(relays, filter, 6_000)

    const records = events
      .map((event) => parseGroupFileRecordFromEvent(event))
      .filter((record): record is NonNullable<typeof record> => !!record)

    records.sort((left, right) => right.uploadedAt - left.uploadedAt)

    return records
  }

  async fetchScopedGroupFiles(scope: FileScope, limit = 1_200) {
    const allEvents = new Map<string, ReturnType<typeof parseGroupFileRecordFromEvent>>()

    if (scope.localGroupIds.length > 0) {
      const fallbackRelays = Array.isArray(scope.fallbackRelays) ? scope.fallbackRelays : []
      const localEvents = await this.client.query(
        fallbackRelays,
        {
          kinds: [1063],
          '#h': scope.localGroupIds,
          limit
        },
        6_000
      )
      for (const event of localEvents) {
        allEvents.set(event.id, parseGroupFileRecordFromEvent(event))
      }
    }

    for (const relayGroup of scope.relayGroups) {
      if (!relayGroup.groupIds.length) continue
      const relayEvents = await this.client.query(
        [relayGroup.relayUrl],
        {
          kinds: [1063],
          '#h': relayGroup.groupIds,
          limit
        },
        6_000
      )
      for (const event of relayEvents) {
        allEvents.set(event.id, parseGroupFileRecordFromEvent(event))
      }
    }

    const records = Array.from(allEvents.values())
      .filter((record): record is NonNullable<typeof record> => !!record)
      .sort((left, right) => right.uploadedAt - left.uploadedAt)

    return records
  }

  async downloadGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
    fileName?: string | null
  }): Promise<FileDownloadResult> {
    const payload: Record<string, unknown> = {
      relayKey: input.relayKey || undefined,
      publicIdentifier: input.publicIdentifier || undefined,
      identifier: input.publicIdentifier || input.groupId || input.relayKey || undefined,
      groupId: input.groupId || undefined,
      eventId: input.eventId || undefined,
      fileHash: input.fileHash,
      fileName: input.fileName || undefined
    }

    const response = await this.workerHost.request<Record<string, unknown>>(
      {
        type: 'download-group-file',
        data: payload
      },
      120_000
    )

    const savedPath = String(response?.savedPath || '')
    if (!savedPath) {
      throw new Error('Worker did not return savedPath for downloaded file')
    }

    return {
      savedPath,
      bytes: Number.isFinite(Number(response?.bytes)) ? Number(response?.bytes) : 0,
      source: String(response?.source || 'unknown')
    }
  }

  async deleteLocalGroupFile(input: {
    relayKey?: string | null
    publicIdentifier?: string | null
    groupId?: string | null
    eventId?: string | null
    fileHash: string
  }): Promise<FileDeleteResult> {
    const payload: Record<string, unknown> = {
      relayKey: input.relayKey || undefined,
      publicIdentifier: input.publicIdentifier || undefined,
      identifier: input.publicIdentifier || input.groupId || input.relayKey || undefined,
      groupId: input.groupId || undefined,
      eventId: input.eventId || undefined,
      fileHash: input.fileHash
    }

    const response = await this.workerHost.request<Record<string, unknown>>(
      {
        type: 'delete-local-group-file',
        data: payload
      },
      60_000
    )

    return {
      deleted: response?.deleted !== false,
      reason: typeof response?.reason === 'string' ? response.reason : null
    }
  }
}
