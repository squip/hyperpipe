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

  it('shows thumbnail upload progress with the current percent', () => {
    expect(
      getCreateConversationProgressLabel({
        phase: 'uploadingThumbnail',
        uploadProgress: 25
      })
    ).toBe('Uploading thumbnail… 25%')
    expect(
      getCreateConversationProgressValue({
        phase: 'uploadingThumbnail',
        uploadProgress: 25
      })
    ).toBeGreaterThan(getCreateConversationProgressValue({ phase: 'syncingConversation' }))
  })

  it('maps join-chat sync to a distinct progress step', () => {
    expect(getJoinConversationProgressLabel('syncingConversation')).toBe('Syncing chat…')
    expect(getJoinConversationProgressValue('syncingConversation')).toBeGreaterThan(
      getJoinConversationProgressValue('joiningConversation')
    )
  })
})
