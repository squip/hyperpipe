import { describe, expect, it } from 'vitest'

import {
  getCreateConversationProgressLabel,
  getCreateConversationProgressValue,
  getCreateGroupProgressLabel,
  getCreateGroupProgressValue,
  getJoinConversationProgressLabel,
  getJoinConversationProgressValue
} from '@/lib/workflow-progress-ui'

describe('workflow-progress-ui', () => {
  it('maps the public group discovery stage to user-facing copy and progress', () => {
    expect(getCreateGroupProgressLabel('publishingDiscovery')).toBe('Publishing discovery…')
    expect(getCreateGroupProgressValue('publishingDiscovery')).toBeGreaterThan(0)
  })

  it('limits create-chat modal progress to the pre-ack phases', () => {
    expect(
      getCreateConversationProgressLabel({
        phase: 'creatingConversation'
      })
    ).toBe('Creating chat…')
    expect(
      getCreateConversationProgressValue({
        phase: 'openingConversation'
      })
    ).toBeGreaterThan(
      getCreateConversationProgressValue({
        phase: 'creatingConversation'
      })
    )
  })

  it('limits join-chat inline progress to the pre-open phases', () => {
    expect(getJoinConversationProgressLabel('joiningConversation')).toBe('Accepting invite…')
    expect(getJoinConversationProgressLabel('openingConversation')).toBe('Opening chat…')
    expect(getJoinConversationProgressValue('openingConversation')).toBeGreaterThan(
      getJoinConversationProgressValue('joiningConversation')
    )
  })
})
