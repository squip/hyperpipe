export type WorkerCommand = {
  type: string
  requestId?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

export type WorkerEvent = {
  type: string
  requestId?: string
  success?: boolean
  error?: string | null
  data?: unknown
  [key: string]: unknown
}

export type WorkerConfig = {
  nostr_pubkey_hex: string
  nostr_nsec_hex: string
  nostr_npub?: string
  userKey: string
}

export type WorkerStartConfig = {
  workerRoot: string
  workerEntry?: string
  storageDir: string
  config: WorkerConfig
}

export type StartResult = {
  success: boolean
  alreadyRunning?: boolean
  configSent: boolean
  error?: string
}

export type WorkerRequestResult<T = unknown> = {
  success: boolean
  data?: T | null
  error?: string | null
  requestId?: string
}

export type Unsubscribe = () => void
