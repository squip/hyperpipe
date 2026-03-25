import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import React from 'react'
import { render } from 'ink'
import { App, type ScriptedCommand } from '../../src/ui/App.js'
import type { LogLevel } from '../../src/domain/types.js'
import { resolveDesktopParityStorageDir } from '../../src/storage/defaultStorageDir.js'
import { resolveStoragePaths } from '../../src/storage/paths.js'

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

function isHex64(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value)
}

type StoredAccount = {
  pubkey: string
  signerType: 'nsec' | 'ncryptsec' | string
}

type StoredAccountsFile = {
  currentPubkey?: string | null
  accounts?: StoredAccount[]
}

async function readStoredAccounts(filePath: string): Promise<StoredAccountsFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as StoredAccountsFile
  } catch {
    return null
  }
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    'storage-dir': {
      type: 'string'
    },
    profile: {
      type: 'string'
    },
    'no-animations': {
      type: 'boolean',
      default: false
    },
    'log-level': {
      type: 'string'
    },
    'stay-open': {
      type: 'boolean',
      default: false
    },
    nsec: {
      type: 'string'
    },
    ncryptsec: {
      type: 'string'
    },
    password: {
      type: 'string'
    },
    'invitee-pubkey': {
      type: 'string'
    },
    'join-id': {
      type: 'string'
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false
    }
  },
  allowPositionals: false
})

const env = process.env

const nsec = parsed.values.nsec || env.HYPERTUNA_TUI_NSEC
const ncryptsec = parsed.values.ncryptsec || env.HYPERTUNA_TUI_NCRYPTSEC
const password = parsed.values.password || env.HYPERTUNA_TUI_PASSWORD
const joinId = parsed.values['join-id'] || env.HYPERTUNA_TUI_JOIN_ID

const rawInviteePubkey =
  parsed.values['invitee-pubkey']
  || env.HYPERTUNA_TUI_INVITEE_PUBKEY
  || 'b'.repeat(64)

const inviteePubkey = isHex64(rawInviteePubkey)
  ? rawInviteePubkey.toLowerCase()
  : 'b'.repeat(64)

if (parsed.values.help) {
  const lines = [
    'hypertuna real-backend walkthrough',
    '',
    'Usage:',
    '  npm run demo:e2e:real',
    '  npm run demo:e2e:real -- --stay-open',
    '  npm run demo:e2e:real -- --nsec <nsec> [--storage-dir <path>]',
    '  npm run demo:e2e:real -- --ncryptsec <ncryptsec> --password <pwd>',
    '  (without credentials it will login an existing profile, or auto-generate one)',
    '',
    'Flags:',
    '  --storage-dir <path>',
    '  --profile <pubkey>',
    '  --no-animations',
    '  --log-level <debug|info|warn|error>',
    '  --stay-open',
    '  --nsec <nsec>',
    '  --ncryptsec <ncryptsec>',
    '  --password <pwd>',
    '  --invitee-pubkey <64-char-hex>',
    '  --join-id <groupPublicIdentifier>',
    '',
    'Environment fallbacks:',
    '  HYPERTUNA_TUI_NSEC, HYPERTUNA_TUI_NCRYPTSEC, HYPERTUNA_TUI_PASSWORD,',
    '  HYPERTUNA_TUI_INVITEE_PUBKEY, HYPERTUNA_TUI_JOIN_ID'
  ]

  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(0)
}

if (nsec && ncryptsec) {
  process.stderr.write('Use either --nsec or --ncryptsec, not both.\n')
  process.exit(1)
}

if (ncryptsec && !password) {
  process.stderr.write('A password is required with --ncryptsec.\n')
  process.exit(1)
}

const cwd = process.cwd()
const storageDir = parsed.values['storage-dir']
  ? path.resolve(cwd, parsed.values['storage-dir'])
  : resolveDesktopParityStorageDir(cwd)

const suffix = Date.now().toString(36)
const demoGroupName = `tui-demo-${suffix}`
const demoChatTitle = `TuiDemoChat-${suffix}`
const generatedProfileName = `real-demo-${suffix}`

const accountsFilePath = resolveStoragePaths(storageDir).accountsFile
const stored = await readStoredAccounts(accountsFilePath)
const storedAccounts = Array.isArray(stored?.accounts) ? stored.accounts : []

if (parsed.values.profile && !nsec && !ncryptsec) {
  const profileExists = storedAccounts.some((entry) => entry.pubkey === parsed.values.profile)
  if (!profileExists) {
    process.stderr.write(
      `Profile ${parsed.values.profile} not found in ${accountsFilePath}. Provide --nsec or --ncryptsec to bootstrap a new profile.\n`
    )
    process.exit(1)
  }
}

