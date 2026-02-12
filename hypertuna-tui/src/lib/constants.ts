export const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.damus.io/',
  'wss://relay.primal.net/',
  'wss://nos.lol/',
  'wss://hypertuna.com/relay'
]

export const SEARCHABLE_RELAYS = ['wss://relay.nostr.band/', 'wss://search.nos.today/']

export const SECTION_ORDER = [
  'dashboard',
  'relays',
  'feed',
  'groups',
  'files',
  'lists',
  'bookmarks',
  'chats',
  'search',
  'accounts',
  'logs'
] as const

export type SectionId = (typeof SECTION_ORDER)[number]

export const SECTION_LABELS: Record<SectionId, string> = {
  dashboard: 'Dashboard',
  relays: 'Relays',
  feed: 'Feed',
  groups: 'Groups',
  files: 'Files',
  lists: 'Lists',
  bookmarks: 'Bookmarks',
  chats: 'Chats',
  search: 'Search',
  accounts: 'Accounts',
  logs: 'Logs'
}
