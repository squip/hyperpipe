export const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.damus.io/',
  'wss://relay.primal.net/',
  'wss://nos.lol/',
  'wss://hypertuna.com/relay'
]

export const SEARCHABLE_RELAYS = ['wss://relay.nostr.band/', 'wss://search.nos.today/']

export const FILE_FAMILY_ORDER = [
  'images',
  'video',
  'audio',
  'docs',
  'other'
] as const

export type FileFamily = (typeof FILE_FAMILY_ORDER)[number]

export const ROOT_NAV_ORDER = [
  'dashboard',
  'relays',
  'groups',
  'chats',
  'invites',
  'files',
  'accounts',
  'logs'
] as const

export type RootNavId = (typeof ROOT_NAV_ORDER)[number]

// Backward-compatible alias retained for tests and helper tooling.
export const SECTION_ORDER = ROOT_NAV_ORDER

export const PARENT_NAV_IDS = ['groups', 'chats', 'invites', 'files'] as const
export type ParentNavId = (typeof PARENT_NAV_IDS)[number]

export const GROUP_CHILD_NAV_IDS = ['groups:browse', 'groups:my', 'groups:create'] as const
export const CHAT_CHILD_NAV_IDS = ['chats:create'] as const
export const INVITE_CHILD_NAV_IDS = ['invites:group', 'invites:chat', 'invites:send'] as const

export const FILE_CHILD_NAV_IDS = FILE_FAMILY_ORDER.map((family) => `files:type:${family}`) as readonly `files:type:${FileFamily}`[]

export const ALL_NAV_NODE_IDS = [
  ...ROOT_NAV_ORDER,
  ...GROUP_CHILD_NAV_IDS,
  ...CHAT_CHILD_NAV_IDS,
  ...INVITE_CHILD_NAV_IDS,
  ...FILE_CHILD_NAV_IDS
] as const

export type NavNodeId = (typeof ALL_NAV_NODE_IDS)[number]

export const ROOT_NAV_LABELS: Record<RootNavId, string> = {
  dashboard: 'Dashboard',
  relays: 'Relays',
  groups: 'Groups',
  chats: 'Chats',
  invites: 'Invites',
  files: 'Files',
  accounts: 'Accounts',
  logs: 'Logs'
}

export const FILE_FAMILY_LABELS: Record<FileFamily, string> = {
  images: 'Images',
  video: 'Video',
  audio: 'Audio',
  docs: 'Docs',
  other: 'Other'
}

export function isParentNavId(nodeId: NavNodeId): nodeId is ParentNavId {
  return PARENT_NAV_IDS.includes(nodeId as ParentNavId)
}

export function isFileTypeNodeId(nodeId: NavNodeId): nodeId is `files:type:${FileFamily}` {
  return nodeId.startsWith('files:type:')
}

export function fileFamilyFromNodeId(nodeId: NavNodeId): FileFamily | null {
  if (!isFileTypeNodeId(nodeId)) return null
  const family = nodeId.replace('files:type:', '') as FileFamily
  return FILE_FAMILY_ORDER.includes(family) ? family : null
}