let bootstrapCommand: string
if (nsec) {
  bootstrapCommand = `account add-nsec ${nsec} ${generatedProfileName}`
} else if (ncryptsec && password) {
  bootstrapCommand = `account add-ncryptsec ${ncryptsec} ${password} ${generatedProfileName}`
} else {
  const preferredPubkey = parsed.values.profile || stored?.currentPubkey || storedAccounts[0]?.pubkey
  const preferred = storedAccounts.find((entry) => entry.pubkey === preferredPubkey) || null
  const anyNsec = storedAccounts.find((entry) => entry.signerType === 'nsec')

  if (preferred?.signerType === 'nsec') {
    bootstrapCommand = `account login ${preferred.pubkey}`
  } else if (preferred?.signerType === 'ncryptsec' && password) {
    bootstrapCommand = `account login ${preferred.pubkey} ${password}`
  } else if (anyNsec) {
    bootstrapCommand = `account login ${anyNsec.pubkey}`
  } else {
    bootstrapCommand = `account generate ${generatedProfileName}`
  }
}

let knownRelayKeys = new Set<string>()
let createdGroupId: string | null = null
let createdGroupRelay: string | null = null
let currentConversationId: string | null = null

const commands: ScriptedCommand[] = [
  { command: 'account profiles', delayMs: 400 },
  { command: bootstrapCommand, pauseAfterMs: 900 },
  { command: 'account profiles', pauseAfterMs: 700 },
  {
    resolveCommand: (controller) => {
      const state = controller.getState()
      knownRelayKeys = new Set(state.relays.map((relay) => relay.relayKey))
      return 'relay refresh'
    },
    pauseAfterMs: 900
  },
  {
    command: `relay create ${demoGroupName} --public --open --desc real_backend_walkthrough`,
    pauseAfterMs: 1_200
  },
  {
    resolveCommand: (controller) => {
      const state = controller.getState()

      const newRelay = state.relays.find((relay) => !knownRelayKeys.has(relay.relayKey))
      if (newRelay?.publicIdentifier) {
        createdGroupId = newRelay.publicIdentifier
      }

      if (!createdGroupId) {
        createdGroupId = state.groups.find((group) => group.name === demoGroupName)?.id || null
      }

      const createdGroup = createdGroupId
        ? state.groups.find((group) => group.id === createdGroupId)
        : null

      createdGroupRelay = createdGroup?.relay || null
      return 'relay refresh'
    }
  },
  { command: 'copy selected' },
  { command: 'copy command' },
  { command: 'goto invites:group' },
  { command: `relay update-members add ${inviteePubkey}` },
  { command: `relay update-auth ${inviteePubkey} demo-auth-${suffix}` },
  {
    resolveCommand: () => {
      if (!createdGroupId || !createdGroupRelay) return null
      return `relay invite ${createdGroupId} ${createdGroupRelay} ${inviteePubkey} demo-token-${suffix}`
    }
  },
  {
    resolveCommand: () => {
      const target = joinId || createdGroupId
      if (!target) return null
      return `relay join-flow ${target} demo-join-${suffix} --open`
    }
  },
  {
    resolveCommand: () => {
      const target = joinId || createdGroupId
      if (!target) return null
      return `relay join ${target} demo-join-${suffix}`
    }
  },
  { command: `post "Hyperpipe real-backend walkthrough post ${suffix}"` },
  {
    resolveCommand: () => {
      if (!createdGroupId) return null
      return `compose start ${createdGroupId}`
    }
  },
  { command: `compose text "compose walkthrough note ${suffix}"` },
  { command: 'compose publish' },
  {
    resolveCommand: () => {
      if (!createdGroupId) return null
      return `file refresh ${createdGroupId}`
    }
  },
  { command: 'chat init' },
  {
    resolveCommand: (controller) => {
      const invite = controller.getState().chatInvites[0]
      if (!invite?.id) return null
      return `chat accept ${invite.id}`
    }
  },
  {
    resolveCommand: (controller) => {
      const conversation = controller.getState().conversations[0]
      if (!conversation?.id) return null
      currentConversationId = conversation.id
      return `chat thread ${conversation.id}`
    }
  },
  {
    resolveCommand: () => {
      if (!currentConversationId) return null
      return `chat send ${currentConversationId} "walkthrough chat message ${suffix}"`
    }
  },
  { command: 'invites refresh' },
  { command: 'goto logs' }
]

render(
  <App
    options={{
      cwd,
      storageDir,
      profile: parsed.values.profile,
      noAnimations: Boolean(parsed.values['no-animations']),
      logLevel: parseLogLevel(parsed.values['log-level'])
    }}
    scriptedCommands={commands}
    autoExitOnScriptComplete={!parsed.values['stay-open']}
  />,
  {
    patchConsole: true,
    exitOnCtrlC: false
  }
)
