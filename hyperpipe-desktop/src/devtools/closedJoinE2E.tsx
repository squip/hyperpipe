import { useEffect, useRef } from 'react'
import { useNostr } from '@/providers/NostrProvider'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { electronIpc } from '@/services/electron-ipc.service'
import client from '@/services/client.service'
import { generateSecretKey, getPublicKey } from '@nostr/tools/wasm'
import { nsecEncode, npubEncode } from '@nostr/tools/nip19'
import * as nip49 from '@nostr/tools/nip49'
import type { Filter } from '@nostr/tools/filter'
import type { TGroupInvite } from '@/types/groups'
import { StorageKey } from '@/constants'

type AccountSeed = {
  pubkey: string
  npub: string
  nsec: string
  ncryptsec?: string
}

type E2EOptions = {
  inviteeCount?: number
  groupPrefix?: string
  isPublic?: boolean
  singleGroup?: boolean
  mirrorTimeoutMs?: number
  joinTimeoutMs?: number
  resetAccounts?: boolean
  disableAutostart?: boolean
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async <T,>(
  label: string,
  fn: () => T | Promise<T>,
  {
    timeoutMs = 120_000,
    intervalMs = 1_000
  }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> => {
  const start = Date.now()
  let lastError: unknown = null
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastError = err
    }
    await delay(intervalMs)
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError || 'timeout')
  throw new Error(`${label} timed out: ${msg}`)
}

const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)

