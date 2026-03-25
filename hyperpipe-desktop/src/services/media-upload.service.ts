import { simplifyUrl } from '@/lib/url'
import { TDraftEvent, TMediaUploadServiceConfig } from '@/types'
import { BlossomClient } from 'blossom-client-sdk'
import { z } from 'zod'
import client from './client.service'
import storage from './local-storage.service'
import { loadBlossomServers } from '@nostr/gadgets/lists'
import { electronIpc } from './electron-ipc.service'

type UploadOptions = {
  onProgress?: (progressPercent: number) => void
  signal?: AbortSignal
}

export type MediaUploadTarget = 'external' | 'group-hyperdrive'

export type MediaUploadContext = {
  target: MediaUploadTarget
  groupId?: string
  relayUrl?: string
  relayKey?: string | null
  parentKind?: number
  resourceScope?: 'group' | 'conversation'
}

export type UploadedFileMetadata = {
  source: MediaUploadTarget
  url: string
  gatewayUrl?: string
  gatewayUrls?: string[]
  mimeType?: string
  sha256?: string
  originalSha256?: string
  size?: number
  dim?: { width: number; height: number }
  fileId?: string
  fileName?: string
  groupId?: string
  relayKey?: string | null
  driveKey?: string | null
  ownerPubkey?: string | null
  resourceScope?: 'group' | 'conversation'
}

export type MediaUploadResult = {
  url: string
  tags: string[][]
  metadata?: UploadedFileMetadata
}

export const UPLOAD_ABORTED_ERROR_MSG = 'Upload aborted'

function toHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function uint8ToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

class MediaUploadService {
  static instance: MediaUploadService

  private serviceConfig: TMediaUploadServiceConfig = storage.getMediaUploadServiceConfig()
  private nip96ServiceUploadUrlMap = new Map<string, string | undefined>()
  private imetaTagMap = new Map<string, string[]>()
  private uploadMetadataByUrl = new Map<string, UploadedFileMetadata>()

  constructor() {
    if (!MediaUploadService.instance) {
      MediaUploadService.instance = this
    }
    return MediaUploadService.instance
  }

  setServiceConfig(config: TMediaUploadServiceConfig) {
    this.serviceConfig = config
  }

  async upload(file: File, options?: UploadOptions, context?: MediaUploadContext): Promise<MediaUploadResult> {
    if (context?.target === 'group-hyperdrive') {
      const result = await this.uploadByGroupHyperdrive(file, context, options)
      if (result.tags.length > 0) {
        this.imetaTagMap.set(result.url, ['imeta', ...result.tags.map(([n, v]) => `${n} ${v}`)])
      }
      if (result.metadata) {
        this.uploadMetadataByUrl.set(result.url, result.metadata)
      }
      return result
    }

    let result: MediaUploadResult
    if (this.serviceConfig.type === 'nip96') {
      result = await this.uploadByNip96(this.serviceConfig.service, file, options)
    } else {
      result = await this.uploadByBlossom(file, options)
    }

    if (result.tags.length > 0) {
      this.imetaTagMap.set(result.url, ['imeta', ...result.tags.map(([n, v]) => `${n} ${v}`)])
    }

    if (!result.metadata) {
      const metadata = this.buildMetadataFromNip94Tags(result.url, result.tags)
      if (metadata) {
        this.uploadMetadataByUrl.set(result.url, metadata)
        result.metadata = metadata
      }
    } else {
      this.uploadMetadataByUrl.set(result.url, result.metadata)
    }

    return result
  }

  private async uploadByBlossom(file: File, options?: UploadOptions): Promise<MediaUploadResult> {
    const pubkey = client.pubkey
    const signer = async (draft: TDraftEvent) => {
      if (!client.signer) {
        throw new Error('You need to be logged in to upload media')
      }
      return client.signer.signEvent(draft)
    }
    if (!pubkey) {
      throw new Error('You need to be logged in to upload media')
    }

    if (options?.signal?.aborted) {
      throw new Error(UPLOAD_ABORTED_ERROR_MSG)
    }

    options?.onProgress?.(0)

    let pseudoProgress = 1
    let pseudoTimer: number | undefined
    const startPseudoProgress = () => {
      if (pseudoTimer !== undefined) return
      pseudoTimer = window.setInterval(() => {
        pseudoProgress = Math.min(pseudoProgress + 3, 90)
        options?.onProgress?.(pseudoProgress)
        if (pseudoProgress >= 90) {
          stopPseudoProgress()
        }
      }, 300)
    }
    const stopPseudoProgress = () => {
      if (pseudoTimer !== undefined) {
        clearInterval(pseudoTimer)
        pseudoTimer = undefined
      }
    }
    startPseudoProgress()

    const { items: servers } = await loadBlossomServers(pubkey)
    if (servers.length === 0) {
      throw new Error('No Blossom services available')
    }
    const [mainServer, ...mirrorServers] = servers

    const auth = await BlossomClient.createUploadAuth(signer, file, {
      message: 'Uploading media file'
    })

    const blob = await BlossomClient.uploadBlob(mainServer, file, { auth })
    stopPseudoProgress()
    options?.onProgress?.(80)

    if (mirrorServers.length > 0) {
      await Promise.allSettled(
        mirrorServers.map((server) => BlossomClient.mirrorBlob(server, blob, { auth }))
      )
    }

    let tags: string[][] = []
    const parseResult = z.array(z.array(z.string())).safeParse((blob as any).nip94 ?? [])
    if (parseResult.success) {
      tags = parseResult.data
    }

    options?.onProgress?.(100)
    return { url: blob.url, tags }
  }

