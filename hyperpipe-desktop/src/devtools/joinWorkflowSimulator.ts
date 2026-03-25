import { randomString } from '@/lib/random'

type SimulatorDeps = {
  groupId: string
  relay?: string
  startJoinFlow: (publicIdentifier: string, opts?: { fileSharing?: boolean }) => Promise<void>
  sendJoinRequest: (groupId: string, relay?: string, code?: string) => Promise<void>
  approveJoinRequest: (groupId: string, pubkey: string, relay?: string) => Promise<void>
  rejectJoinRequest: (groupId: string, pubkey: string, relay?: string) => Promise<void>
  sendInvites: (
    groupId: string,
    invitees: string[],
    relay?: string,
    options?: { isOpen?: boolean; name?: string; about?: string }
  ) => Promise<void>
  loadJoinRequests: (groupId: string, relay?: string) => Promise<void>
}

const TEST_PUBKEYS = {
  requester: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  requester2: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  admin: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
}

/**
 * Attaches a dev-only simulator to window.__HYT_JOIN_SIM__ to exercise join/invite flows
 * without navigating away from the current GroupPage. Intended for manual runs in devtools.
 */
export function registerJoinWorkflowSimulator(deps: SimulatorDeps) {
  if (typeof window === 'undefined') return
  if (process.env.NODE_ENV !== 'development') return
  const { groupId, relay } = deps

  const safe = async (label: string, fn: () => Promise<void>) => {
    const start = Date.now()
    try {
      console.info(`[JoinSimulator] ${label} start`, { groupId, relay })
      await fn()
      console.info(`[JoinSimulator] ${label} complete in ${Date.now() - start}ms`)
    } catch (err) {
      console.error(`[JoinSimulator] ${label} failed`, err)
    }
  }

  const runOpenPublic = async () => {
    await safe('open-public', async () => {
      await deps.startJoinFlow(groupId, { fileSharing: true })
    })
  }

  const runOpenPrivate = async () => {
    await safe('open-private', async () => {
      await deps.startJoinFlow(groupId, { fileSharing: true })
    })
  }

  const runClosedPublic = async () => {
    await safe('closed-public', async () => {
      await deps.sendJoinRequest(groupId, relay)
      await deps.loadJoinRequests(groupId, relay)
      await deps.approveJoinRequest(groupId, TEST_PUBKEYS.requester, relay)
    })
  }

  const runClosedPrivate = async () => {
    await safe('closed-private', async () => {
      const inviteCode = randomString(8)
      await deps.sendJoinRequest(groupId, relay, inviteCode)
      await deps.loadJoinRequests(groupId, relay)
      await deps.rejectJoinRequest(groupId, TEST_PUBKEYS.requester2, relay)
    })
  }

  const runInviteFlow = async () => {
    await safe('invite-flow', async () => {
      await deps.sendInvites(groupId, [TEST_PUBKEYS.requester], relay)
    })
  }

  ;(window as any).__HYT_JOIN_SIM__ = {
    runOpenPublic,
    runOpenPrivate,
    runClosedPublic,
    runClosedPrivate,
    runInviteFlow
  }

  console.info('[JoinSimulator] registered on window.__HYT_JOIN_SIM__', {
    groupId,
    relay
  })
}
