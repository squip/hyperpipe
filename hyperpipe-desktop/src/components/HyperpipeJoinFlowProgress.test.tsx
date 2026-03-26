import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import HyperpipeJoinFlowProgress from '@/components/HyperpipeJoinFlowProgress'

describe('HyperpipeJoinFlowProgress', () => {
  it('renders the join wrapper through the shared workflow progress UI', () => {
    render(<HyperpipeJoinFlowProgress phase="request" />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Joining group…')).toBeInTheDocument()
    expect(screen.getByText('Contacting peers…')).toBeInTheDocument()
  })
})
