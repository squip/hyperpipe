import { z } from 'zod'

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
  groupViewTab: z.enum(['discover', 'my', 'invites']).default('discover'),
  chatViewTab: z.enum(['conversations', 'invites']).default('conversations'),
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

export type UiState = z.infer<typeof uiStateV2Schema>
export type AccountScopedUiState = z.infer<typeof accountScopedUiStateSchema>

export const uiStateSchema: z.ZodType<UiState, z.ZodTypeDef, unknown> = z.union([uiStateV2Schema, uiStateV1Schema]).transform((value) => {
  if (value.version === 2) {
    return value
  }

  return {
    version: 2 as const,
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
    version: 2,
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
