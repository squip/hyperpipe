import { z } from 'zod'
import { DEFAULT_DISCOVERY_RELAYS } from '../lib/constants.js'

export const accountRecordSchema = z.object({
  pubkey: z.string().regex(/^[a-f0-9]{64}$/),
  userKey: z.string().regex(/^[a-f0-9]{64}$/),
  signerType: z.enum(['nsec', 'ncryptsec']),
  nsec: z.string().optional(),
  ncryptsec: z.string().optional(),
  label: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

export const accountsFileSchema = z.object({
  version: z.literal(1),
  currentPubkey: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  accounts: z.array(accountRecordSchema)
})

export type AccountsFile = z.infer<typeof accountsFileSchema>
export type AccountRecordSchema = z.infer<typeof accountRecordSchema>

const accountScopedUiStateSchema = z.object({
  groupViewTab: z.enum(['discover', 'my', 'invites']).default('discover').transform((value) => (
    value === 'invites' ? 'discover' : value
  )),
  chatViewTab: z.enum(['conversations', 'invites']).default('conversations'),
  selectedNode: z.string().default('dashboard'),
  focusPane: z.union([
    z.enum(['left-tree', 'right-top', 'right-bottom']),
    z.literal('center')
  ]).default('left-tree').transform((value) => (value === 'center' ? 'right-top' : value)),
  treeExpanded: z.object({
    groups: z.boolean().default(true),
    chats: z.boolean().default(true),
    invites: z.boolean().default(true),
    files: z.boolean().default(true)
  }).default({
    groups: true,
    chats: true,
    invites: true,
    files: true
  }),
  nodeViewport: z.record(z.object({
    cursor: z.number().int().nonnegative().default(0),
    offset: z.number().int().nonnegative().default(0)
  })).default({}),
  rightTopSelectionByNode: z.record(z.number().int().nonnegative()).default({}),
  rightBottomOffsetByNode: z.record(z.number().int().nonnegative()).default({}),
  profileNameCacheByPubkey: z.record(z.object({
    name: z.string().default(''),
    bio: z.string().nullable().optional(),
    updatedAt: z.number().int().nonnegative().default(0)
  })).default({}),
  discoveryRelays: z.array(z.string()).default(DEFAULT_DISCOVERY_RELAYS.map((entry) => String(entry))),
  feedSource: z.object({
    mode: z.enum(['relays', 'relay', 'following', 'group']).default('relays'),
    relayUrl: z.string().nullable().optional(),
    groupId: z.string().nullable().optional(),
    label: z.string().optional()
  }).default({
    mode: 'relays',
    relayUrl: null,
    groupId: null,
    label: 'All Relays'
  }),
  feedControls: z.object({
    query: z.string().default(''),
    sortKey: z.enum(['createdAt', 'kind', 'author', 'content']).default('createdAt'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
    kindFilter: z.array(z.number().int()).nullable().default(null)
  }).default({
    query: '',
    sortKey: 'createdAt',
    sortDirection: 'desc',
    kindFilter: null
  }),
  groupControls: z.object({
    query: z.string().default(''),
    sortKey: z.enum(['name', 'description', 'open', 'public', 'admin', 'createdAt', 'members', 'peers']).default('members'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
    visibility: z.enum(['all', 'public', 'private']).default('all'),
    joinMode: z.enum(['all', 'open', 'closed']).default('all')
  }).default({
    query: '',
    sortKey: 'members',
    sortDirection: 'desc',
    visibility: 'all',
    joinMode: 'all'
  }),
  fileControls: z.object({
    query: z.string().default(''),
    sortKey: z.enum(['fileName', 'group', 'uploadedAt', 'uploadedBy', 'size', 'mime']).default('uploadedAt'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
    mime: z.string().default('all'),
    group: z.string().default('all')
  }).default({
    query: '',
    sortKey: 'uploadedAt',
    sortDirection: 'desc',
    mime: 'all',
    group: 'all'
  }),
  detailPaneOffsetBySection: z.record(z.number().int().nonnegative()).default({}),
  paneViewport: z.record(z.object({
    cursor: z.number().int().nonnegative().default(0),
    offset: z.number().int().nonnegative().default(0)
  })).default({}),
  dismissedGroupInviteIds: z.array(z.string()).default([]),
  acceptedGroupInviteIds: z.array(z.string()).default([]),
  acceptedGroupInviteGroupIds: z.array(z.string()).default([]),
  dismissedChatInviteIds: z.array(z.string()).default([]),
  acceptedChatInviteIds: z.array(z.string()).default([]),
  acceptedChatInviteConversationIds: z.array(z.string()).default([]),
  hiddenDeletedFileKeys: z.array(z.string()).default([]),
  perfOverlayEnabled: z.boolean().default(false)
})

const uiStateV1Schema = z.object({
  version: z.literal(1),
  lastSection: z.string().default('dashboard'),
  noAnimations: z.boolean().default(false),
  lastCopiedValue: z.string().default(''),
  lastCopiedMethod: z.enum(['osc52', 'pbcopy', 'wl-copy', 'xclip', 'xsel', 'none']).default('none'),
  keymap: z.object({
    vimNavigation: z.boolean().default(false)
  }).default({ vimNavigation: false })
})

export const uiStateV2Schema = z.object({
  version: z.literal(2),
  lastSection: z.string().default('dashboard'),
  noAnimations: z.boolean().default(false),
  lastCopiedValue: z.string().default(''),
  lastCopiedMethod: z.enum(['osc52', 'pbcopy', 'wl-copy', 'xclip', 'xsel', 'none']).default('none'),
  keymap: z.object({
    vimNavigation: z.boolean().default(false)
  }).default({ vimNavigation: false }),
  accountScoped: z.record(accountScopedUiStateSchema).default({})
})

export const uiStateV3Schema = z.object({
  version: z.literal(3),
  lastSection: z.string().default('dashboard'),
  noAnimations: z.boolean().default(false),
  lastCopiedValue: z.string().default(''),
  lastCopiedMethod: z.enum(['osc52', 'pbcopy', 'wl-copy', 'xclip', 'xsel', 'none']).default('none'),
  keymap: z.object({
    vimNavigation: z.boolean().default(false)
  }).default({ vimNavigation: false }),
  accountScoped: z.record(accountScopedUiStateSchema).default({})
})

export type UiState = z.infer<typeof uiStateV3Schema>
export type AccountScopedUiState = z.infer<typeof accountScopedUiStateSchema>

export const uiStateSchema: z.ZodType<UiState, z.ZodTypeDef, unknown> = z.union([uiStateV3Schema, uiStateV2Schema, uiStateV1Schema]).transform((value) => {
  if (value.version === 3) {
    return value
  }

  if (value.version === 2) {
    return {
      version: 3 as const,
      lastSection: value.lastSection,
      noAnimations: value.noAnimations,
      lastCopiedValue: value.lastCopiedValue,
      lastCopiedMethod: value.lastCopiedMethod,
      keymap: value.keymap,
      accountScoped: value.accountScoped || {}
    }
  }

  return {
    version: 3 as const,
    lastSection: value.lastSection,
    noAnimations: value.noAnimations,
    lastCopiedValue: value.lastCopiedValue,
    lastCopiedMethod: value.lastCopiedMethod,
    keymap: value.keymap,
    accountScoped: {}
  }
})

export const userCacheSchema = z.object({
  version: z.literal(1),
  pubkey: z.string().regex(/^[a-f0-9]{64}$/),
  recentFeedEventIds: z.array(z.string()).default([]),
  recentSearches: z.array(z.object({ mode: z.string(), query: z.string(), at: z.number() })).default([])
})

export type UserCache = z.infer<typeof userCacheSchema>

export function defaultAccountsFile(): AccountsFile {
  return {
    version: 1,
    currentPubkey: null,
    accounts: []
  }
}

export function defaultUiState(): UiState {
  return {
    version: 3,
    lastSection: 'dashboard',
    noAnimations: false,
    lastCopiedValue: '',
    lastCopiedMethod: 'none',
    keymap: {
      vimNavigation: false
    },
    accountScoped: {}
  }
}