const normalizeRelayKey = (value?: string | null) => {
  if (!value) return null
  const trimmed = String(value).trim()
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

const formatAggregateError = (error: any) => {
  if (!error) return null
  const errors = Array.isArray(error.errors) ? error.errors : []
  if (!errors.length) return null
  return errors
    .map((err: unknown) => (err instanceof Error ? err.message : String(err)))
    .filter(Boolean)
    .join('; ')
}

export default function ClosedJoinE2EBridge(): null {
  const {
    nsecLogin,
    ncryptsecLogin,
    publish,
    pubkey,
    nsecHex,
    accounts,
    removeAccount,
    switchAccount
  } = useNostr()
  const {
    createHyperpipeRelayGroup,
    sendInvites,
    resolveRelayUrl,
    refreshInvites,
    invites
  } = useGroups()
  const {
    ready,
    statusV1,
    configAppliedV1,
    startWorker,
    stopWorker,
    restartWorker,
    joinFlows,
    relays,
    publicGatewayStatus,
    startJoinFlow,
    autostartEnabled,
    setAutostartEnabled
  } = useWorkerBridge()

  const invitesRef = useRef(invites)
  const joinFlowsRef = useRef(joinFlows)
  const relaysRef = useRef(relays)
  const readyRef = useRef(ready)
  const gatewayRef = useRef(publicGatewayStatus)
  const pubkeyRef = useRef(pubkey)
  const nsecHexRef = useRef(nsecHex)
  const accountsRef = useRef(accounts)
  const statusRef = useRef(statusV1)
  const configAppliedRef = useRef(configAppliedV1)
  const autostartEnabledRef = useRef(autostartEnabled)
  const createGroupRef = useRef(createHyperpipeRelayGroup)
  const sendInvitesRef = useRef(sendInvites)
  const resolveRelayUrlRef = useRef(resolveRelayUrl)
  const refreshInvitesRef = useRef(refreshInvites)
  const lastLoginPubkeyRef = useRef<string | null>(null)
  const tokenOwnersRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    invitesRef.current = invites
  }, [invites])
  useEffect(() => {
    joinFlowsRef.current = joinFlows
  }, [joinFlows])
  useEffect(() => {
    relaysRef.current = relays
  }, [relays])
  useEffect(() => {
    readyRef.current = ready
  }, [ready])
  useEffect(() => {
    gatewayRef.current = publicGatewayStatus
  }, [publicGatewayStatus])
  useEffect(() => {
    pubkeyRef.current = pubkey
  }, [pubkey])
  useEffect(() => {
    nsecHexRef.current = nsecHex
  }, [nsecHex])
  useEffect(() => {
    accountsRef.current = accounts
  }, [accounts])
  useEffect(() => {
    statusRef.current = statusV1
  }, [statusV1])
  useEffect(() => {
    configAppliedRef.current = configAppliedV1
  }, [configAppliedV1])
  useEffect(() => {
    autostartEnabledRef.current = autostartEnabled
  }, [autostartEnabled])
  useEffect(() => {
    createGroupRef.current = createHyperpipeRelayGroup
  }, [createHyperpipeRelayGroup])
  useEffect(() => {
    sendInvitesRef.current = sendInvites
  }, [sendInvites])
  useEffect(() => {
    resolveRelayUrlRef.current = resolveRelayUrl
  }, [resolveRelayUrl])
  useEffect(() => {
    refreshInvitesRef.current = refreshInvites
  }, [refreshInvites])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    if (typeof window === 'undefined') return

    const generateAccounts = (count: number, password?: string | null) => {
      const results: AccountSeed[] = []
      const total = Math.max(1, Math.trunc(count))
      for (let i = 0; i < total; i += 1) {
        const sk = generateSecretKey()
        const pubkey = getPublicKey(sk)
        const ncryptsec = password ? nip49.encrypt(sk, password) : undefined
        results.push({
          pubkey,
          npub: npubEncode(pubkey),
          nsec: nsecEncode(sk),
          ncryptsec
        })
      }
      return results
    }

    const ensureWorkerReady = async () => {
      await waitFor(
        'nostr-identity-ready',
        () =>
          isHex64(pubkeyRef.current) && isHex64(nsecHexRef.current) ? true : null,
        { timeoutMs: 30_000, intervalMs: 500 }
      )
      if (!readyRef.current) {
        try {
          await startWorker()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (
            message.includes('requires nsec/ncryptsec login') ||
            message.includes('requires a local nsec/ncryptsec account')
          ) {
            const pubkeyHex = pubkeyRef.current
            const nsecHex = nsecHexRef.current
            if (!electronIpc.isElectron()) {
              throw err
            }
            if (!isHex64(pubkeyHex) || !isHex64(nsecHex)) {
              throw err
            }
            let nostr_npub: string | null = null
            try {
              nostr_npub = npubEncode(pubkeyHex.toLowerCase())
            } catch (_npubErr) {
              // ignore
            }
            await electronIpc.startWorker({
              nostr_pubkey_hex: pubkeyHex.toLowerCase(),
              nostr_nsec_hex: nsecHex.toLowerCase(),
              nostr_npub: nostr_npub || undefined,
              userKey: pubkeyHex.toLowerCase()
            })
          } else {
            throw err
          }
        }
      }
      await waitFor('worker-ready', () => readyRef.current === true, { timeoutMs: 120_000 })
    }

    const resolveWorkerPubkey = () => {
      const fromStatus = statusRef.current?.state?.user?.pubkeyHex || null
      const fromConfig = (configAppliedRef.current as any)?.data?.user?.pubkeyHex || null
      return (fromConfig || fromStatus || null) as string | null
    }

    const fetchWorkerIdentity = async () => {
      if (!electronIpc.isElectron()) return null
      try {
        const res = await electronIpc.getWorkerIdentity()
        if (res?.success) return res.identity || null
      } catch (_err) {
        // ignore
      }
      return null
    }

    const waitForWorkerIdentity = async (expectedPubkey?: string | null) => {
      const expected = expectedPubkey ? expectedPubkey.toLowerCase() : null
      return waitFor(
        'worker-identity',
        async () => {
          const current = resolveWorkerPubkey()
          if (current) {
            const normalized = String(current).toLowerCase()
            if (!expected || normalized === expected) {
              return normalized
            }
          }
          const identity = await fetchWorkerIdentity()
          const identityPubkey = (identity as any)?.pubkeyHex || (identity as any)?.nostr_pubkey_hex || null
          if (!identityPubkey) return null
          const identityNormalized = String(identityPubkey).toLowerCase()
          if (expected && identityNormalized !== expected) return null
          return identityNormalized
        },
        { timeoutMs: 120_000, intervalMs: 1_000 }
      )
    }

    const waitForGroupsApi = async (expectedPubkey?: string | null) => {
      return waitFor(
        'groups-api-ready',
        () => {
          if (!isHex64(pubkeyRef.current)) return null
          if (expectedPubkey && pubkeyRef.current !== expectedPubkey) return null
          if (!createGroupRef.current || !sendInvitesRef.current || !refreshInvitesRef.current) return null
          return true
        },
        { timeoutMs: 30_000, intervalMs: 500 }
      )
    }

    const resetE2EAccounts = async () => {
      console.info('[ClosedJoinE2E] Resetting cached accounts before run')
      tokenOwnersRef.current.clear()
      lastLoginPubkeyRef.current = null

      if (stopWorker) {
        await stopWorker().catch(() => {})
      }

      try {
        await switchAccount(null)
      } catch (_err) {
        // ignore
      }

      const existingAccounts = accountsRef.current || []
      existingAccounts.forEach((account) => {
        try {
          removeAccount(account)
        } catch (_err) {
          // ignore
        }
      })

      try {
        window.localStorage.removeItem(StorageKey.ACCOUNTS)
        window.localStorage.removeItem(StorageKey.CURRENT_ACCOUNT)
      } catch (_err) {
        // ignore
      }

      await waitFor(
        'account-clear',
        () => (!pubkeyRef.current && !nsecHexRef.current ? true : null),
        { timeoutMs: 15_000, intervalMs: 300 }
      )
    }

    const parseRelayToken = (relayUrl?: string | null) => {
      if (!relayUrl) return null
      try {
        const parsed = new URL(relayUrl)
        const token = parsed.searchParams.get('token')
        return token ? String(token) : null
      } catch (_err) {
        return null
      }
    }

    const waitForRelayToken = async (token: string, label: string) => {
      return waitFor(
        `relay-token-visible:${label}`,
        () => {
          const list = relaysRef.current || []
          return (
            list.find((entry) => entry?.userAuthToken === token) ||
            list.find((entry) => typeof entry?.connectionUrl === 'string' && entry.connectionUrl.includes(token)) ||
            null
          )
        },
        { timeoutMs: 30_000, intervalMs: 1_000 }
      )
    }

    const assertAuthContext = async ({
      label,
      expectedPubkey,
      relayUrl,
      authToken
    }: {
      label: string
      expectedPubkey: string
      relayUrl?: string | null
      authToken?: string | null
    }) => {
      const expected = expectedPubkey?.toLowerCase()
      if (!expected) {
        throw new Error(`[${label}] Missing expected pubkey for auth context`)
      }
      const currentPubkey = pubkeyRef.current?.toLowerCase() || null
      if (currentPubkey && currentPubkey !== expected) {
        throw new Error(`[${label}] Renderer pubkey mismatch (renderer=${currentPubkey}, expected=${expected})`)
      }
      await waitForSignerPubkey(expected)
      await waitForWorkerIdentity(expected)
      const token = authToken || parseRelayToken(relayUrl || null)
      if (token) {
        const existing = tokenOwnersRef.current.get(token)
        if (existing && existing !== expected) {
          throw new Error(
            `[${label}] Relay token owner mismatch (token owner=${existing}, expected=${expected})`
          )
        }
        tokenOwnersRef.current.set(token, expected)
        await waitForRelayToken(token, label)
      }
    }

    const waitForSignerPubkey = async (expectedPubkey?: string | null) => {
      return waitFor(
        'nostr-signer',
        async () => {
          const signer = client.signer
          if (!signer || typeof signer.getPublicKey !== 'function') return null
          let signerPubkey: string | null = null
          try {
            signerPubkey = await signer.getPublicKey()
          } catch (_err) {
            return null
          }
          if (!signerPubkey) return null
          if (expectedPubkey && signerPubkey !== expectedPubkey) return null
          if (expectedPubkey && client.pubkey && client.pubkey !== expectedPubkey) return null
          return signerPubkey
        },
        { timeoutMs: 30_000, intervalMs: 500 }
      )
    }

    const loginWithSeed = async (seed: AccountSeed, password?: string | null) => {
      const expectedPubkey = seed.ncryptsec && password
        ? await ncryptsecLogin(seed.ncryptsec)
        : await nsecLogin(seed.nsec, password || undefined, false)
      await waitFor(
        'nostr-identity',
        () => {
          const currentPubkey = pubkeyRef.current
          const hasNsec = !!nsecHexRef.current
          if (!currentPubkey || !hasNsec) return null
          if (expectedPubkey && currentPubkey !== expectedPubkey) return null
          return true
        },
        { timeoutMs: 30_000, intervalMs: 500 }
      )
      await waitForSignerPubkey(expectedPubkey || null)
      const prevPubkey = lastLoginPubkeyRef.current
      const normalizedExpected = expectedPubkey ? expectedPubkey.toLowerCase() : null
      if (prevPubkey && normalizedExpected && prevPubkey !== normalizedExpected) {
        console.info('[ClosedJoinE2E] Restarting worker for account switch', {
          from: prevPubkey.slice(0, 8),
          to: normalizedExpected.slice(0, 8)
        })
        if (restartWorker) {
          await restartWorker().catch(() => {})
        } else if (stopWorker) {
          await stopWorker().catch(() => {})
        }
      }
      await ensureWorkerReady()
      await waitForWorkerIdentity(expectedPubkey || null)
      lastLoginPubkeyRef.current = normalizedExpected
      return expectedPubkey
    }

    const loginWithSeedAndGroups = async (seed: AccountSeed, password?: string | null) => {
      const pubkey = await loginWithSeed(seed, password)
      await waitForGroupsApi(seed.pubkey)
      return pubkey
    }

    const waitForRelayEntry = async (groupId: string) => {
      return waitFor('relay-entry', () => {
        const list = relaysRef.current || []
        return list.find(
          (entry) =>
            entry.publicIdentifier === groupId ||
            entry.relayKey === groupId
        )
      })
    }

    const fetchMirrorMetadata = async (identifier: string, requestTimeoutMs = 15_000) => {
      const configuredBase =
        gatewayRef.current?.baseUrl ||
        (typeof import.meta !== 'undefined'
          ? ((import.meta.env.VITE_CLOSED_JOIN_E2E_GATEWAY_BASE as string | undefined) || '')
          : '')
      const base = configuredBase.trim()
      if (!base) {
        throw new Error('No mirror gateway base configured')
      }
      const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
      const url = `${trimmedBase}/api/relays/${encodeURIComponent(identifier)}/mirror`
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), requestTimeoutMs)
      try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`mirror ${res.status} ${body || 'error'}`)
        }
        return res.json()
      } catch (err) {
        const isAbort = typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
        const message = err instanceof Error ? err.message : String(err)
        const detail = isAbort ? `mirror fetch timed out after ${requestTimeoutMs}ms` : message
        throw new Error(`${detail} (${url})`)
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    const waitForMirror = async (identifier: string, expectedCore?: string | null, timeoutMs = 120_000) => {
      const normalizedExpected = normalizeRelayKey(expectedCore)
      const configuredBase =
        gatewayRef.current?.baseUrl ||
        (typeof import.meta !== 'undefined'
          ? ((import.meta.env.VITE_CLOSED_JOIN_E2E_GATEWAY_BASE as string | undefined) || '')
          : '')
      const base = configuredBase.trim() || null
      const startedAt = Date.now()
      let attempt = 0
      console.info('[ClosedJoinE2E] Waiting for mirror metadata', {
        identifier,
        expectedCore: normalizedExpected || null,
        base,
        timeoutMs
      })
      if (!base) {
        throw new Error('No mirror gateway base configured')
      }
      return waitFor(
        'mirror-metadata',
        async () => {
          attempt += 1
          try {
            const data = await fetchMirrorMetadata(identifier, Math.min(15_000, timeoutMs))
            if (!data) return null
            const cores = Array.isArray(data.cores) ? data.cores : []
            if (!cores.length) {
              if (attempt === 1 || attempt % 10 === 0) {
                console.info('[ClosedJoinE2E] Mirror metadata missing cores', { identifier, attempt })
              }
              return null
            }
            if (normalizedExpected) {
              const hasCore = cores.some((entry: any) => {
                const key = normalizeRelayKey(entry?.key || entry?.writerCore || entry?.writerCoreHex)
                return key === normalizedExpected
              })
              if (!hasCore) {
                if (attempt === 1 || attempt % 10 === 0) {
                  console.info('[ClosedJoinE2E] Mirror metadata missing expected core', {
                    identifier,
                    attempt,
                    expectedCore: normalizedExpected
                  })
                }
                return null
              }
            }
            console.info('[ClosedJoinE2E] Mirror metadata ready', {
              identifier,
              attempt,
              coreCount: cores.length,
              ms: Date.now() - startedAt
            })
            return data
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (attempt === 1 || attempt % 5 === 0) {
              console.warn('[ClosedJoinE2E] Mirror metadata fetch failed', {
                identifier,
                attempt,
                error: message
              })
            }
            throw err
          }
        },
        { timeoutMs, intervalMs: 2_000 }
      )
    }

    const publishGroupNote = async (
      groupId: string,
      relayUrl: string,
      content: string,
      expectedPubkey: string
    ) => {
      await assertAuthContext({
        label: 'publish-group-note',
        expectedPubkey,
        relayUrl
      })
      const draftEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content
      }
      return publish(draftEvent, { specifiedRelayUrls: [relayUrl] })
    }

    const fetchGroupNotes = async (relayUrl: string, groupId: string) => {
      const filter: Filter = {
        kinds: [1],
        '#h': [groupId],
        limit: 50
      }
      return client.fetchEvents([relayUrl], filter)
    }

    const waitForInvite = async (groupId: string): Promise<TGroupInvite> => {
      return waitFor(
        'invite',
        async () => {
          const refreshFn = refreshInvitesRef.current || refreshInvites
          await refreshFn()
          const list = invitesRef.current || []
          return list.find((invite) => invite.groupId === groupId) || null
        },
        { timeoutMs: 120_000, intervalMs: 5_000 }
      ) as Promise<TGroupInvite>
    }

    const waitForJoinSuccess = async (groupId: string, timeoutMs = 180_000) => {
      return waitFor(
        'join-flow-success',
        () => {
          const state = joinFlowsRef.current?.[groupId]
          if (!state) return null
          if (state.phase === 'error') {
            throw new Error(state.error || 'join failed')
          }
          return state.phase === 'success' ? state : null
        },
        { timeoutMs, intervalMs: 1_000 }
      )
    }

    const waitForWritable = async (groupId: string, timeoutMs = 180_000) => {
      return waitFor(
        'relay-writable',
        () => {
          const state = joinFlowsRef.current?.[groupId]
          if (!state) return null
          if (state.writable) return state
          return null
        },
        { timeoutMs, intervalMs: 1_000 }
      )
    }

    const runClosedJoinE2E = async (options: E2EOptions = {}) => {
      let restoreAutostart: boolean | null = null
      try {
        const inviteeCount = Number.isFinite(options.inviteeCount)
          ? Math.max(1, Math.trunc(options.inviteeCount as number))
          : 5
        const groupPrefix = options.groupPrefix || 'ClosedJoinE2E'
        const isPublic = options.isPublic === true
        const singleGroup = options.singleGroup !== false
        const mirrorTimeoutMs = options.mirrorTimeoutMs ?? 180_000
        const joinTimeoutMs = options.joinTimeoutMs ?? 240_000
        const resetAccounts = options.resetAccounts !== false
        const disableAutostart = options.disableAutostart !== false
        const e2ePassword =
          import.meta.env.VITE_E2E_NCRYPT_PASSWORD
            ? String(import.meta.env.VITE_E2E_NCRYPT_PASSWORD)
            : null
        if (!e2ePassword) {
          throw new Error('VITE_E2E_NCRYPT_PASSWORD is required for E2E encrypted logins')
        }

        if (disableAutostart && typeof setAutostartEnabled === 'function') {
          restoreAutostart = autostartEnabledRef.current
          if (restoreAutostart) {
            console.info('[ClosedJoinE2E] Disabling worker autostart for deterministic E2E')
            setAutostartEnabled(false)
          }
        }

        if (resetAccounts) {
          await resetE2EAccounts()
        }

        const seeds = generateAccounts(inviteeCount + 1, e2ePassword)
        const host = seeds[0]
        const invitees = seeds.slice(1)
        const runs: any[] = []

        let sharedGroupId: string | null = null
        let sharedGroupName: string | null = null
        let sharedRelayKey: string | null = null
        let sharedRelayUrl: string | null = null
        let sharedRelayListUrl: string | null = null

        if (singleGroup) {
          console.info('[ClosedJoinE2E] Creating shared group for all invitees')
          await loginWithSeedAndGroups(host, e2ePassword)
          await assertAuthContext({
            label: 'create-group',
            expectedPubkey: host.pubkey
          })
          const groupName = `${groupPrefix}-${Date.now()}`
          const createGroupFn = createGroupRef.current || createHyperpipeRelayGroup
          const groupResult = await createGroupFn({
            name: groupName,
            about: 'Closed join automation',
            isPublic,
            isOpen: false,
            fileSharing: true
          })
          sharedGroupId = groupResult.groupId
          sharedGroupName = groupName
          sharedRelayListUrl = groupResult.relay

          const relayEntry = await waitForRelayEntry(groupResult.groupId)
          sharedRelayKey = relayEntry?.relayKey || null
          const sharedBaseUrl = relayEntry?.connectionUrl || groupResult.relay
          const resolveFn = resolveRelayUrlRef.current || resolveRelayUrl
          sharedRelayUrl = resolveFn(sharedBaseUrl) || sharedBaseUrl
          if (!sharedRelayUrl) {
            throw new Error('No relay URL available after create')
          }
          await waitForMirror(sharedRelayKey || sharedGroupId, null, mirrorTimeoutMs)
        }

        for (let i = 0; i < invitees.length; i += 1) {
          const invitee = invitees[i]
          const runId = `${i + 1}/${invitees.length}`
          console.info(`[ClosedJoinE2E] Run ${runId} starting`)

          let groupId = sharedGroupId
          let relayKey = sharedRelayKey
          let relayUrl = sharedRelayUrl
          let relayListUrl = sharedRelayListUrl

          let groupName: string | null = sharedGroupName

          if (!singleGroup) {
            await loginWithSeedAndGroups(host, e2ePassword)
            await assertAuthContext({
              label: 'create-group',
              expectedPubkey: host.pubkey
            })

            groupName = `${groupPrefix}-${i + 1}-${Date.now()}`
            const createGroupFn = createGroupRef.current || createHyperpipeRelayGroup
            const groupResult = await createGroupFn({
              name: groupName,
              about: 'Closed join automation',
              isPublic,
              isOpen: false,
              fileSharing: true
            })
            groupId = groupResult.groupId
            relayListUrl = groupResult.relay
            const relayEntry = await waitForRelayEntry(groupId)
            relayKey = relayEntry?.relayKey || null
            const baseUrl = relayEntry?.connectionUrl || groupResult.relay
            const resolveFn = resolveRelayUrlRef.current || resolveRelayUrl
            relayUrl = resolveFn(baseUrl) || baseUrl
            if (!relayUrl) {
              throw new Error('No relay URL available after create')
            }
            await waitForMirror(relayKey || groupId, null, mirrorTimeoutMs)
          }

          if (!groupId || !relayUrl) {
            throw new Error('Missing group info for run')
          }

          await loginWithSeedAndGroups(host, e2ePassword)

          await assertAuthContext({
            label: 'send-invite',
            expectedPubkey: host.pubkey,
            relayUrl: relayListUrl || relayUrl
          })
          const sendInvitesFn = sendInvitesRef.current || sendInvites
          await sendInvitesFn(groupId, [invitee.pubkey], relayListUrl || relayUrl, {
            isOpen: false,
            name: groupName || groupId,
            about: 'Closed join automation'
          })

          const hostNoteContent = `[${groupName || groupId}] host note ${Date.now()}`
          const hostNote = await publishGroupNote(groupId, relayUrl, hostNoteContent, host.pubkey)
          await waitForMirror(relayKey || groupId, null, mirrorTimeoutMs)

          if (stopWorker) {
            console.info('[ClosedJoinE2E] Stopping worker after host phase')
            await stopWorker().catch(() => {})
          }

          await loginWithSeedAndGroups(invitee, e2ePassword)

          const invite = await waitForInvite(groupId)
          const inviteRelayKey = invite.relayKey || relayKey
          const inviteRelayUrl = invite.relayUrl || relayListUrl || relayUrl

          await assertAuthContext({
            label: 'start-join-flow',
            expectedPubkey: invitee.pubkey,
            relayUrl: inviteRelayUrl || null,
            authToken: invite.token || null
          })
          await startJoinFlow(groupId, {
            fileSharing: invite.fileSharing !== false,
            isOpen: false,
            openJoin: false,
            token: invite.token,
            relayKey: inviteRelayKey || null,
            relayUrl: inviteRelayUrl || null,
            gatewayAccess: invite.gatewayAccess || undefined,
            blindPeer: invite.blindPeer,
            cores: invite.cores,
            writerCore: invite.writerCore,
            writerCoreHex: invite.writerCoreHex,
            autobaseLocal: invite.autobaseLocal,
            writerSecret: invite.writerSecret
          })

          const joined = await waitForJoinSuccess(groupId, joinTimeoutMs)
          const writable = await waitForWritable(groupId, joinTimeoutMs)
          const joinRelayUrl = writable?.relayUrl || joined?.relayUrl || inviteRelayUrl || relayUrl
          if (!joinRelayUrl) {
            throw new Error('Join flow did not provide relayUrl')
          }

          const notesAfterJoin = await fetchGroupNotes(joinRelayUrl, groupId)
          const hostNoteSeen = notesAfterJoin.some((evt) => evt.id === hostNote.id)
          if (!hostNoteSeen) {
            throw new Error('Host note not visible after join')
          }

          const inviteeNoteContent = `[${groupName || groupId}] invitee note ${Date.now()}`
          const inviteeNote = await publishGroupNote(
            groupId,
            joinRelayUrl,
            inviteeNoteContent,
            invitee.pubkey
          )

          const expectedCore =
            invite.writerCoreHex || invite.autobaseLocal || invite.writerCore || null
          await waitForMirror(relayKey || groupId, expectedCore, mirrorTimeoutMs)

          runs.push({
            groupId,
            relayKey: relayKey || null,
            relayUrl,
            invitee: { pubkey: invitee.pubkey, npub: invitee.npub },
            hostNoteId: hostNote.id,
            inviteeNoteId: inviteeNote.id
          })

          console.info(`[ClosedJoinE2E] Run ${runId} complete`, {
            groupId,
            relayKey: relayKey ? relayKey.slice(0, 16) : null
          })
        }

        return {
          ok: true,
          host: { pubkey: host.pubkey, npub: host.npub, nsec: host.nsec },
          invitees: invitees.map((seed) => ({ pubkey: seed.pubkey, npub: seed.npub, nsec: seed.nsec })),
          sharedGroup: singleGroup
            ? {
                groupId: sharedGroupId,
                relayKey: sharedRelayKey,
                relayUrl: sharedRelayUrl
              }
            : null,
          runs
        }
      } catch (error) {
        const aggDetails = formatAggregateError(error)
        const message =
          error instanceof Error
            ? error.message || error.name
            : String(error || 'E2E run failed')
        if (aggDetails) {
          console.error('[ClosedJoinE2E] AggregateError details:', aggDetails)
          throw new Error(`${message}: ${aggDetails}`)
        }
        console.error('[ClosedJoinE2E] run failed', error)
        throw error
      } finally {
        if (restoreAutostart !== null && typeof setAutostartEnabled === 'function') {
          setAutostartEnabled(restoreAutostart)
        }
      }
    }

    ;(window as any).__HYT_E2E__ = {
      generateAccounts,
      loginWithSeed,
      loginWithNsec: async (nsec: string) =>
        loginWithSeed({ pubkey: '', npub: '', nsec }, null),
      publishGroupNote,
      fetchGroupNotes,
      runClosedJoinE2E
    }

    console.info('[ClosedJoinE2E] registered on window.__HYT_E2E__')
  }, [
    createHyperpipeRelayGroup,
    ncryptsecLogin,
    nsecLogin,
    publish,
    accounts,
    removeAccount,
    switchAccount,
    refreshInvites,
    resolveRelayUrl,
    sendInvites,
    startJoinFlow,
    startWorker,
    stopWorker,
    restartWorker,
    autostartEnabled,
    setAutostartEnabled
  ])

  return null
}
