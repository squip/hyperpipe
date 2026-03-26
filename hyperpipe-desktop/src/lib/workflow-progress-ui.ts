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

export type CreateConversationProgressPhase =
  | 'idle'
  | 'creatingConversation'
  | 'openingConversation'
  | 'success'
  | 'error'

export type CreateConversationProgressState = {
  phase: CreateConversationProgressPhase
  error?: string | null
}

export type JoinConversationProgressPhase =
  | 'idle'
  | 'joiningConversation'
  | 'openingConversation'
  | 'success'
  | 'error'

export type JoinConversationProgressState = {
  phase: JoinConversationProgressPhase
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

export function getCreateConversationProgressValue(
  state?: CreateConversationProgressState | null
): number {
  switch (state?.phase) {
    case 'creatingConversation':
      return 18
    case 'openingConversation':
      return 96
    case 'success':
      return 100
    default:
      return 0
  }
}

export function getCreateConversationProgressLabel(
  state?: CreateConversationProgressState | null
): string | null {
  switch (state?.phase) {
    case 'creatingConversation':
      return 'Creating chat…'
    case 'openingConversation':
      return 'Opening chat…'
    default:
      return null
  }
}

export function getCreateConversationProgressTitle(
  phase?: CreateConversationProgressPhase | null
): string {
  if (phase === 'success') return 'Chat created'
  return 'Creating chat…'
}

export function getJoinConversationProgressValue(
  phase?: JoinConversationProgressPhase | null
): number {
  switch (phase) {
    case 'joiningConversation':
      return 34
    case 'openingConversation':
      return 92
    case 'success':
      return 100
    default:
      return 0
  }
}

export function getJoinConversationProgressLabel(
  phase?: JoinConversationProgressPhase | null
): string | null {
  switch (phase) {
    case 'joiningConversation':
      return 'Accepting invite…'
    case 'openingConversation':
      return 'Opening chat…'
    default:
      return null
  }
}

export function getJoinConversationProgressTitle(
  phase?: JoinConversationProgressPhase | null
): string {
  if (phase === 'success') return 'Chat joined'
  return 'Joining chat…'
}
