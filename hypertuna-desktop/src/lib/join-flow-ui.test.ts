import { describe, expect, it } from 'vitest'
import {
  formatJoinFlowErrorMessage,
  getJoinFlowPhaseLabel,
  getJoinFlowProgressValue
} from '@/lib/join-flow-ui'

describe('join-flow-ui', () => {
  it('maps request phase to the plain-language peer step', () => {
    expect(getJoinFlowPhaseLabel('request')).toBe('Contacting peers…')
    expect(getJoinFlowProgressValue('request')).toBeGreaterThan(0)
  })

  it('normalizes technical timeout errors into simple user copy', () => {
    expect(
      formatJoinFlowErrorMessage({
        reason: 'deadline-exceeded',
        error: 'Failed to start join flow: join-deadline-exceeded'
      })
    ).toBe('Could not reach the group in time. Try again.')
  })

  it('normalizes invite and access-token failures into simple user copy', () => {
    expect(
      formatJoinFlowErrorMessage({
        error: 'Failed to start join flow: invalid invite token'
      })
    ).toBe('This invite or access code did not work.')
  })
})
