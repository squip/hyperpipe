export type CreateGroupProgressPhase =
  | 'idle'
  | 'creatingRelay'
  | 'publishingDiscovery'
  | 'savingGroupList'
  | 'verifyingBootstrap'
  | 'publishingMembershipSnapshots'
  | 'success'
  | 'error'

export type CreateGroupProgressState = {
  phase: CreateGroupProgressPhase
  error?: string | null
}

export function getCreateGroupProgressValue(phase?: CreateGroupProgressPhase | null): number {
  switch (phase) {
    case 'creatingRelay':
      return 14
    case 'publishingDiscovery':
      return 30
    case 'savingGroupList':
      return 48
    case 'verifyingBootstrap':
      return 72
    case 'publishingMembershipSnapshots':
      return 88
    case 'success':
      return 100
    default:
      return 0
  }
}

export function getCreateGroupProgressLabel(
  phase?: CreateGroupProgressPhase | null
): string | null {
  switch (phase) {
    case 'creatingRelay':
      return 'Starting relay…'
    case 'publishingDiscovery':
      return 'Publishing discovery…'
    case 'savingGroupList':
      return 'Saving to your groups…'
    case 'verifyingBootstrap':
      return 'Verifying relay…'
    case 'publishingMembershipSnapshots':
      return 'Publishing membership…'
    default:
      return null
  }
}

export function getCreateGroupProgressTitle(phase?: CreateGroupProgressPhase | null): string {
  if (phase === 'success') return 'Group created'
  return 'Creating group…'
}
