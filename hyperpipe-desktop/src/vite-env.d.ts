/// <reference types="vite/client" />
import { TNip07 } from '@/types'

interface ImportMetaEnv {
  readonly VITE_FEATURE_EXPLORE_ENABLED?: string
  readonly VITE_FEATURE_LISTS_ENABLED?: string
  readonly VITE_FEATURE_BOOKMARKS_ENABLED?: string
  readonly VITE_USE_HYPERDRIVE_UPLOADS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    nostr?: TNip07
  }
}