  private async uploadByNip96(
    service: string,
    file: File,
    options?: UploadOptions
  ): Promise<MediaUploadResult> {
    if (options?.signal?.aborted) {
      throw new Error(UPLOAD_ABORTED_ERROR_MSG)
    }
    let uploadUrl = this.nip96ServiceUploadUrlMap.get(service)
    if (!uploadUrl) {
      const response = await fetch(`${service}/.well-known/nostr/nip96.json`)
      if (!response.ok) {
        throw new Error(
          `${simplifyUrl(service)} does not work, please try another service in your settings`
        )
      }
      const data = await response.json()
      uploadUrl = data?.api_url
      if (!uploadUrl) {
        throw new Error(
          `${simplifyUrl(service)} does not work, please try another service in your settings`
        )
      }
      this.nip96ServiceUploadUrlMap.set(service, uploadUrl)
    }

    if (options?.signal?.aborted) {
      throw new Error(UPLOAD_ABORTED_ERROR_MSG)
    }
    const formData = new FormData()
    formData.append('file', file)

    const auth = await client.signHttpAuth(uploadUrl, 'POST', 'Uploading media file')

    const result = await new Promise<MediaUploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', uploadUrl as string)
      xhr.responseType = 'json'
      xhr.setRequestHeader('Authorization', auth)

      const handleAbort = () => {
        try {
          xhr.abort()
        } catch {
          // ignore
        }
        reject(new Error(UPLOAD_ABORTED_ERROR_MSG))
      }
      if (options?.signal) {
        if (options.signal.aborted) {
          return handleAbort()
        }
        options.signal.addEventListener('abort', handleAbort, { once: true })
      }

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100)
          options?.onProgress?.(percent)
        }
      }
      xhr.onerror = () => reject(new Error('Network error'))
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = xhr.response
          try {
            const tags = z.array(z.array(z.string())).parse(data?.nip94_event?.tags ?? [])
            const url = tags.find(([tagName]: string[]) => tagName === 'url')?.[1]
            if (url) {
              resolve({ url, tags })
            } else {
              reject(new Error('No url found'))
            }
          } catch (e) {
            reject(e as Error)
          }
        } else {
          reject(new Error(xhr.status.toString() + ' ' + xhr.statusText))
        }
      }
      xhr.send(formData)
    })

    return result
  }

  private async uploadByGroupHyperdrive(
    file: File,
    context: MediaUploadContext,
    options?: UploadOptions
  ): Promise<MediaUploadResult> {
    if (!electronIpc.isElectron()) {
      throw new Error('Group hyperdrive uploads require Electron runtime')
    }
    if (!context.groupId) {
      throw new Error('Group identifier is required for group hyperdrive upload')
    }
    if (!context.relayUrl) {
      throw new Error('Group relay URL is required for group hyperdrive upload')
    }
    if (options?.signal?.aborted) {
      throw new Error(UPLOAD_ABORTED_ERROR_MSG)
    }

    options?.onProgress?.(0)

    const localBaseUrl = this.toHttpOrigin(context.relayUrl)
    if (!localBaseUrl) {
      throw new Error('Failed to derive local relay base URL for hyperdrive upload')
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const fileHash = toHex(new Uint8Array(digest))
    const extension = this.resolveFileExtension(file)
    const fileId = `${fileHash}${extension}`
    const dim = await this.readImageDimensions(file)

    const message = {
      type: 'upload-file',
      data: {
        relayKey: context.relayKey || null,
        identifier: context.groupId,
        publicIdentifier: context.groupId,
        fileHash,
        fileId,
        localRelayBaseUrl: localBaseUrl,
	        metadata: {
	          mimeType: file.type || 'application/octet-stream',
	          filename: file.name || fileId,
	          size: file.size,
	          dim: dim ? `${dim.width}x${dim.height}` : null,
	          parentKind: context.parentKind ?? null,
	          groupId: context.groupId,
	          resourceScope: context.resourceScope || 'group'
	        },
	        buffer: uint8ToBase64(bytes)
	      }
	    }

    const response = await electronIpc.sendToWorkerAwait({
      message,
      timeoutMs: 120_000
    })

    if (!response?.success) {
      throw new Error(response?.error || 'Worker rejected upload-file request')
    }

    options?.onProgress?.(100)

	    const responseData = (response?.data || {}) as Record<string, unknown>
	    const isConversationScope = context.resourceScope === 'conversation'
	    const url =
	      (typeof responseData.url === 'string' && responseData.url) ||
	      this.buildLocalDriveUrl(localBaseUrl, context.groupId, fileId)
	    const gatewayUrl =
	      isConversationScope
	        ? url
	        : ((typeof responseData.gatewayUrl === 'string' && responseData.gatewayUrl) || url)
	    const gatewayUrls =
	      isConversationScope
	        ? [url]
	        : (Array.isArray(responseData.gatewayUrls)
	          ? responseData.gatewayUrls.filter((value): value is string => typeof value === 'string' && Boolean(value))
	          : [])
	          .concat(gatewayUrl ? [gatewayUrl] : [])
	          .filter((value, index, list) => list.indexOf(value) === index)

    const mimeType =
      (typeof responseData.mime === 'string' && responseData.mime) ||
      file.type ||
      'application/octet-stream'

    const size = Number.isFinite(responseData.size as number)
      ? Number(responseData.size)
      : file.size

    const tags: string[][] = [
      ['url', url],
      ['m', mimeType],
      ['x', fileHash],
      ['ox', fileHash],
      ['size', String(size)],
      ['service', 'hyperpipe-hyperdrive']
    ]

    if (dim) {
      tags.push(['dim', `${dim.width}x${dim.height}`])
    }

    const metadata: UploadedFileMetadata = {
      source: 'group-hyperdrive',
      url,
      gatewayUrl,
      gatewayUrls,
      mimeType,
      sha256: fileHash,
      originalSha256: fileHash,
      size,
      dim: dim || undefined,
      fileId,
      fileName: file.name,
      groupId: context.groupId,
	      relayKey:
	        typeof responseData.relayKey === 'string'
	          ? responseData.relayKey
	          : context.relayKey || null,
	      driveKey:
	        typeof responseData.driveKey === 'string'
	          ? responseData.driveKey
	          : null,
	      ownerPubkey:
	        typeof responseData.ownerPubkey === 'string'
	          ? responseData.ownerPubkey
	          : null,
	      resourceScope: context.resourceScope || 'group'
	    }

    return { url, tags, metadata }
  }

  private toHttpOrigin(candidate: string) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'ws:') url.protocol = 'http:'
      if (url.protocol === 'wss:') url.protocol = 'https:'
      return url.origin
    } catch {
      return null
    }
  }

  private buildLocalDriveUrl(baseUrl: string, identifier: string, fileId: string) {
    const trimmedBase = baseUrl.replace(/\/+$/, '')
    const normalizedIdentifier = identifier.replace(/^\/+/, '').replace(/\/+$/, '')
    const normalizedFileId = fileId.replace(/^\/+/, '')
    return `${trimmedBase}/drive/${normalizedIdentifier}/${normalizedFileId}`
  }

  private resolveFileExtension(file: File) {
    const name = file.name || ''
    const dotIndex = name.lastIndexOf('.')
    if (dotIndex > -1 && dotIndex < name.length - 1) {
      return name.slice(dotIndex).toLowerCase()
    }

    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'application/pdf': '.pdf',
      'text/plain': '.txt'
    }
    return mimeMap[file.type] || ''
  }

  private async readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
    if (!file.type.startsWith('image/')) return null
    const objectUrl = URL.createObjectURL(file)
    try {
      const dim = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const image = new Image()
        image.onload = () => {
          resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height })
        }
        image.onerror = () => resolve(null)
        image.src = objectUrl
      })
      return dim
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  private buildMetadataFromNip94Tags(url: string, tags: string[][]): UploadedFileMetadata | null {
    if (!Array.isArray(tags) || tags.length === 0) return null
    const readTag = (name: string) => tags.find((tag) => tag[0] === name)?.[1]
    const mimeType = readTag('m')
    const sha256 = readTag('x')
    const originalSha256 = readTag('ox') || sha256
    const sizeTag = readTag('size')
    const size = sizeTag ? Number(sizeTag) : undefined
    const dimTag = readTag('dim')
    let dim: { width: number; height: number } | undefined
    if (dimTag) {
      const match = dimTag.match(/^(\d+)x(\d+)$/)
      if (match) {
        dim = { width: Number(match[1]), height: Number(match[2]) }
      }
    }
    if (!mimeType && !sha256 && !size && !dim) return null

    return {
      source: 'external',
      url,
      mimeType: mimeType || undefined,
      sha256: sha256 || undefined,
      originalSha256: originalSha256 || undefined,
      size: Number.isFinite(size) ? size : undefined,
      dim
    }
  }

  getImetaTagByUrl(url: string) {
    return this.imetaTagMap.get(url)
  }

  getUploadMetadataByUrl(url: string) {
    return this.uploadMetadataByUrl.get(url)
  }
}

const instance = new MediaUploadService()
export default instance
