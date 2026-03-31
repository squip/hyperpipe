import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import GroupCreateDialog from '@/components/GroupCreateDialog'

const {
  createHyperpipeRelayGroupMock,
  toastErrorMock,
  toastSuccessMock
} = vi.hoisted(() => ({
  createHyperpipeRelayGroupMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value
  })
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock
  }
}))

vi.mock('@/providers/GroupsProvider', () => ({
  useGroups: () => ({
    createHyperpipeRelayGroup: createHyperpipeRelayGroupMock
  })
}))

vi.mock('@/providers/WorkerBridgeProvider', () => ({
  useWorkerBridge: () => ({
    publicGatewayStatus: null
  })
}))

vi.mock('@/hooks/useFetchProfile', () => ({
  useFetchProfile: () => ({
    profile: null
  })
}))

vi.mock('@/components/PostEditor/Uploader', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

describe('GroupCreateDialog progress UX', () => {
  beforeEach(() => {
    createHyperpipeRelayGroupMock.mockReset()
    toastErrorMock.mockReset()
    toastSuccessMock.mockReset()
  })

  it('shows the public discovery progress stage and locks the dialog while saving', async () => {
    let resolveCreate: (() => void) | null = null
    createHyperpipeRelayGroupMock.mockImplementation(
      async (_payload: unknown, options?: { onProgress?: (state: { phase: string }) => void }) => {
        options?.onProgress?.({ phase: 'creatingRelay' })
        options?.onProgress?.({ phase: 'publishingDiscovery' })
        await new Promise<void>((resolve) => {
          resolveCreate = resolve
        })
        options?.onProgress?.({ phase: 'success' })
        return { groupId: 'group-1', relay: 'wss://relay.example' }
      }
    )

    const onOpenChange = vi.fn()
    render(<GroupCreateDialog open onOpenChange={onOpenChange} />)

    fireEvent.change(screen.getByPlaceholderText('Enter group name'), {
      target: { value: 'Progress Group' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Group' }))

    expect(await screen.findByText('Publishing discovery…')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter group name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    resolveCreate?.()

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalled()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('skips discovery copy for private groups and keeps form state on error', async () => {
    createHyperpipeRelayGroupMock.mockImplementation(
      async (
        payload: { isPublic?: boolean },
        options?: {
          onProgress?: (state: { phase: string; error?: string }) => void
        }
      ) => {
        expect(payload.isPublic).toBe(false)
        options?.onProgress?.({ phase: 'creatingRelay' })
        options?.onProgress?.({ phase: 'savingGroupList' })
        options?.onProgress?.({ phase: 'error', error: 'bootstrap failed' })
        throw new Error('bootstrap failed')
      }
    )

    render(<GroupCreateDialog open onOpenChange={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('Enter group name'), {
      target: { value: 'Private Group' }
    })
    fireEvent.click(screen.getAllByRole('switch')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create Group' }))

    expect(await screen.findByText('Saving to your groups…')).toBeInTheDocument()
    expect(screen.queryByText('Publishing discovery…')).not.toBeInTheDocument()
    expect(await screen.findByText('bootstrap failed')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter group name')).toHaveValue('Private Group')
    expect(toastErrorMock).toHaveBeenCalled()
  })
})
