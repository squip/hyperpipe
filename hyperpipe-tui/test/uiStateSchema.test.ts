import { describe, expect, it } from 'vitest'
import { uiStateSchema } from '../src/storage/schema.js'

describe('uiStateSchema focusPane normalization', () => {
  it('maps legacy center focusPane to right-top on parse', () => {
    const key = 'legacy-user'
    const parsed = uiStateSchema.parse({
      version: 3,
      accountScoped: {
        [key]: {
          focusPane: 'center'
        }
      }
    })

    expect(parsed.accountScoped[key]?.focusPane).toBe('right-top')
  })

  it('defaults profileNameCacheByPubkey to empty map for legacy account-scoped state', () => {
    const key = 'legacy-user'
    const parsed = uiStateSchema.parse({
      version: 3,
      accountScoped: {
        [key]: {
          selectedNode: 'dashboard'
        }
      }
    })

    expect(parsed.accountScoped[key]?.profileNameCacheByPubkey).toEqual({})
  })
})
