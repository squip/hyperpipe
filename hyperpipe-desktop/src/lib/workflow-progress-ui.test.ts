import { describe, expect, it } from 'vitest'

import {
  getCreateGroupProgressLabel,
  getCreateGroupProgressValue
} from '@/lib/workflow-progress-ui'

describe('workflow-progress-ui', () => {
  it('maps the public group discovery stage to user-facing copy and progress', () => {
    expect(getCreateGroupProgressLabel('publishingDiscovery')).toBe('Publishing discovery…')
    expect(getCreateGroupProgressValue('publishingDiscovery')).toBeGreaterThan(0)
  })
})
