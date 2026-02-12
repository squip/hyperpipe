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

export const uiStateSchema = z.object({
  version: z.literal(1),
  lastSection: z.string().default('dashboard'),
  noAnimations: z.boolean().default(false),
  keymap: z.object({
    vimNavigation: z.boolean().default(false)
  }).default({ vimNavigation: false })
})

export type UiState = z.infer<typeof uiStateSchema>

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
    version: 1,
    lastSection: 'dashboard',
    noAnimations: false,
    keymap: {
      vimNavigation: false
    }
  }
}
