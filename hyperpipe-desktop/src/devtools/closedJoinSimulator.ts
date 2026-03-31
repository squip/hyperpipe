import type { TGroupInvite } from '@/types/groups'
import type { TGroupGatewayAccess } from '@/types/groups'

type ClosedJoinSimulatorDeps = {
  groupId: string
  relay?: string | null
  relayUrl?: string | null
  relayKeyForGroup?: string | null
  inviteData?: TGroupInvite | null
  isOpenGroup?: boolean
  startJoinFlow: (
    publicIdentifier: string,
    opts?: {
      fileSharing?: boolean
      isOpen?: boolean
      token?: string
      relayKey?: string | null
      relayUrl?: string | null
      gatewayAccess?: TGroupGatewayAccess | null
      blindPeer?: {
        publicKey?: string | null
        encryptionKey?: string | null
        replicationTopic?: string | null
        maxBytes?: number | null
      } | null
      cores?: { key: string; role?: string | null }[]
      writerCore?: string | null
      writerCoreHex?: string | null
      autobaseLocal?: string | null
      writerSecret?: string | null
      openJoin?: boolean
    }
  ) => Promise<void>
  sendJoinRequest: (groupId: string, relay?: string, code?: string, reason?: string) => Promise<void>
  loadJoinRequests: (groupId: string, relay?: string) => Promise<void>
  approveJoinRequest: (groupId: string, pubkey: string, relay?: string) => Promise<void>
  sendInvites: (
    groupId: string,
    invitees: string[],
    relay?: string,
    options?: { isOpen?: boolean; name?: string; about?: string }
  ) => Promise<void>
}

const classifyRelayKey = (value?: string | null) => {
  if (!value) return 'unknown'
  return /^[0-9a-fA-F]{64}$/.test(value) ? 'hex' : 'alias'
}

const summarizeInvite = (invite?: TGroupInvite | null) => {
  if (!invite) return null
  return {
    relayKey: invite.relayKey ? String(invite.relayKey).slice(0, 16) : null,
    relayKeyType: classifyRelayKey(invite.relayKey || undefined),
    relayUrl: invite.relayUrl ? String(invite.relayUrl).slice(0, 80) : null,
    hasToken: !!invite.token,
    hasWriterSecret: !!invite.writerSecret,
    writerSecretLen: invite.writerSecret ? String(invite.writerSecret).length : 0,
    writerCore: invite.writerCore ? String(invite.writerCore).slice(0, 16) : null,
    writerCoreHex: invite.writerCoreHex ? String(invite.writerCoreHex).slice(0, 16) : null,
    autobaseLocal: invite.autobaseLocal ? String(invite.autobaseLocal).slice(0, 16) : null,
    coresCount: Array.isArray(invite.cores) ? invite.cores.length : 0,
    blindPeerKey: invite.blindPeer?.publicKey ? String(invite.blindPeer.publicKey).slice(0, 16) : null
  }
}

export function registerClosedJoinSimulator(deps: ClosedJoinSimulatorDeps) {
  if (typeof window === 'undefined') return
  if (process.env.NODE_ENV !== 'development') return

  const {
    groupId,
    relay,
    relayUrl,
    relayKeyForGroup,
    inviteData,
    isOpenGroup,
    startJoinFlow,
    sendJoinRequest,
    loadJoinRequests,
    approveJoinRequest,
    sendInvites
  } = deps

  const safe = async (label: string, fn: () => Promise<void>) => {
    const start = Date.now()
    try {
      console.info(`[ClosedJoinSim] ${label} start`, { groupId, relay })
      await fn()
      console.info(`[ClosedJoinSim] ${label} complete in ${Date.now() - start}ms`)
    } catch (err) {
      console.error(`[ClosedJoinSim] ${label} failed`, err)
    }
  }

  const sendClosedInvite = async (inviteePubkey: string, options?: { name?: string; about?: string }) => {
    await safe('send-closed-invite', async () => {
      await sendInvites(groupId, [inviteePubkey], relay || undefined, {
        isOpen: false,
        name: options?.name,
        about: options?.about
      })
    })
  }

  const runApprovalFlow = async (requesterPubkey: string) => {
    await safe('closed-approval-flow', async () => {
      await sendJoinRequest(groupId, relay || undefined)
      await loadJoinRequests(groupId, relay || undefined)
      await approveJoinRequest(groupId, requesterPubkey, relay || undefined)
    })
  }

  const startJoinFromInvite = async () => {
    await safe('join-from-invite', async () => {
      if (!inviteData) {
        console.warn('[ClosedJoinSim] No invite data available; switch to invitee account first', {
          groupId,
          relay
        })
        return
      }
      console.info('[ClosedJoinSim] Invite summary', summarizeInvite(inviteData))
      const relayKey = inviteData.relayKey || relayKeyForGroup || null
      const relayUrlForJoin = inviteData.relayUrl || relayUrl || relay || null
      await startJoinFlow(groupId, {
        fileSharing: inviteData.fileSharing !== false,
        isOpen: false,
        openJoin: false,
        token: inviteData.token,
        relayKey,
        relayUrl: relayUrlForJoin,
        gatewayAccess: inviteData.gatewayAccess || undefined,
        blindPeer: inviteData.blindPeer,
        cores: inviteData.cores,
        writerCore: inviteData.writerCore,
        writerCoreHex: inviteData.writerCoreHex,
        autobaseLocal: inviteData.autobaseLocal,
        writerSecret: inviteData.writerSecret
      })
    })
  }

  const printInvite = () => {
    console.info('[ClosedJoinSim] Invite summary', summarizeInvite(inviteData))
  }

  const expectedLogs = () => {
    console.info('[ClosedJoinSim] Expected log markers', {
      worker: [
        'Provisioned writer for invitee',
        'Mirror metadata request',
        'Mirror metadata response',
        'Start join flow input',
        'Start join flow resolved',
        'Falling back to invite token path (no direct host)',
        'join-auth-success'
      ],
      gateway: [
        'Mirror metadata request',
        'Mirror metadata resolved',
        'Relay registration accepted',
        'Relay token issue request'
      ]
    })
  }

  ;(window as any).__HYT_CLOSED_JOIN_SIM__ = {
    sendClosedInvite,
    runApprovalFlow,
    startJoinFromInvite,
    printInvite,
    expectedLogs
  }

  console.info('[ClosedJoinSim] registered on window.__HYT_CLOSED_JOIN_SIM__', {
    groupId,
    relay,
    relayKeyType: classifyRelayKey(relayKeyForGroup || undefined),
    isOpenGroup
  })
}
