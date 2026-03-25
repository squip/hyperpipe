import path from 'node:path'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import { TuiController, type RuntimeOptions } from '../../src/domain/controller.js'
import type { LogLevel } from '../../src/domain/types.js'
import { resolveDesktopParityStorageDir } from '../../src/storage/defaultStorageDir.js'

type CheckStatus = 'PASS' | 'FAIL' | 'SKIP'
type RowStatus = 'PASS' | 'FAIL' | 'SKIP'

type CheckResult = {
  name: string
  status: CheckStatus
  evidence: string
}

type MatrixRow = {
  workflow: string
  status: RowStatus
  checks: CheckResult[]
}

type MatrixReport = {
  generatedAt: string
  storageDir: string
  profile: string | null
  rows: MatrixRow[]
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

function isHex64(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function shortId(value: string | null | undefined, length = 12): string {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

function summarizeChecks(checks: CheckResult[]): RowStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL'
  if (checks.some((check) => check.status === 'PASS')) return 'PASS'
  return 'SKIP'
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function bootstrapAccount(controller: TuiController, args: {
  nsec?: string
  ncryptsec?: string
  password?: string
}): Promise<void> {
  const snapshot = controller.getState()
  if (!snapshot.currentAccountPubkey) {
    if (args.nsec) {
      await controller.addNsecAccount(args.nsec, `matrix-${Date.now().toString(36)}`)
    } else if (args.ncryptsec && args.password) {
      await controller.addNcryptsecAccount(args.ncryptsec, args.password, `matrix-${Date.now().toString(36)}`)
    } else {
      await controller.generateNsecAccount(`matrix-${Date.now().toString(36)}`)
    }
  }

  if (!controller.getState().session) {
    await controller.unlockCurrentAccount(async () => args.password || '')
  }
}

function printHumanTable(rows: MatrixRow[]): void {
  const lines: string[] = []
  lines.push('| Workflow | Status | Evidence |')
  lines.push('|---|---|---|')
  for (const row of rows) {
    const evidence = row.checks
      .map((check) => `${check.status} ${check.name}: ${check.evidence}`)
      .join(' ; ')
    lines.push(`| ${row.workflow} | ${row.status} | ${evidence} |`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    'storage-dir': { type: 'string' },
    profile: { type: 'string' },
    'log-level': { type: 'string' },
    'no-animations': { type: 'boolean', default: true },
    nsec: { type: 'string' },
    ncryptsec: { type: 'string' },
    password: { type: 'string' },
    'invitee-pubkey': { type: 'string' },
    'json-out': { type: 'string' }
  }
})

const cwd = process.cwd()
const storageDir = parsed.values['storage-dir']
  ? path.resolve(cwd, parsed.values['storage-dir'])
  : resolveDesktopParityStorageDir(cwd)
const inviteePubkey = String(
  parsed.values['invitee-pubkey']
  || process.env.HYPERTUNA_TUI_INVITEE_PUBKEY
  || 'b'.repeat(64)
).trim().toLowerCase()

const runtime: RuntimeOptions = {
  cwd,
  storageDir,
  profile: parsed.values.profile,
  logLevel: parseLogLevel(parsed.values['log-level']),
  noAnimations: Boolean(parsed.values['no-animations'])
}

const controller = new TuiController(runtime)
const rows: MatrixRow[] = []

try {
  await controller.initialize()
  await bootstrapAccount(controller, {
    nsec: parsed.values.nsec,
    ncryptsec: parsed.values.ncryptsec,
    password: parsed.values.password
  })
  await controller.startWorker()
  await Promise.all([
    controller.refreshRelays(),
    controller.refreshGroups(),
    controller.refreshInvites(),
    controller.refreshGroupFiles().catch(() => {}),
    controller.initChats().catch(() => {}),
    controller.refreshChats().catch(() => {})
  ])

  {
    const checks: CheckResult[] = []
    const before = controller.getState()
    const beforeMyGroups = before.myGroups.length
    const name = `matrix-group-${Date.now().toString(36)}`
    try {
      await controller.createRelay({
        name,
        description: 'live matrix create-group',
        isPublic: true,
        isOpen: true,
        fileSharing: true
      })
      await Promise.all([controller.refreshGroups(), controller.refreshRelays()])
      const after = controller.getState()
      const created = after.myGroups.find((group) => group.name === name)
      checks.push({
        name: 'create group from workflow',
        status: created ? 'PASS' : 'FAIL',
        evidence: created ? `group=${created.id}` : 'created group not found in myGroups'
      })
      checks.push({
        name: 'my groups count increments',
        status: after.myGroups.length > beforeMyGroups ? 'PASS' : 'FAIL',
        evidence: `before=${beforeMyGroups} after=${after.myGroups.length}`
      })
      checks.push({
        name: 'relay list contains created group relay',
        status: created && after.relays.some((relay) => relay.publicIdentifier === created.id) ? 'PASS' : 'FAIL',
        evidence: created ? `publicIdentifier=${created.id}` : 'missing created group id'
      })
    } catch (error) {
      checks.push({
        name: 'create group from workflow',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }
    rows.push({
      workflow: 'Groups -> My Groups',
      status: summarizeChecks(checks),
      checks
    })
  }

  {
    const checks: CheckResult[] = []
    const snapshot = controller.getState()
    const sessionPubkey = snapshot.session?.pubkey?.toLowerCase() || ''
    const adminGroup = snapshot.myGroups.find((group) =>
      String(group.adminPubkey || '').toLowerCase() === sessionPubkey
      && Boolean(group.relay)
    )
    if (!isHex64(inviteePubkey)) {
      checks.push({
        name: 'invitee pubkey preflight',
        status: 'SKIP',
        evidence: 'invalid invitee pubkey (expected 64 hex)'
      })
    } else if (!adminGroup || !adminGroup.relay) {
      checks.push({
        name: 'admin-owned group preflight',
        status: 'SKIP',
        evidence: 'no admin-owned group with relay URL available'
      })
    } else {
      try {
        await controller.sendInvite({
          groupId: adminGroup.id,
          relayUrl: adminGroup.relay,
          inviteePubkey,
          payload: {
            groupName: adminGroup.name || adminGroup.id,
            isPublic: adminGroup.isPublic !== false,
            fileSharing: true
          }
        })
        checks.push({
          name: 'send group invite',
          status: 'PASS',
          evidence: `group=${adminGroup.id} invitee=${shortId(inviteePubkey)}`
        })
      } catch (error) {
        checks.push({
          name: 'send group invite',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }

      try {
        await controller.refreshInvites()
        const invite = controller.getState().groupInvites[0]
        if (!invite) {
          checks.push({
            name: 'accept/dismiss inbound group invite',
            status: 'SKIP',
            evidence: 'no inbound group invite available in current account'
          })
        } else {
          await controller.dismissGroupInvite(invite.id)
          await controller.refreshInvites()
          const removed = !controller.getState().groupInvites.some((entry) => entry.id === invite.id)
          checks.push({
            name: 'dismiss inbound group invite',
            status: removed ? 'PASS' : 'FAIL',
            evidence: `inviteId=${invite.id}`
          })
        }
      } catch (error) {
        checks.push({
          name: 'accept/dismiss inbound group invite',
          status: 'FAIL',
          evidence: error instanceof Error ? error.message : String(error)
        })
      }
    }
    rows.push({
      workflow: 'Invites -> Group',
      status: summarizeChecks(checks),
      checks
    })
  }

  {
    const checks: CheckResult[] = []
    if (!isHex64(inviteePubkey)) {
      checks.push({
        name: 'invitee pubkey preflight',
        status: 'SKIP',
        evidence: 'invalid invitee pubkey (expected 64 hex)'
      })
      rows.push({
        workflow: 'Invites -> Chat',
        status: summarizeChecks(checks),
        checks
      })
    } else {
      try {
        await controller.refreshChats()
      } catch {}
      let snapshot = controller.getState()
      const sessionPubkey = String(snapshot.session?.pubkey || '').toLowerCase()
      let conversation = snapshot.conversations.find((entry) =>
        (entry.adminPubkeys || []).map((pubkey) => String(pubkey || '').toLowerCase()).includes(sessionPubkey)
      )
      if (!conversation) {
        const title = `matrix-chat-${Date.now().toString(36)}`
        await controller.createConversation({
          title,
          members: [],
          relayMode: 'withFallback'
        })
        snapshot = controller.getState()
        conversation = snapshot.conversations.find((entry) => entry.title === title)
      }

      if (!conversation) {
        checks.push({
          name: 'admin-owned chat preflight',
          status: 'FAIL',
          evidence: 'unable to resolve or create admin-owned chat'
        })
      } else {
        try {
          const result = await controller.inviteChatMembers(conversation.id, [inviteePubkey])
          const invited = result.invited.includes(inviteePubkey)
          checks.push({
            name: 'send chat invite',
            status: invited ? 'PASS' : 'FAIL',
            evidence: invited
              ? `conversation=${conversation.id}`
              : `failed=${result.failed.map((entry) => `${shortId(entry.pubkey)}:${entry.error}`).join(',') || 'none'}`
          })
        } catch (error) {
          checks.push({
            name: 'send chat invite',
            status: 'FAIL',
            evidence: error instanceof Error ? error.message : String(error)
          })
        }

        try {
          await controller.refreshChats()
          const invite = controller.getState().chatInvites[0]
          if (!invite) {
            checks.push({
              name: 'accept/dismiss inbound chat invite',
              status: 'SKIP',
              evidence: 'no inbound chat invite available in current account'
            })
          } else {
            await controller.dismissChatInvite(invite.id)
            await controller.refreshChats()
            const removed = !controller.getState().chatInvites.some((entry) => entry.id === invite.id)
            checks.push({
              name: 'dismiss inbound chat invite',
              status: removed ? 'PASS' : 'FAIL',
              evidence: `inviteId=${invite.id}`
            })
          }
        } catch (error) {
          checks.push({
            name: 'accept/dismiss inbound chat invite',
            status: 'FAIL',
            evidence: error instanceof Error ? error.message : String(error)
          })
        }
      }

      rows.push({
        workflow: 'Invites -> Chat',
        status: summarizeChecks(checks),
        checks
      })
    }
  }

  {
    const checks: CheckResult[] = []
    try {
      await controller.refreshGroupFiles()
      const snapshot = controller.getState()
      const file = snapshot.files.find((entry) => Boolean(entry.sha256))
      if (!file || !file.sha256) {
        checks.push({
          name: 'file preflight',
          status: 'SKIP',
          evidence: 'no group files with sha256 available'
        })
      } else {
        const hash = file.sha256
        const downloadResult = await controller.downloadGroupFile({
          relayKey: file.groupRelay && isHex64(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
          publicIdentifier: file.groupId,
          groupId: file.groupId,
          eventId: file.eventId,
          fileHash: hash,
          fileName: file.fileName || null
        })
        checks.push({
          name: 'download file to OS path',
          status: await fileExists(downloadResult.savedPath) ? 'PASS' : 'FAIL',
          evidence: downloadResult.savedPath
        })

        const deleteResult = await controller.deleteLocalGroupFile({
          relayKey: file.groupRelay && isHex64(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
          publicIdentifier: file.groupId,
          groupId: file.groupId,
          eventId: file.eventId,
          fileHash: hash
        })
        const hiddenAfterDelete = controller.getState().hiddenDeletedFileKeys.includes(hash.toLowerCase())
        checks.push({
          name: 'delete hides file row',
          status: deleteResult.deleted && hiddenAfterDelete ? 'PASS' : 'FAIL',
          evidence: `deleted=${deleteResult.deleted} hidden=${hiddenAfterDelete}`
        })

        await controller.downloadGroupFile({
          relayKey: file.groupRelay && isHex64(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
          publicIdentifier: file.groupId,
          groupId: file.groupId,
          eventId: file.eventId,
          fileHash: hash,
          fileName: file.fileName || null
        })
        const hiddenAfterRedownload = controller.getState().hiddenDeletedFileKeys.includes(hash.toLowerCase())
        checks.push({
          name: 're-download unhides file row',
          status: hiddenAfterRedownload ? 'FAIL' : 'PASS',
          evidence: `hidden=${hiddenAfterRedownload}`
        })
      }
    } catch (error) {
      checks.push({
        name: 'file workflow',
        status: 'FAIL',
        evidence: error instanceof Error ? error.message : String(error)
      })
    }
    rows.push({
      workflow: 'Files',
      status: summarizeChecks(checks),
      checks
    })
  }

  const report: MatrixReport = {
    generatedAt: new Date().toISOString(),
    storageDir,
    profile: controller.getState().currentAccountPubkey || null,
    rows
  }

  printHumanTable(rows)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  const jsonOut = parsed.values['json-out']
  if (jsonOut) {
    const outputPath = path.resolve(cwd, jsonOut)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2))
    process.stdout.write(`Wrote matrix report: ${outputPath}\n`)
  }

  if (rows.some((row) => row.status === 'FAIL')) {
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`live workflow matrix failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  const shutdownGraceMs = 4_000
  await Promise.race([
    controller.shutdown().catch(() => {}),
    new Promise<void>((resolve) => {
      setTimeout(resolve, shutdownGraceMs)
    })
  ])
  process.exit(process.exitCode || 0)
}
