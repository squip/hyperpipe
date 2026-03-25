import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../../src/ui/App.js'
import { TuiController, type RuntimeOptions } from '../../src/domain/controller.js'
import type { LogLevel } from '../../src/domain/types.js'
import { resolveDesktopParityStorageDir } from '../../src/storage/defaultStorageDir.js'

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP'
type RowStatus = 'PASS' | 'FAIL' | 'SKIP'

type Check = {
  name: string
  status: CheckStatus
  evidence: string
}

type Row = {
  scenario: string
  status: RowStatus
  checks: Check[]
}

type Report = {
  generatedAt: string
  storageDir: string
  user1: string
  user2: string
  rows: Row[]
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function progress(step: string): void {
  process.stdout.write(`[progress] ${new Date().toISOString()} ${step}\n`)
}

async function withStepTimeout<T>(
  label: string,
  task: Promise<T>,
  timeoutMs = 90_000
): Promise<T> {
  const timeout = Math.max(5_000, Math.trunc(timeoutMs))
  let timeoutId: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeout}ms`))
        }, timeout)
      })
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function isHex64(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function hasTokenizedRelayUrl(url: string | null | undefined): boolean {
  const text = String(url || '').trim()
  return /^wss?:\/\//i.test(text) && /[?&]token=/.test(text)
}

function shortId(value: string | null | undefined, length = 12): string {
  const text = String(value || '').trim()
  if (!text) return '-'
  if (text.length <= length) return text
  return `${text.slice(0, length)}…`
}

async function waitFor<T>(
  description: string,
  action: () => Promise<T | null>,
  options: {
    timeoutMs?: number
    intervalMs?: number
    actionTimeoutMs?: number
  } = {}
): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.trunc(options.timeoutMs || 60_000))
  const intervalMs = Math.max(200, Math.trunc(options.intervalMs || 1_200))
  const actionTimeoutMs = Math.max(5_000, Math.trunc(options.actionTimeoutMs || 30_000))
  const startedAt = Date.now()
  let lastError: string | null = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await withStepTimeout(`${description} action`, action(), actionTimeoutMs)
      if (value !== null) {
        return value
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }

  throw new Error(`${description} timed out${lastError ? ` (${lastError})` : ''}`)
}

function summarize(checks: Check[]): RowStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL'
  if (checks.some((check) => check.status === 'PASS')) return 'PASS'
  return 'SKIP'
}

function printTable(rows: Row[]): void {
  const lines: string[] = []
  lines.push('| Scenario | Status | Evidence |')
  lines.push('|---|---|---|')
  for (const row of rows) {
    const evidence = row.checks.map((check) => `${check.status} ${check.name}: ${check.evidence}`).join(' ; ')
    lines.push(`| ${row.scenario} | ${row.status} | ${evidence} |`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function typeText(stdin: { write: (chunk: string) => void }, value: string, delayMs = 5): Promise<void> {
  for (const char of value) {
    stdin.write(char)
    await sleep(delayMs)
  }
}

async function runPaneStabilityCheck(runtime: RuntimeOptions): Promise<Check> {
  const paneStorageDir = path.join(
    os.tmpdir(),
    'hyperpipe-tui-pane-check',
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
  await fs.mkdir(paneStorageDir, { recursive: true })
  const instance = render(<App options={{ ...runtime, storageDir: paneStorageDir, noAnimations: true }} />)

  const stripAnsi = (input: string): string => input.replace(/\u001B\[[0-9;]*m/g, '')
  const frame = (): string => stripAnsi(instance.lastFrame() || '')

  try {
    await waitFor('App boot', async () => frame().includes('Command') ? true : null, { timeoutMs: 30_000, intervalMs: 100 })
    instance.stdin.write(':')
    await sleep(80)
    await typeText(instance.stdin, 'goto relay:my', 2)
    instance.stdin.write('\r')
    await waitFor('goto relay:my', async () => frame().includes('relays:my') ? true : null, { timeoutMs: 15_000, intervalMs: 120 })

    instance.stdin.write('\t')
    instance.stdin.write('\t')
    await sleep(120)

    for (let i = 0; i < 14; i += 1) {
      instance.stdin.write('\u001b[B')
      await sleep(30)
    }
    for (let i = 0; i < 14; i += 1) {
      instance.stdin.write('\u001b[A')
      await sleep(30)
    }
    await sleep(220)

    // Validate responsiveness by executing a command navigation after stress keys.
    instance.stdin.write(':')
    await sleep(80)
    await typeText(instance.stdin, 'goto relays', 2)
    instance.stdin.write('\r')
    await waitFor('goto relays after stress navigation', async () => frame().includes('relays:my') ? true : null, {
      timeoutMs: 15_000,
      intervalMs: 120
    })

    instance.stdin.write('q')
    await sleep(350)
    instance.unmount()
    await fs.rm(paneStorageDir, { recursive: true, force: true }).catch(() => {})
    return {
      name: 'top-right pane navigation remains stable',
      status: 'PASS',
      evidence: 'App handled repeated right-top up/down keys and command navigation remained responsive'
    }
  } catch (error) {
    try { instance.unmount() } catch {}
    await fs.rm(paneStorageDir, { recursive: true, force: true }).catch(() => {})
    return {
      name: 'top-right pane navigation remains stable',
      status: 'FAIL',
      evidence: error instanceof Error ? error.message : String(error)
    }
  }
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    'storage-dir': { type: 'string' },
    'log-level': { type: 'string' },
    'json-out': { type: 'string' }
  }
})

const cwd = process.cwd()
const storageDir = parsed.values['storage-dir']
  ? path.resolve(cwd, parsed.values['storage-dir'])
  : resolveDesktopParityStorageDir(cwd)

const runtime: RuntimeOptions = {
  cwd,
  storageDir,
  noAnimations: true,
  logLevel: parseLogLevel(parsed.values['log-level'])
}

const controller = new TuiController(runtime)
const rows: Row[] = []
let user1Pubkey = ''
let user2Pubkey = ''
const globalWatchdog = setTimeout(() => {
  process.stderr.write('live two-user workflow test failed: global watchdog timeout (45m)\n')
  process.exit(1)
}, 45 * 60 * 1000)

async function ensureTwoUsers(): Promise<{ user1: string; user2: string }> {
  const allowReuse = process.env.HYPERPIPE_LIVE_MATRIX_REUSE_USERS === '1'
  const existing = await controller.listAccountProfiles()
  const nsecProfiles = existing.filter((entry) => entry.signerType === 'nsec')
  if (allowReuse && nsecProfiles.length >= 2) {
    return {
      user1: nsecProfiles[0]!.pubkey,
      user2: nsecProfiles[1]!.pubkey
    }
  }

  const generated1 = await controller.generateNsecAccount(`live-u1-${Date.now().toString(36)}`)
  const generated2 = await controller.generateNsecAccount(`live-u2-${Date.now().toString(36)}`)
  return {
    user1: generated1.pubkey,
    user2: generated2.pubkey
  }
}

async function switchUser(pubkey: string): Promise<void> {
  progress(`switch user -> ${shortId(pubkey, 16)}`)
  progress('switch user: selectAccount')
  await withStepTimeout('selectAccount', controller.selectAccount(pubkey), 20_000)
  progress('switch user: unlockCurrentAccount')
  await withStepTimeout('unlockCurrentAccount', controller.unlockCurrentAccount(), 20_000)
  if (controller.getState().lifecycle !== 'ready') {
    progress('switch user: startWorker')
    await withStepTimeout('startWorker', controller.startWorker(), 60_000)
  }
  progress('switch user: refresh relays/groups/invites/chats')
  await Promise.allSettled([
    withStepTimeout('refreshRelays', controller.refreshRelays(), 45_000),
    withStepTimeout('refreshGroups', controller.refreshGroups(), 45_000),
    withStepTimeout('refreshInvites', controller.refreshInvites(), 45_000),
    withStepTimeout('refreshChats', controller.refreshChats(), 45_000)
  ])
  progress('switch user: refresh complete')
}

try {
  progress('initialize controller')
  await withStepTimeout('controller.initialize', controller.initialize(), 90_000)
  const { user1, user2 } = await ensureTwoUsers()
  user1Pubkey = user1
  user2Pubkey = user2

  {
    progress('scenario: public/open create + join + pane stability')
    const checks: Check[] = []
    await switchUser(user1)
    const name = `pub-open-${Date.now().toString(36)}`
    let groupId: string | null = null
    let relayUrl: string | null = null

    try {
      progress('public/open: create relay')
      await withStepTimeout('createRelay public/open', controller.createRelay({
        name,
        description: 'public open group e2e',
        isPublic: true,
        isOpen: true,
        fileSharing: true
      }), 90_000)
      progress('public/open: wait for creator group visibility')
      const group = await waitFor('public/open group appears for creator', async () => {
        await controller.refreshGroups()
        const snapshot = controller.getState()
        return snapshot.myGroups.find((entry) => entry.name === name) || null
      })
      groupId = group.id
      relayUrl = group.relay || null
      checks.push({
        name: 'create public/open group',
        status: 'PASS',
        evidence: `group=${group.id}`
      })
    } catch (error) {
      checks.push({
        name: 'create public/open group',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }

    if (groupId) {
      try {
        progress('public/open: verify creator relay tokenized URL')
        const relayEntry = await waitFor('creator relay tokenized URL', async () => {
          await controller.refreshRelays()
          const snapshot = controller.getState()
          return snapshot.relays.find((entry) => entry.publicIdentifier === groupId) || null
        })
        checks.push({
          name: 'creator relay metadata has tokenized URL',
          status: hasTokenizedRelayUrl(relayEntry.connectionUrl) ? 'PASS' : 'FAIL',
          evidence: relayEntry.connectionUrl || 'missing connectionUrl'
        })
      } catch (error) {
        checks.push({
          name: 'creator relay metadata has tokenized URL',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        progress('public/open: switch to user2 and discover')
        await switchUser(user2)
        const discovered = await waitFor('user2 discovers public/open group', async () => {
          await controller.refreshGroups()
          return controller.getState().groupDiscover.find((entry) => entry.id === groupId) || null
        }, { timeoutMs: 90_000 })
        checks.push({
          name: 'user2 sees group in Browse Groups',
          status: 'PASS',
          evidence: `group=${discovered.id}`
        })

        progress('public/open: user2 join flow')
        await withStepTimeout('startJoinFlow public/open', controller.startJoinFlow({
          publicIdentifier: groupId,
          relayUrl: discovered.relay || relayUrl || undefined,
          isOpen: true,
          openJoin: true
        }), 120_000)
        const joinedRelay = await waitFor('user2 relay join completes', async () => {
          await controller.refreshRelays()
          return controller.getState().relays.find((entry) => entry.publicIdentifier === groupId) || null
        }, { timeoutMs: 120_000, intervalMs: 1_800 })
        checks.push({
          name: 'user2 joined public/open group relay',
          status: hasTokenizedRelayUrl(joinedRelay.connectionUrl) ? 'PASS' : 'FAIL',
          evidence: joinedRelay.connectionUrl || 'missing connectionUrl'
        })
        try {
          const joinedGroup = await waitFor('user2 My Groups includes joined public/open group', async () => {
            await controller.refreshGroups()
            return controller.getState().myGroups.find((entry) => entry.id === groupId) || null
          }, { timeoutMs: 60_000, intervalMs: 1_500 })
          checks.push({
            name: 'user2 My Groups hydrated after public/open join',
            status: 'PASS',
            evidence: joinedGroup.id
          })
        } catch (error) {
          checks.push({
            name: 'user2 My Groups hydrated after public/open join',
            status: 'FAIL',
            evidence: error instanceof Error ? error.message : String(error)
          })
        }
      } catch (error) {
        checks.push({
          name: 'user2 joined public/open group relay',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }
    }

    progress('public/open: run pane stability check')
    await withStepTimeout('stopWorker before pane stability', controller.stopWorker().catch(() => {}), 20_000)
    const paneCheck = await withStepTimeout(
      'runPaneStabilityCheck',
      runPaneStabilityCheck(runtime),
      45_000
    )
    progress(`public/open: pane stability result ${paneCheck.status}`)
    checks.push(paneCheck)

    rows.push({
      scenario: 'Public/Open Group (create + join + pane stability)',
      status: summarize(checks),
      checks
    })
  }

  {
    progress('scenario: public/closed request invite flow')
    const checks: Check[] = []
    await switchUser(user1)
    const name = `pub-closed-request-${Date.now().toString(36)}`
    let groupId: string | null = null
    let relayUrl: string | null = null

    try {
      await withStepTimeout('createRelay public/closed request', controller.createRelay({
        name,
        description: 'public closed request flow',
        isPublic: true,
        isOpen: false,
        fileSharing: true
      }), 90_000)
      const created = await waitFor('public/closed group created', async () => {
        await controller.refreshGroups()
        return controller.getState().myGroups.find((entry) => entry.name === name) || null
      })
      groupId = created.id
      relayUrl = created.relay || null
      checks.push({
        name: 'create public/closed group',
        status: 'PASS',
        evidence: `group=${created.id}`
      })
    } catch (error) {
      checks.push({
        name: 'create public/closed group',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }

    if (groupId) {
      try {
        await switchUser(user2)
        const discovered = await waitFor('user2 discovers public/closed group', async () => {
          await controller.refreshGroups()
          return controller.getState().groupDiscover.find((entry) => entry.id === groupId) || null
        }, { timeoutMs: 90_000 })
        await withStepTimeout('requestGroupInvite', controller.requestGroupInvite({
          groupId: discovered.id,
          relay: discovered.relay || relayUrl || null
        }), 90_000)
        checks.push({
          name: 'user2 submits request-invite',
          status: 'PASS',
          evidence: `group=${discovered.id}`
        })
      } catch (error) {
        checks.push({
          name: 'user2 submits request-invite',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await switchUser(user1)
        const request = await waitFor('admin sees join request', async () => {
          await controller.refreshJoinRequests(groupId!, relayUrl || undefined)
          const snapshot = controller.getState()
          const keyPrimary = relayUrl ? `${relayUrl}|${groupId}` : groupId
          const entries = snapshot.groupJoinRequests[keyPrimary] || snapshot.groupJoinRequests[groupId!] || []
          return entries.find((entry) => entry.pubkey === user2) || null
        }, { timeoutMs: 90_000, intervalMs: 1_600 })
        await withStepTimeout(
          'approveJoinRequest',
          controller.approveJoinRequest(groupId, request.pubkey, relayUrl || undefined),
          90_000
        )
        checks.push({
          name: 'admin approves join request',
          status: 'PASS',
          evidence: `requestPubkey=${shortId(request.pubkey)}`
        })
      } catch (error) {
        checks.push({
          name: 'admin approves join request',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await switchUser(user2)
        const invite = await waitFor('requesting user receives group invite', async () => {
          await controller.refreshInvites()
          return controller.getState().groupInvites.find((entry) => entry.groupId === groupId) || null
        }, { timeoutMs: 120_000, intervalMs: 2_000 })
        await withStepTimeout('acceptGroupInvite request flow', controller.acceptGroupInvite(invite.id), 120_000)
        const joinedRelay = await waitFor('requesting user relay join after invite accept', async () => {
          await controller.refreshRelays()
          return controller.getState().relays.find((entry) => entry.publicIdentifier === groupId) || null
        }, { timeoutMs: 120_000, intervalMs: 2_000 })
        checks.push({
          name: 'request-invite accept joins relay with tokenized URL',
          status: hasTokenizedRelayUrl(joinedRelay.connectionUrl) ? 'PASS' : 'FAIL',
          evidence: joinedRelay.connectionUrl || 'missing connectionUrl'
        })
        try {
          const joinedGroup = await waitFor('requesting user My Groups includes accepted invite group', async () => {
            await controller.refreshGroups()
            return controller.getState().myGroups.find((entry) => entry.id === groupId) || null
          }, { timeoutMs: 60_000, intervalMs: 1_500 })
          checks.push({
            name: 'request-invite user My Groups hydrated after accept',
            status: 'PASS',
            evidence: joinedGroup.id
          })
        } catch (error) {
          checks.push({
            name: 'request-invite user My Groups hydrated after accept',
            status: 'FAIL',
            evidence: error instanceof Error ? error.message : String(error)
          })
        }
      } catch (error) {
        checks.push({
          name: 'request-invite accept joins relay with tokenized URL',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }
    }

    rows.push({
      scenario: 'Public/Closed Group (request invite flow)',
      status: summarize(checks),
      checks
    })
  }

  {
    progress('scenario: public/closed admin direct invite flow')
    const checks: Check[] = []
    await switchUser(user1)
    const name = `pub-closed-admin-${Date.now().toString(36)}`
    let groupId: string | null = null
    let relayUrl: string | null = null

    try {
      await withStepTimeout('createRelay public/closed direct', controller.createRelay({
        name,
        description: 'public closed direct invite',
        isPublic: true,
        isOpen: false,
        fileSharing: true
      }), 90_000)
      const created = await waitFor('public/closed direct-invite group created', async () => {
        await controller.refreshGroups()
        return controller.getState().myGroups.find((entry) => entry.name === name) || null
      })
      groupId = created.id
      relayUrl = created.relay || null
      await withStepTimeout('sendInvite direct group', controller.sendInvite({
        groupId: created.id,
        relayUrl: relayUrl || '',
        inviteePubkey: user2,
        payload: {
          groupName: created.name || created.id,
          isPublic: true,
          fileSharing: true
        }
      }), 90_000)
      checks.push({
        name: 'admin sends direct group invite',
        status: 'PASS',
        evidence: `group=${created.id} invitee=${shortId(user2)}`
      })
    } catch (error) {
      checks.push({
        name: 'admin sends direct group invite',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }

    if (groupId) {
      try {
        await switchUser(user2)
        const invite = await waitFor('user2 receives direct group invite', async () => {
          await controller.refreshInvites()
          return controller.getState().groupInvites.find((entry) => entry.groupId === groupId) || null
        }, { timeoutMs: 120_000, intervalMs: 2_000 })
        await withStepTimeout('acceptGroupInvite direct flow', controller.acceptGroupInvite(invite.id), 120_000)
        const joinedRelay = await waitFor('user2 joins relay after direct invite accept', async () => {
          await controller.refreshRelays()
          return controller.getState().relays.find((entry) => entry.publicIdentifier === groupId) || null
        }, { timeoutMs: 120_000, intervalMs: 2_000 })
        checks.push({
          name: 'direct invite accept joins relay with tokenized URL',
          status: hasTokenizedRelayUrl(joinedRelay.connectionUrl) ? 'PASS' : 'FAIL',
          evidence: joinedRelay.connectionUrl || 'missing connectionUrl'
        })
        try {
          const joinedGroup = await waitFor('user2 My Groups includes direct-invite group', async () => {
            await controller.refreshGroups()
            return controller.getState().myGroups.find((entry) => entry.id === groupId) || null
          }, { timeoutMs: 60_000, intervalMs: 1_500 })
          checks.push({
            name: 'direct-invite user My Groups hydrated after accept',
            status: 'PASS',
            evidence: joinedGroup.id
          })
        } catch (error) {
          checks.push({
            name: 'direct-invite user My Groups hydrated after accept',
            status: 'FAIL',
            evidence: error instanceof Error ? error.message : String(error)
          })
        }
      } catch (error) {
        checks.push({
          name: 'direct invite accept joins relay with tokenized URL',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }
    }

    rows.push({
      scenario: 'Public/Closed Group (admin direct invite flow)',
      status: summarize(checks),
      checks
    })
  }

  {
    progress('scenario: chat create + invite + accept + message')
    const checks: Check[] = []
    const chatTitle = `chat-two-user-${Date.now().toString(36)}`
    let conversationId: string | null = null

    try {
      await switchUser(user2)
      await withStepTimeout('initChats user2', controller.initChats(), 90_000)
      await withStepTimeout('refreshChats user2', controller.refreshChats(), 45_000)
      checks.push({
        name: 'user2 chat bootstrap',
        status: 'PASS',
        evidence: 'initChats completed'
      })
    } catch (error) {
      checks.push({
        name: 'user2 chat bootstrap',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      await switchUser(user1)
      await withStepTimeout('initChats user1', controller.initChats(), 90_000)
      await withStepTimeout('refreshChats user1', controller.refreshChats(), 45_000)
      await withStepTimeout('createConversation', controller.createConversation({
        title: chatTitle,
        members: [],
        relayMode: 'withFallback'
      }), 120_000)
      const conversation = await waitFor('chat appears for creator', async () => {
        await controller.refreshChats()
        return controller.getState().conversations.find((entry) => entry.title === chatTitle) || null
      })
      conversationId = conversation.id
      const inviteResult = await withStepTimeout(
        'inviteChatMembers',
        controller.inviteChatMembers(conversation.id, [user2]),
        120_000
      )
      if (inviteResult.failed.length > 0) {
        throw new Error(inviteResult.failed.map((entry) => `${shortId(entry.pubkey)}:${entry.error}`).join(', '))
      }
      checks.push({
        name: 'user1 creates chat and invites user2',
        status: 'PASS',
        evidence: `conversation=${conversation.id}`
      })
    } catch (error) {
      checks.push({
        name: 'user1 creates chat and invites user2',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }

    if (conversationId) {
      const user2Message = `u2->u1 ${Date.now().toString(36)}`
      const user1Message = `u1->u2 ${Date.now().toString(36)}`

      try {
        await switchUser(user2)
        const invite = await waitFor('user2 receives chat invite', async () => {
          await controller.refreshChats()
          return controller.getState().chatInvites.find((entry) => entry.conversationId === conversationId || entry.title === chatTitle) || null
        }, { timeoutMs: 120_000, intervalMs: 2_000 })
        await withStepTimeout('acceptChatInvite', controller.acceptChatInvite(invite.id), 120_000)
        await withStepTimeout('loadChatThread user2', controller.loadChatThread(conversationId), 60_000)
        await withStepTimeout('sendChatMessage user2', controller.sendChatMessage(conversationId, user2Message), 60_000)
        checks.push({
          name: 'user2 accepts invite and sends message',
          status: 'PASS',
          evidence: `invite=${invite.id}`
        })
      } catch (error) {
        checks.push({
          name: 'user2 accepts invite and sends message',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await switchUser(user1)
        await waitFor('user1 receives user2 message', async () => {
          await withStepTimeout('loadChatThread user1 wait-for-message', controller.loadChatThread(conversationId!), 60_000)
          const thread = controller.getState().threadMessages
          return thread.some((message) => message.content === user2Message) ? true : null
        }, { timeoutMs: 60_000, intervalMs: 1_500 })
        await withStepTimeout('sendChatMessage user1', controller.sendChatMessage(conversationId, user1Message), 60_000)
        checks.push({
          name: 'user1 receives and replies',
          status: 'PASS',
          evidence: `conversation=${conversationId}`
        })
      } catch (error) {
        checks.push({
          name: 'user1 receives and replies',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await switchUser(user2)
        await waitFor('user2 receives user1 reply', async () => {
          await withStepTimeout('loadChatThread user2 wait-for-reply', controller.loadChatThread(conversationId!), 60_000)
          const thread = controller.getState().threadMessages
          return thread.some((message) => message.content === user1Message) ? true : null
        }, { timeoutMs: 60_000, intervalMs: 1_500 })
        checks.push({
          name: 'user2 receives user1 message',
          status: 'PASS',
          evidence: `conversation=${conversationId}`
        })
      } catch (error) {
        checks.push({
          name: 'user2 receives user1 message',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }
    }

    rows.push({
      scenario: 'Chats (create + invite + accept + bi-directional messages)',
      status: summarize(checks),
      checks
    })
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    storageDir,
    user1: user1Pubkey || '-',
    user2: user2Pubkey || '-',
    rows
  }

  printTable(rows)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  const outPath = parsed.values['json-out']
  if (outPath) {
    const target = path.resolve(cwd, outPath)
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(target, JSON.stringify(report, null, 2))
    process.stdout.write(`Wrote report: ${target}\n`)
  }

  if (rows.some((row) => row.status === 'FAIL')) {
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`live two-user workflow test failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  clearTimeout(globalWatchdog)
  await Promise.race([
    controller.shutdown().catch(() => {}),
    sleep(4_000)
  ])
  process.exit(process.exitCode || 0)
}
