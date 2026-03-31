export type JoinFlowUiPhase =
  | 'idle'
  | 'starting'
  | 'request'
  | 'verify'
  | 'complete'
  | 'success'
  | 'error'
  | null
  | undefined

export type JoinFlowUiState = {
  phase?: JoinFlowUiPhase
  reason?: string | null
  error?: string | null
}

export function getJoinFlowProgressValue(phase: JoinFlowUiPhase): number {
  switch (phase) {
    case 'starting':
      return 18
    case 'request':
      return 42
    case 'verify':
      return 68
    case 'complete':
      return 88
    case 'success':
      return 100
    default:
      return 0
  }
}

export function getJoinFlowPhaseLabel(phase: JoinFlowUiPhase): string | null {
  switch (phase) {
    case 'starting':
      return 'Preparing join…'
    case 'request':
      return 'Contacting peers…'
    case 'verify':
      return 'Checking access…'
    case 'complete':
      return 'Finishing setup…'
    default:
      return null
  }
}

export function getJoinFlowTitle(phase: JoinFlowUiPhase): string {
  if (phase === 'success') return 'Group joined'
  return 'Joining group…'
}

function normalizeJoinFlowErrorText(error?: string | null): string {
  const value = String(error || '').trim()
  if (!value) return ''
  return value.replace(/^failed to start join flow:\s*/i, '').trim()
}

export function formatJoinFlowErrorMessage(state?: JoinFlowUiState | null): string {
  const reason = String(state?.reason || '').trim().toLowerCase()
  const raw = normalizeJoinFlowErrorText(state?.error)
  const normalized = raw.toLowerCase()

  if (
    reason === 'deadline-exceeded'
    || normalized.includes('deadline')
    || normalized.includes('timed out')
    || normalized.includes('timeout')
  ) {
    return 'Could not reach the group in time. Try again.'
  }

  if (
    reason === 'no-writer-path'
    || normalized.includes('no-writer-path')
    || normalized.includes('writer material')
    || normalized.includes('closed join pending')
    || normalized.includes('verified direct candidate')
  ) {
    return 'No group peer could complete the join right now. Try again in a moment.'
  }

  if (
    normalized.includes('invalid token')
    || normalized.includes('auth token')
    || normalized.includes('invite token')
    || normalized.includes('invalid invite')
    || normalized.includes('expired invite')
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
  ) {
    return 'This invite or access code did not work.'
  }

  if (
    normalized.includes('no usable peers')
    || normalized.includes('no peers')
    || normalized.includes('no peer')
    || normalized.includes('peer unavailable')
  ) {
    return 'No group peers are reachable right now. Try again in a moment.'
  }

  if (
    normalized.includes('relay server not initialized')
    || normalized.includes('gateway unavailable')
    || normalized.includes('gateway not ready')
    || normalized.includes('not initialized')
  ) {
    return 'The group is not ready yet. Try again in a moment.'
  }

  return 'Could not join this group right now.'
}
