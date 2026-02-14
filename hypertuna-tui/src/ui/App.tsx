import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { TuiController, type ControllerState, type RuntimeOptions } from '../domain/controller.js'
import { copy as copyToClipboard } from '../runtime/clipboard.js'
import {
  FILE_FAMILY_ORDER,
  FILE_FAMILY_LABELS,
  type FileFamily,
  fileFamilyFromNodeId,
  isFileTypeNodeId,
  isParentNavId,
  ROOT_NAV_LABELS,
  ROOT_NAV_ORDER,
  type NavNodeId,
  type ParentNavId
} from '../lib/constants.js'
import { shortId } from '../lib/format.js'
import {
  buildCommandSnippet,
  executeCommand,
  type CommandContext,
  type CommandController
} from './commandRouter.js'

type AppProps = {
  options: RuntimeOptions
  controllerFactory?: (options: RuntimeOptions) => AppController
  scriptedCommands?: ScriptedCommand[]
  autoExitOnScriptComplete?: boolean
}

export interface AppController extends CommandController {
  initialize(): Promise<void>
  subscribe(listener: (state: ControllerState) => void): () => void
  getState(): ControllerState
  shutdown(): Promise<void>
  setPaneViewport(sectionKey: string, cursor: number, offset: number): Promise<void>
  setDetailPaneOffset(sectionKey: string, offset: number): Promise<void>
  setSelectedNode(nodeId: NavNodeId): Promise<void>
  setFocusPane(focusPane: 'left-tree' | 'center' | 'right-top' | 'right-bottom'): Promise<void>
  setTreeExpanded(nextExpanded: {
    groups: boolean
    chats: boolean
    invites: boolean
    files: boolean
  }): Promise<void>
  setRightTopSelection(nodeId: string, index: number): Promise<void>
}

export type ScriptedCommand = {
  command?: string
  resolveCommand?: (controller: AppController) => string | null | Promise<string | null>
  delayMs?: number
  pauseAfterMs?: number
  timeoutMs?: number
}

type FocusPane = 'left-tree' | 'center' | 'right-top' | 'right-bottom'
type TreeExpanded = { groups: boolean; chats: boolean; invites: boolean; files: boolean }
type ViewportMap = Record<string, { cursor: number; offset: number }>
type OffsetMap = Record<string, number>
type IndexMap = Record<string, number>

type NavRow = {
  id: NavNodeId
  label: string
  depth: number
  parent: ParentNavId | null
  isParent: boolean
  expanded: boolean
}

type CenterRow = {
  key: string
  label: string
  kind:
    | 'summary'
    | 'relay'
    | 'group'
    | 'group-invite'
    | 'chat-invite'
    | 'chat-conversation'
    | 'form-field'
    | 'form-option'
    | 'invite-mode'
    | 'file'
    | 'account'
    | 'log'
  data: unknown
}

type GroupCreateDraft = {
  name: string
  about: string
  membership: 'open' | 'closed'
  visibility: 'public' | 'private'
}

type ChatCreateDraft = {
  name: string
  description: string
  inviteMembers: string[]
  relayUrls: string[]
}

type InviteSendMode = 'group' | 'chat'

type ProfileSuggestion = {
  pubkey: string
  name?: string | null
  about?: string | null
  nip05?: string | null
  source?: 'local' | 'remote' | 'cache'
}

const DEFAULT_TREE_EXPANDED: TreeExpanded = {
  groups: true,
  chats: true,
  invites: true,
  files: true
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isHex64(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function shortText(value: string | null | undefined, max = 80): string {
  if (!value) return ''
  const sanitized = String(value)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (sanitized.length <= max) return sanitized
  return `${sanitized.slice(0, max - 1)}…`
}

function wrapText(input: string, width: number): string[] {
  const text = String(input || '')
  if (!text) return ['']
  const max = Math.max(12, width)
  const words = text.split(/\s+/g)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!word) continue
    const next = current ? `${current} ${word}` : word
    if (next.length <= max) {
      current = next
      continue
    }
    if (current) {
      lines.push(current)
      current = ''
    }
    if (word.length <= max) {
      current = word
      continue
    }
    for (let index = 0; index < word.length; index += max) {
      lines.push(word.slice(index, index + max))
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function normalizeViewport(
  selectedIndex: number,
  offset: number,
  totalRows: number,
  visibleRows: number
): { selectedIndex: number; offset: number } {
  const rows = Math.max(1, visibleRows)
  const total = Math.max(0, totalRows)
  const selected = total <= 0 ? 0 : clamp(selectedIndex, 0, total - 1)
  if (total <= rows) {
    return {
      selectedIndex: selected,
      offset: 0
    }
  }

  const maxOffset = Math.max(0, total - rows)
  let nextOffset = clamp(offset, 0, maxOffset)
  if (selected < nextOffset) {
    nextOffset = selected
  } else if (selected >= nextOffset + rows) {
    nextOffset = selected - rows + 1
  }

  return {
    selectedIndex: selected,
    offset: clamp(nextOffset, 0, maxOffset)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForControllerIdle(controller: AppController, timeoutMs = 45_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = controller.getState()
    if (!snapshot.busyTask) return true
    await sleep(120)
  }
  return false
}

async function withStepTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Math.max(1_000, Math.min(Math.trunc(timeoutMs || 0), 300_000))
  let timeoutId: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
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

function TruncText(props: React.ComponentProps<typeof Text>): React.JSX.Element {
  return <Text {...props} wrap="truncate-end" />
}

function useTerminalDimensions(): [number, number] {
  const { stdout } = useStdout()
  const [dimensions, setDimensions] = useState(() => ({
    width: Number(stdout?.columns || 120),
    height: Number(stdout?.rows || 40)
  }))

  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return

    const update = (): void => {
      const nextWidth = Number(stdout.columns || 120)
      const nextHeight = Number(stdout.rows || 40)
      setDimensions((previous) => {
        if (previous.width === nextWidth && previous.height === nextHeight) {
          return previous
        }
        return {
          width: nextWidth,
          height: nextHeight
        }
      })
    }

    update()
    stdout.on('resize', update)
    return () => {
      if (typeof stdout.off === 'function') {
        stdout.off('resize', update)
      } else {
        stdout.removeListener('resize', update)
      }
    }
  }, [stdout])

  return [dimensions.width, dimensions.height]
}

function frameSegments(totalRows: number): {
  mainRows: number
  commandRows: number
  keysRows: number
  statusRows: number
} {
  const commandRows = 3
  const keysRows = 1
  const statusRows = 1
  const reserved = commandRows + keysRows + statusRows
  const mainRows = Math.max(10, totalRows - reserved)
  return {
    mainRows,
    commandRows,
    keysRows,
    statusRows
  }
}

function fileFamilyForMime(mime?: string | null): FileFamily {
  const normalized = String(mime || '').toLowerCase()
  if (normalized.startsWith('image/')) return 'images'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  if (
    normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('pdf')
    || normalized.includes('markdown')
    || normalized.includes('msword')
    || normalized.includes('officedocument')
  ) {
    return 'docs'
  }
  return 'other'
}

function navRowsFromState(state: ControllerState, expanded: TreeExpanded): NavRow[] {
  const rows: NavRow[] = []
  for (const root of ROOT_NAV_ORDER) {
    let rootLabel = ROOT_NAV_LABELS[root]
    if (root === 'groups') rootLabel = 'Groups'
    if (root === 'invites') rootLabel = `Invites (${state.invitesCount})`
    if (root === 'files') rootLabel = `Files (${state.filesCount})`
    if (root === 'chats') rootLabel = `Chats (${state.chatUnreadTotal + state.chatPendingInviteCount})`

    const isParent = root === 'groups' || root === 'chats' || root === 'invites' || root === 'files'
    const parent = isParent ? (root as ParentNavId) : null
    const isExpanded = isParent ? expanded[root as ParentNavId] : false
    rows.push({
      id: root,
      label: rootLabel,
      depth: 0,
      parent: null,
      isParent,
      expanded: isExpanded
    })

    if (root === 'groups' && expanded.groups) {
      rows.push({
        id: 'groups:browse',
        label: 'Browse Groups',
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'groups:my',
        label: `My Groups (${state.myGroups.length})`,
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'groups:create',
        label: 'Create Group',
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'chats' && expanded.chats) {
      rows.push({
        id: 'chats:create',
        label: 'Create Chat',
        depth: 1,
        parent: 'chats',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'invites' && expanded.invites) {
      rows.push({
        id: 'invites:group',
        label: `Group Invites (${state.groupInvites.length})`,
        depth: 1,
        parent: 'invites',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'invites:chat',
        label: `Chat Invites (${state.chatInvites.length})`,
        depth: 1,
        parent: 'invites',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'invites:send',
        label: 'Send Invite',
        depth: 1,
        parent: 'invites',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'files' && expanded.files) {
      for (const family of FILE_FAMILY_ORDER as readonly FileFamily[]) {
        const count = state.fileFamilyCounts[family] || 0
        rows.push({
          id: `files:type:${family}` as NavNodeId,
          label: `${FILE_FAMILY_LABELS[family]} (${count})`,
          depth: 1,
          parent: 'files',
          isParent: false,
          expanded: false
        })
      }
    }
  }
  return rows
}

function centerRowsForNode(state: ControllerState, node: NavNodeId): CenterRow[] {
  if (node === 'dashboard') {
    return [
      {
        key: 'summary',
        label:
          `Worker:${state.lifecycle} Relays:${state.relays.length} Groups:${state.groupDiscover.length} ` +
          `MyGroups:${state.myGroups.length} Invites:${state.invitesCount} Files:${state.filesCount} Chats:${state.conversations.length}`,
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'relays') {
    return state.relays.map((relay, idx) => {
      const label = `${shortId(relay.publicIdentifier || relay.relayKey, 10)} · ${relay.readyForReq ? 'ready' : relay.writable ? 'writable' : 'readonly'}`
      return {
        key: `${relay.relayKey}-${idx}`,
        label,
        kind: 'relay',
        data: relay
      }
    })
  }

  if (node === 'groups') {
    return [
      {
        key: 'groups:browse',
        label: `Browse Groups (${state.groupDiscover.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'groups:my',
        label: `My Groups (${state.myGroups.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'groups:create',
        label: 'Create Group',
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'groups:browse') {
    return state.groupDiscover.map((group, idx) => {
      const mode = `${group.isPublic === false ? 'private' : 'public'} | ${group.isOpen === false ? 'closed' : 'open'}`
      const members = group.membersCount || group.members?.length || 0
      return {
        key: `${group.id}-${group.event?.id || idx}`,
        label: `${shortText(group.name, 24)} · ${mode} · members:${members}`,
        kind: 'group',
        data: group
      }
    })
  }

  if (node === 'groups:my') {
    return state.myGroups.map((group, idx) => {
      const mode = `${group.isPublic === false ? 'private' : 'public'} | ${group.isOpen === false ? 'closed' : 'open'}`
      const members = group.membersCount || group.members?.length || 0
      return {
        key: `${group.id}-${group.event?.id || idx}`,
        label: `${shortText(group.name, 24)} · ${mode} · members:${members}`,
        kind: 'group',
        data: group
      }
    })
  }

  if (node === 'groups:create') {
    return [
      {
        key: 'groups:create:name',
        label: 'group name',
        kind: 'form-field',
        data: { form: 'group-create', field: 'name' }
      },
      {
        key: 'groups:create:about',
        label: 'group description',
        kind: 'form-field',
        data: { form: 'group-create', field: 'about' }
      },
      {
        key: 'groups:create:membership',
        label: 'membership policy',
        kind: 'form-field',
        data: { form: 'group-create', field: 'membership' }
      },
      {
        key: 'groups:create:membership:open',
        label: '  open',
        kind: 'form-option',
        data: { form: 'group-create', field: 'membership', value: 'open' }
      },
      {
        key: 'groups:create:membership:closed',
        label: '  closed',
        kind: 'form-option',
        data: { form: 'group-create', field: 'membership', value: 'closed' }
      },
      {
        key: 'groups:create:visibility',
        label: 'visibility',
        kind: 'form-field',
        data: { form: 'group-create', field: 'visibility' }
      },
      {
        key: 'groups:create:visibility:public',
        label: '  public',
        kind: 'form-option',
        data: { form: 'group-create', field: 'visibility', value: 'public' }
      },
      {
        key: 'groups:create:visibility:private',
        label: '  private',
        kind: 'form-option',
        data: { form: 'group-create', field: 'visibility', value: 'private' }
      },
      {
        key: 'groups:create:submit',
        label: 'create',
        kind: 'form-field',
        data: { form: 'group-create', field: 'submit' }
      }
    ]
  }

  if (node === 'chats') {
    return state.conversations.map((conversation, idx) => ({
      key: `${conversation.id}-${idx}`,
      label: `${shortText(conversation.title, 30)} · unread:${conversation.unreadCount}`,
      kind: 'chat-conversation',
      data: conversation
    }))
  }

  if (node === 'chats:create') {
    const writableRelays = state.relays
      .filter((entry) => entry.writable === true && entry.connectionUrl)
      .map((entry) => ({
        relayKey: entry.relayKey,
        relayUrl: String(entry.connectionUrl || ''),
        name: entry.publicIdentifier || shortId(entry.relayKey, 10)
      }))
    return [
      {
        key: 'chats:create:name',
        label: 'chat name',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'name' }
      },
      {
        key: 'chats:create:about',
        label: 'chat description',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'description' }
      },
      {
        key: 'chats:create:members',
        label: 'invite members',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'members' }
      },
      {
        key: 'chats:create:relays',
        label: 'chat relays',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'relays' }
      },
      ...writableRelays.map((entry) => ({
        key: `chats:create:relay:${entry.relayKey}`,
        label: `  ${entry.name}`,
        kind: 'form-option' as const,
        data: {
          form: 'chat-create',
          field: 'relay',
          value: entry.relayUrl,
          relayKey: entry.relayKey
        }
      })),
      {
        key: 'chats:create:submit',
        label: 'create',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'submit' }
      }
    ]
  }

  if (node === 'invites') {
    return [
      {
        key: 'invites:group',
        label: `Group Invites (${state.groupInvites.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'invites:chat',
        label: `Chat Invites (${state.chatInvites.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'invites:send',
        label: 'Send Invite',
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'invites:group') {
    return state.groupInvites.map((invite) => ({
      key: invite.id,
      label: `${shortText(invite.groupName || invite.groupId, 24)} · members:${invite.event?.tags?.filter((tag) => tag[0] === 'p').length || 0} · by:${shortId(invite.event.pubkey, 8)}`,
      kind: 'group-invite',
      data: invite
    }))
  }

  if (node === 'invites:chat') {
    return state.chatInvites.map((invite) => ({
      key: invite.id,
      label: `${shortText(invite.title || invite.id, 24)} · ${invite.status} · by:${shortId(invite.senderPubkey, 8)}`,
      kind: 'chat-invite',
      data: invite
    }))
  }

  if (node === 'invites:send') {
    return [
      {
        key: 'invites:send:group',
        label: 'Group Invite',
        kind: 'invite-mode',
        data: { mode: 'group' as const }
      },
      {
        key: 'invites:send:chat',
        label: 'Chat Invite',
        kind: 'invite-mode',
        data: { mode: 'chat' as const }
      }
    ]
  }

  if (node === 'files' || isFileTypeNodeId(node)) {
    const family = fileFamilyFromNodeId(node)
    const filtered = family
      ? state.files.filter((file) => fileFamilyForMime(file.mime) === family)
      : state.files
    return filtered.map((file, idx) => ({
      key: `${file.eventId}-${idx}`,
      label:
        `${shortText(file.fileName, 24)} · ${file.mime || '-'} · ${Number(file.size || 0)}B · ${shortText(file.groupName || file.groupId, 16)} · by:${shortId(file.uploadedBy, 8)}`,
      kind: 'file',
      data: file
    }))
  }

  if (node === 'accounts') {
    return state.accounts.map((account, idx) => ({
      key: `${account.pubkey}-${idx}`,
      label: `${state.currentAccountPubkey === account.pubkey ? '*' : ' '} ${shortId(account.pubkey, 10)} · ${account.signerType}`,
      kind: 'account',
      data: account
    }))
  }

  if (node === 'logs') {
    return state.logs.map((entry, idx) => ({
      key: `${entry.ts}-${idx}`,
      label: `${new Date(entry.ts).toLocaleTimeString()} [${entry.level}] ${shortText(entry.message, 90)}`,
      kind: 'log',
      data: entry
    }))
  }

  return []
}

function splitNode(node: NavNodeId): boolean {
  return (
    node === 'groups:browse'
    || node === 'groups:my'
    || node === 'groups:create'
    || node === 'chats:create'
    || node === 'invites:group'
    || node === 'invites:chat'
    || node === 'invites:send'
    || node === 'files'
    || isFileTypeNodeId(node)
  )
}

function isFormCenterNode(node: NavNodeId): boolean {
  return node === 'groups:create' || node === 'chats:create' || node === 'invites:send'
}

function groupKey(groupId: string, relay?: string | null): string {
  const normalizedGroupId = String(groupId || '').trim()
  const normalizedRelay = relay ? relay.trim() : ''
  return `${normalizedRelay}|${normalizedGroupId}`
}

function groupDetailsRows(group: any): string[] {
  if (!group) return ['No group selected']
  const members = Number(group.membersCount || group.members?.length || 0)
  return [
    `id: ${group.id}`,
    `name: ${group.name || '-'}`,
    `about: ${group.about || '-'}`,
    `createdAt: ${group.createdAt ? new Date(group.createdAt * 1000).toLocaleString() : '-'}`,
    `visibility: ${group.isPublic === false ? 'private' : 'public'}`,
    `membership: ${group.isOpen === false ? 'closed' : 'open'}`,
    `admin: ${group.adminName || group.adminPubkey || '-'}`,
    `members: ${members}`,
    `peers online: ${group.peersOnline || 0}`
  ]
}

function fileRowsForGroup(state: ControllerState, group: any): any[] {
  if (!group) return []
  const directKey = groupKey(group.id, group.relay || null)
  const fallbackKey = groupKey(group.id, null)
  return state.groupFilesByGroupKey[directKey] || state.groupFilesByGroupKey[fallbackKey] || []
}

function noteRowsForGroup(state: ControllerState, group: any): any[] {
  if (!group) return []
  const directKey = groupKey(group.id, group.relay || null)
  const fallbackKey = groupKey(group.id, null)
  return state.groupNotesByGroupKey[directKey] || state.groupNotesByGroupKey[fallbackKey] || []
}

function rightTopActions(state: ControllerState, node: NavNodeId, selectedRow: CenterRow | null): string[] {
  if (node === 'groups:browse') {
    const group = selectedRow?.data as any
    const actions = ['Group details', 'Admin details', 'Members']
    if (!group) return actions
    const isPublic = group.isPublic !== false
    const isOpen = group.isOpen !== false
    if (isPublic && isOpen) {
      actions.push('Join Group')
    } else if (isPublic && !isOpen) {
      actions.push('Request Invite')
    } else if (!isPublic) {
      actions.push('Invite-only (private)')
    }
    return actions
  }
  if (node === 'groups:my') {
    const group = selectedRow?.data as any
    const members = Number(group?.membersCount || group?.members?.length || 0)
    const files = fileRowsForGroup(state, group).length
    const joinReq = Object.values(state.groupJoinRequests).reduce((acc, rows) => acc + rows.length, 0)
    return [
      'Group details',
      `Members (${members})`,
      'Notes',
      `Files (${files})`,
      `Join Requests (${joinReq})`
    ]
  }
  if (node === 'groups:create') {
    return ['name: -', 'description: -', 'membership: open', 'visibility: public']
  }
  if (node === 'chats:create') {
    return ['name: -', 'description: -', 'members: 0', 'relays: 0']
  }
  if (node === 'invites:group') {
    const invite = selectedRow?.data as any
    const group = state.groupDiscover.find((entry) => entry.id === invite?.groupId)
    const members = Number(group?.membersCount || group?.members?.length || 0)
    return [
      'Group details',
      'Admin details',
      `Members (${members})`,
      'Accept invite',
      'Dismiss invite'
    ]
  }
  if (node === 'invites:chat') {
    return [
      'Chat details',
      'Invited by',
      'Members',
      'Accept invite',
      'Dismiss invite'
    ]
  }
  if (node === 'invites:send') {
    const mode = (selectedRow?.data as { mode?: 'group' | 'chat' } | null)?.mode || 'group'
    const currentPubkey = String(state.session?.pubkey || '').trim().toLowerCase()
    if (mode === 'group') {
      const groups = state.myGroups.filter((group) => {
        const adminPubkey = String(group.adminPubkey || '').trim().toLowerCase()
        return Boolean(adminPubkey && currentPubkey && adminPubkey === currentPubkey)
      })
      if (!groups.length) return ['No admin groups available']
      return groups.map((group) => `${shortText(group.name || group.id, 24)} · ${group.id}`)
    }
    const chats = state.conversations.filter((conversation) => {
      const admins = Array.isArray(conversation.adminPubkeys)
        ? conversation.adminPubkeys.map((pubkey) => String(pubkey || '').trim().toLowerCase())
        : []
      return Boolean(currentPubkey && admins.includes(currentPubkey))
    })
    if (!chats.length) return ['No admin chats available']
    return chats.map((conversation) => `${shortText(conversation.title || conversation.id, 24)} · ${conversation.id}`)
  }
  if (node === 'files' || isFileTypeNodeId(node)) {
    return ['Download', 'Delete']
  }
  return []
}

function singleRightRows(state: ControllerState, node: NavNodeId, selectedRow: CenterRow | null): string[] {
  if (node === 'dashboard') {
    return [
      `Current account: ${state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 10) : 'none'}`,
      `Session: ${state.session ? shortId(state.session.pubkey, 10) : 'locked'}`,
      `Worker: ${state.lifecycle}`,
      `Status: ${shortText(state.readinessMessage, 120)}`,
      `Relays: ${state.relays.length}`,
      `Groups discover: ${state.groupDiscover.length}`,
      `My groups: ${state.myGroups.length}`,
      `Invites: ${state.invitesCount}`,
      `Files: ${state.filesCount}`,
      `Chats: ${state.conversations.length} / pending ${state.chatPendingInviteCount}`,
      `Perf avg ${state.perfMetrics.avgLatencyMs.toFixed(1)}ms p95 ${state.perfMetrics.p95LatencyMs.toFixed(1)}ms`
    ]
  }

  if (node === 'relays') {
    const relay = selectedRow?.data as any
    if (!relay) return ['No relay selected']
    return [
      `relayKey: ${shortId(relay.relayKey, 20)}`,
      `identifier: ${relay.publicIdentifier || '-'}`,
      `url: ${relay.connectionUrl || '-'}`,
      `writable: ${String(Boolean(relay.writable))}`,
      `requiresAuth: ${String(Boolean(relay.requiresAuth))}`,
      `readyForReq: ${String(Boolean(relay.readyForReq))}`,
      `members: ${relay.members?.length || 0}`
    ]
  }

  if (node === 'chats') {
    const row = selectedRow?.data as any
    if (!row) return ['No conversation selected']
    return [
      `id: ${row.id}`,
      `title: ${row.title || '-'}`,
      `participants: ${Array.isArray(row.participants) ? row.participants.length : 0}`,
      `admins: ${Array.isArray(row.adminPubkeys) ? row.adminPubkeys.length : 0}`,
      `unread: ${row.unreadCount || 0}`,
      `last message: ${row.lastMessagePreview || '-'}`
    ]
  }

  if (node === 'accounts') {
    const account = selectedRow?.data as any
    if (!account) return ['No account selected']
    return [
      `pubkey: ${account.pubkey}`,
      `signer: ${account.signerType}`,
      `label: ${account.label || '-'}`,
      `created: ${new Date(account.createdAt).toLocaleString()}`,
      `updated: ${new Date(account.updatedAt).toLocaleString()}`
    ]
  }

  if (node === 'logs') {
    return [
      `stdout lines: ${state.workerStdout.length}`,
      `stderr lines: ${state.workerStderr.length}`,
      `entries: ${state.logs.length}`,
      'Use center pane selection to inspect individual log lines.'
    ]
  }

  return ['No details']
}

function splitBottomRows(
  state: ControllerState,
  node: NavNodeId,
  selectedRow: CenterRow | null,
  selectedAction: string,
  paneActionMessage: string | null
): string[] {
  if (node === 'groups:browse') {
    const group = selectedRow?.data as any
    if (!group) return ['No group selected']
    if (selectedAction.startsWith('Group details')) {
      return groupDetailsRows(group)
    }
    if (selectedAction.startsWith('Admin details')) {
      const profile = state.adminProfileByPubkey[group.adminPubkey || group.event?.pubkey || '']
      return [
        `name: ${profile?.name || group.adminName || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${group.adminPubkey || group.event?.pubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Join Group')) {
      return [
        paneActionMessage || 'Press Enter to join this group',
        `group: ${group.name || group.id}`,
        `visibility: ${group.isPublic === false ? 'private' : 'public'}`,
        `membership: ${group.isOpen === false ? 'closed' : 'open'}`
      ]
    }
    if (selectedAction.startsWith('Request Invite')) {
      return [
        paneActionMessage || 'Press Enter to request an invite',
        `group: ${group.name || group.id}`,
        'This will publish a join request for admin review.'
      ]
    }
    if (selectedAction.startsWith('Invite-only (private)')) {
      return ['Private group (invite-only). Join action unavailable without an invite.']
    }
    const members = Array.isArray(group.members) ? group.members : []
    return members.length ? members.map((member: unknown) => `${member}`) : ['No member list available']
  }

  if (node === 'groups:my') {
    const group = selectedRow?.data as any
    if (!group) return ['No group selected']
    if (selectedAction.startsWith('Group details')) {
      return groupDetailsRows(group)
    }
    if (selectedAction.startsWith('Members')) {
      const members = Array.isArray(group.members) ? group.members : []
      return members.length ? members.map((member: unknown) => `${member}`) : ['No member list available']
    }
    if (selectedAction.startsWith('Notes')) {
      const notes = noteRowsForGroup(state, group)
      if (!notes.length) return ['No group notes loaded']
      return notes.map((note) => `${new Date(note.createdAt * 1000).toLocaleString()} · ${shortId(note.authorPubkey, 8)} · ${shortText(note.content, 120)}`)
    }
    if (selectedAction.startsWith('Files')) {
      const files = fileRowsForGroup(state, group)
      if (!files.length) return ['No group files loaded']
      return files.map((file) => `${shortText(file.fileName, 42)} · ${file.mime || '-'} · ${Number(file.size || 0)}B · by:${shortId(file.uploadedBy, 8)}`)
    }
    if (selectedAction.startsWith('Join Requests')) {
      const byRelayKey = group.relay ? `${group.relay}|${group.id}` : group.id
      const requests = state.groupJoinRequests[byRelayKey] || state.groupJoinRequests[group.id] || []
      if (!requests.length) return ['No pending join requests']
      return requests.map((request) => `${shortId(request.pubkey, 10)} · ${new Date(request.createdAt * 1000).toLocaleString()}`)
    }
    return ['No details']
  }

  if (node === 'groups:create') {
    return [
      paneActionMessage || 'Use center pane to edit fields and run create.',
      'Create workflow status will appear here.'
    ]
  }

  if (node === 'chats:create') {
    return [
      paneActionMessage || 'Use center pane to edit fields and run create.',
      'Chat creation workflow status will appear here.'
    ]
  }

  if (node === 'invites:group') {
    const invite = selectedRow?.data as any
    if (!invite) return ['No invite selected']
    const group = state.groupDiscover.find((entry) => entry.id === invite.groupId)
    if (selectedAction.startsWith('Group details')) {
      if (group) return groupDetailsRows(group)
      return [
        `id: ${invite.groupId}`,
        `name: ${invite.groupName || invite.groupId}`,
        `about: -`,
        `createdAt: ${invite.event?.created_at ? new Date(invite.event.created_at * 1000).toLocaleString() : '-'}`,
        `visibility: ${invite.isPublic === false ? 'private' : 'public'}`,
        `membership: ${invite.fileSharing === false ? 'closed' : 'open'}`,
        `admin: ${invite.event?.pubkey || '-'}`,
        `members: -`
      ]
    }
    if (selectedAction.startsWith('Admin details')) {
      const profile = state.adminProfileByPubkey[invite.event?.pubkey || '']
      return [
        `name: ${profile?.name || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${invite.event?.pubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Members')) {
      const members = Array.isArray(group?.members) ? group.members : []
      return members.length ? members : ['No member list available']
    }
    if (selectedAction.startsWith('Accept invite') || selectedAction.startsWith('Dismiss invite')) {
      return [paneActionMessage || 'Press Enter to execute this action']
    }
  }

  if (node === 'invites:chat') {
    const invite = selectedRow?.data as any
    if (!invite) return ['No invite selected']
    if (selectedAction.startsWith('Chat details')) {
      return [
        `id: ${invite.id}`,
        `title: ${invite.title || '-'}`,
        `conversationId: ${invite.conversationId || '-'}`,
        `status: ${invite.status || '-'}`,
        `createdAt: ${invite.createdAt ? new Date(invite.createdAt * 1000).toLocaleString() : '-'}`
      ]
    }
    if (selectedAction.startsWith('Invited by')) {
      const profile = state.adminProfileByPubkey[invite.senderPubkey || '']
      return [
        `name: ${profile?.name || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${invite.senderPubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Members')) {
      return ['Members are available after invite acceptance.']
    }
    if (selectedAction.startsWith('Accept invite') || selectedAction.startsWith('Dismiss invite')) {
      return [paneActionMessage || 'Press Enter to execute this action']
    }
  }

  if (node === 'invites:send') {
    return [
      paneActionMessage || 'Type a username/pubkey in the invite field and press Enter to send.',
      'Use right-top pane to select an admin-owned target.'
    ]
  }

  if (node === 'files' || isFileTypeNodeId(node)) {
    const file = selectedRow?.data as any
    if (!file) return ['No file selected']
    if (selectedAction.startsWith('Download') || selectedAction.startsWith('Delete')) {
      const status = state.fileActionStatus
      const lines = [
        `action: ${status.action || '-'}`,
        `state: ${status.state}`,
        `message: ${status.message || '-'}`
      ]
      if (status.path) lines.push(`path: ${status.path}`)
      lines.push(`selected file: ${file.fileName || '-'} (${file.sha256 || '-'})`)
      return lines
    }
    return [
      `group: ${file.groupId}`,
      `groupName: ${file.groupName || '-'}`,
      `name: ${file.fileName}`,
      `mime: ${file.mime || '-'}`,
      `size: ${file.size || 0}`,
      `uploadedAt: ${new Date(file.uploadedAt * 1000).toLocaleString()}`,
      `uploadedBy: ${file.uploadedBy}`,
      `sha256: ${file.sha256 || '-'}`,
      `url: ${file.url || '-'}`
    ]
  }

  return ['No details']
}

async function refreshNode(controller: AppController, node: NavNodeId, selectedRow: CenterRow | null): Promise<void> {
  switch (node) {
    case 'dashboard':
      await Promise.all([
        controller.refreshRelays(),
        controller.refreshGroups(),
        controller.refreshInvites(),
        controller.refreshGroupFiles(),
        controller.refreshChats()
      ])
      break
    case 'relays':
      await controller.refreshRelays()
      break
    case 'groups':
    case 'groups:browse':
      await controller.refreshGroups()
      break
    case 'groups:my': {
      await controller.refreshGroups()
      const group = selectedRow?.data as any
      if (group?.id) {
        await Promise.all([
          controller.refreshGroupNotes(group.id, group.relay || undefined),
          controller.refreshGroupFiles(group.id)
        ])
      }
      break
    }
    case 'chats':
      await controller.refreshChats()
      break
    case 'invites':
    case 'invites:group':
    case 'invites:chat':
      await Promise.all([controller.refreshInvites(), controller.refreshChats()])
      break
    case 'files':
      await controller.refreshGroupFiles()
      break
    default:
      if (isFileTypeNodeId(node)) {
        await controller.refreshGroupFiles()
      }
      break
  }
}

export function App({
  options,
  controllerFactory,
  scriptedCommands,
  autoExitOnScriptComplete = false
}: AppProps): React.JSX.Element {
  const { exit } = useApp()
  const [stdoutWidth, stdoutHeight] = useTerminalDimensions()
  const controllerRef = useRef<AppController | null>(null)
  const scriptStartedRef = useRef(false)
  const exitRef = useRef(exit)

  const [state, setState] = useState<ControllerState | null>(null)
  const [selectedNode, setSelectedNode] = useState<NavNodeId>('dashboard')
  const [focusPane, setFocusPane] = useState<FocusPane>('left-tree')
  const [treeExpanded, setTreeExpanded] = useState<TreeExpanded>(DEFAULT_TREE_EXPANDED)
  const [nodeViewport, setNodeViewport] = useState<ViewportMap>({})
  const [rightTopSelectionByNode, setRightTopSelectionByNode] = useState<IndexMap>({})
  const [rightBottomOffsetByNode, setRightBottomOffsetByNode] = useState<OffsetMap>({})
  const [paneActionMessage, setPaneActionMessage] = useState<string>('')
  const [commandInputOpen, setCommandInputOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [fieldInputOpen, setFieldInputOpen] = useState(false)
  const [fieldInputPrompt, setFieldInputPrompt] = useState('')
  const [fieldInputValue, setFieldInputValue] = useState('')
  const fieldInputContextRef = useRef<{
    node: NavNodeId
    field: string
  } | null>(null)
  const [groupCreateDraft, setGroupCreateDraft] = useState<GroupCreateDraft>({
    name: '',
    about: '',
    membership: 'open',
    visibility: 'public'
  })
  const [chatCreateDraft, setChatCreateDraft] = useState<ChatCreateDraft>({
    name: '',
    description: '',
    inviteMembers: [],
    relayUrls: []
  })
  const [inviteSendQuery, setInviteSendQuery] = useState('')
  const [inviteSendSuggestions, setInviteSendSuggestions] = useState<ProfileSuggestion[]>([])
  const [inviteSendSuggestionIndex, setInviteSendSuggestionIndex] = useState(0)
  const [inviteSendBusy, setInviteSendBusy] = useState(false)
  const [inviteSendStatus, setInviteSendStatus] = useState<string>('')
  const inviteSearchRequestRef = useRef(0)
  const [commandMessage, setCommandMessage] = useState('Type :help for commands')
  const [hydratedScopeKey, setHydratedScopeKey] = useState<string>('')
  const initialized = state?.initialized || false

  const stateRef = useRef<ControllerState | null>(null)
  const selectedNodeRef = useRef<NavNodeId>('dashboard')
  const focusPaneRef = useRef<FocusPane>('left-tree')
  const nodeViewportRef = useRef<ViewportMap>({})
  const rightTopSelectionRef = useRef<IndexMap>({})
  const rightBottomOffsetRef = useRef<OffsetMap>({})
  const myGroupPaneLoadKeyRef = useRef<string>('')

  useEffect(() => {
    exitRef.current = exit
  }, [exit])

  useEffect(() => {
    const controller = controllerFactory
      ? controllerFactory(options)
      : new TuiController(options)
    controllerRef.current = controller

    let disposed = false

    const unsubscribe = controller.subscribe((nextState) => {
      if (disposed) return
      setState(nextState)
    })

    ;(async () => {
      try {
        await controller.initialize()

        const snapshot = controller.getState()
        const scriptedMode = Boolean(scriptedCommands?.length)
        if (snapshot.currentAccountPubkey && !scriptedMode) {
          try {
            await controller.unlockCurrentAccount()
            await controller.startWorker()
            await refreshNode(controller, 'dashboard', null)
            setCommandMessage('Auto-unlocked current nsec account')
          } catch (error) {
            setCommandMessage(
              `Account selected, unlock required: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        } else if (snapshot.currentAccountPubkey && scriptedMode) {
          setCommandMessage('Script mode active: skipping automatic unlock/start bootstrap')
        }
      } catch (error) {
        setCommandMessage(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
      controller.shutdown().catch(() => {})
    }
  }, [options, controllerFactory, scriptedCommands])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    selectedNodeRef.current = selectedNode
  }, [selectedNode])

  useEffect(() => {
    focusPaneRef.current = focusPane
  }, [focusPane])

  useEffect(() => {
    nodeViewportRef.current = nodeViewport
  }, [nodeViewport])

  useEffect(() => {
    rightTopSelectionRef.current = rightTopSelectionByNode
  }, [rightTopSelectionByNode])

  useEffect(() => {
    rightBottomOffsetRef.current = rightBottomOffsetByNode
  }, [rightBottomOffsetByNode])

  useEffect(() => {
    if (!state) return
    const scopeKey = String(state.session?.userKey || state.currentAccountPubkey || '')
    if (!scopeKey) return
    if (scopeKey === hydratedScopeKey) return

    setHydratedScopeKey(scopeKey)
    setSelectedNode(state.selectedNode || 'dashboard')
    setFocusPane(state.focusPane || 'left-tree')
    setTreeExpanded({
      groups: state.treeExpanded?.groups ?? true,
      chats: state.treeExpanded?.chats ?? true,
      invites: state.treeExpanded?.invites ?? true,
      files: state.treeExpanded?.files ?? true
    })
    setNodeViewport(state.nodeViewport || {})
    setRightTopSelectionByNode(state.rightTopSelectionByNode || {})
    setRightBottomOffsetByNode(state.rightBottomOffsetByNode || {})
    setPaneActionMessage('')
    setGroupCreateDraft({
      name: '',
      about: '',
      membership: 'open',
      visibility: 'public'
    })
    setChatCreateDraft({
      name: '',
      description: '',
      inviteMembers: [],
      relayUrls: []
    })
    setInviteSendQuery('')
    setInviteSendSuggestions([])
    setInviteSendSuggestionIndex(0)
    setInviteSendBusy(false)
    setInviteSendStatus('')
    closeFieldInput()
  }, [state, hydratedScopeKey])

  const navRows = useMemo(() => {
    if (!state) return []
    return navRowsFromState(state, treeExpanded)
  }, [state, treeExpanded])

  const navIndexById = useMemo(() => {
    const map = new Map<NavNodeId, number>()
    navRows.forEach((row, index) => {
      map.set(row.id, index)
    })
    return map
  }, [navRows])

  useEffect(() => {
    if (navRows.length === 0) return
    if (navIndexById.has(selectedNode)) return
    const fallback = navRows[0]
    if (!fallback) return
    setSelectedNode(fallback.id)
    controllerRef.current?.setSelectedNode(fallback.id).catch(() => {})
  }, [navRows, navIndexById, selectedNode])

  const frameHeight = Math.max(14, stdoutHeight)
  const frameRows = frameSegments(frameHeight)
  const narrowLayout = stdoutWidth < 136

  const navPaneWidth = narrowLayout ? Math.max(22, stdoutWidth - 2) : clamp(Math.floor(stdoutWidth * 0.24), 28, 38)
  const rightPaneWidth = narrowLayout ? Math.max(22, stdoutWidth - 2) : clamp(Math.floor(stdoutWidth * 0.33), 40, 58)
  const centerPaneWidth = narrowLayout
    ? Math.max(24, stdoutWidth - 2)
    : Math.max(34, stdoutWidth - navPaneWidth - rightPaneWidth - 2)

  const centerVisibleRows = Math.max(1, frameRows.mainRows - 2)
  const rightVisibleRows = Math.max(1, frameRows.mainRows - 2)

  const centerRows = useMemo(() => {
    if (!state) return []
    const base = centerRowsForNode(state, selectedNode)
    if (selectedNode === 'groups:create') {
      return base.map((row) => {
        if (row.key === 'groups:create:name') {
          return {
            ...row,
            label: `group name: ${groupCreateDraft.name || '-'}`
          }
        }
        if (row.key === 'groups:create:about') {
          return {
            ...row,
            label: `group description: ${groupCreateDraft.about || '-'}`
          }
        }
        if (row.key === 'groups:create:membership') {
          return {
            ...row,
            label: `membership policy: ${groupCreateDraft.membership}`
          }
        }
        if (row.key === 'groups:create:membership:open') {
          return {
            ...row,
            label: `  ${groupCreateDraft.membership === 'open' ? '[x]' : '[ ]'} open`
          }
        }
        if (row.key === 'groups:create:membership:closed') {
          return {
            ...row,
            label: `  ${groupCreateDraft.membership === 'closed' ? '[x]' : '[ ]'} closed`
          }
        }
        if (row.key === 'groups:create:visibility') {
          return {
            ...row,
            label: `visibility: ${groupCreateDraft.visibility}`
          }
        }
        if (row.key === 'groups:create:visibility:public') {
          return {
            ...row,
            label: `  ${groupCreateDraft.visibility === 'public' ? '[x]' : '[ ]'} public`
          }
        }
        if (row.key === 'groups:create:visibility:private') {
          return {
            ...row,
            label: `  ${groupCreateDraft.visibility === 'private' ? '[x]' : '[ ]'} private`
          }
        }
        return row
      })
    }
    if (selectedNode === 'chats:create') {
      return base.map((row) => {
        if (row.key === 'chats:create:name') {
          return {
            ...row,
            label: `chat name: ${chatCreateDraft.name || '-'}`
          }
        }
        if (row.key === 'chats:create:about') {
          return {
            ...row,
            label: `chat description: ${chatCreateDraft.description || '-'}`
          }
        }
        if (row.key === 'chats:create:members') {
          return {
            ...row,
            label: `invite members: ${chatCreateDraft.inviteMembers.length ? chatCreateDraft.inviteMembers.join(',') : '-'}`
          }
        }
        if (row.key === 'chats:create:relays') {
          return {
            ...row,
            label: `chat relays: ${chatCreateDraft.relayUrls.length}`
          }
        }
        if (row.key.startsWith('chats:create:relay:')) {
          const relayUrl = String((row.data as { value?: string })?.value || '')
          const selected = chatCreateDraft.relayUrls.includes(relayUrl)
          const relayName = row.label.trim()
          return {
            ...row,
            label: `  ${selected ? '[x]' : '[ ]'} ${relayName.replace(/^\[.\]\s*/, '')}`
          }
        }
        return row
      })
    }
    return base
  }, [state, selectedNode, groupCreateDraft, chatCreateDraft])

  const selectedNodeViewport = useMemo(() => {
    const current = nodeViewport[selectedNode] || { cursor: 0, offset: 0 }
    return normalizeViewport(current.cursor, current.offset, centerRows.length, centerVisibleRows)
  }, [nodeViewport, selectedNode, centerRows.length, centerVisibleRows])

  useEffect(() => {
    const key = selectedNode
    const previous = nodeViewportRef.current[key]
    if (previous && previous.cursor === selectedNodeViewport.selectedIndex && previous.offset === selectedNodeViewport.offset) {
      return
    }
    const next = {
      ...nodeViewportRef.current,
      [key]: {
        cursor: selectedNodeViewport.selectedIndex,
        offset: selectedNodeViewport.offset
      }
    }
    setNodeViewport(next)
    controllerRef.current?.setPaneViewport(key, selectedNodeViewport.selectedIndex, selectedNodeViewport.offset).catch(() => {})
  }, [selectedNode, selectedNodeViewport])

  const selectedCenterRow = centerRows[selectedNodeViewport.selectedIndex] || null

  const splitMode = splitNode(selectedNode)
  const rightTopActionsRows = useMemo(() => {
    if (!state) return []
    if (selectedNode === 'groups:create') {
      return [
        `name: ${groupCreateDraft.name || '-'}`,
        `description: ${groupCreateDraft.about || '-'}`,
        `membership: ${groupCreateDraft.membership}`,
        `visibility: ${groupCreateDraft.visibility}`
      ]
    }
    if (selectedNode === 'chats:create') {
      return [
        `name: ${chatCreateDraft.name || '-'}`,
        `description: ${chatCreateDraft.description || '-'}`,
        `invite members: ${chatCreateDraft.inviteMembers.length}`,
        `chat relays: ${chatCreateDraft.relayUrls.length}`
      ]
    }
    return rightTopActions(state, selectedNode, selectedCenterRow)
  }, [state, selectedNode, selectedCenterRow, groupCreateDraft, chatCreateDraft])

  const rightTopIndex = useMemo(() => {
    const raw = rightTopSelectionByNode[selectedNode] || 0
    if (rightTopActionsRows.length === 0) return 0
    return clamp(raw, 0, rightTopActionsRows.length - 1)
  }, [rightTopSelectionByNode, selectedNode, rightTopActionsRows])

  useEffect(() => {
    if (rightTopActionsRows.length === 0) return
    const existing = rightTopSelectionRef.current[selectedNode]
    if (existing === rightTopIndex) return
    const next = {
      ...rightTopSelectionRef.current,
      [selectedNode]: rightTopIndex
    }
    setRightTopSelectionByNode(next)
    controllerRef.current?.setRightTopSelection(selectedNode, rightTopIndex).catch(() => {})
  }, [selectedNode, rightTopActionsRows.length, rightTopIndex])

  const selectedRightTopAction = rightTopActionsRows[rightTopIndex] || ''

  const inviteSendMode: InviteSendMode = useMemo(() => {
    if (selectedNode !== 'invites:send') return 'group'
    const mode = (selectedCenterRow?.data as { mode?: InviteSendMode } | null)?.mode
    return mode === 'chat' ? 'chat' : 'group'
  }, [selectedNode, selectedCenterRow])

  const inviteSendTargets = useMemo(() => {
    if (!state || selectedNode !== 'invites:send') return []
    const currentPubkey = String(state.session?.pubkey || '').trim().toLowerCase()
    if (!currentPubkey) return []
    if (inviteSendMode === 'group') {
      return state.myGroups
        .filter((group) => String(group.adminPubkey || '').trim().toLowerCase() === currentPubkey)
        .map((group) => ({
          kind: 'group' as const,
          id: group.id,
          relay: group.relay || null,
          name: group.name || group.id
        }))
    }
    return state.conversations
      .filter((conversation) => (conversation.adminPubkeys || []).map((value) => String(value || '').trim().toLowerCase()).includes(currentPubkey))
      .map((conversation) => ({
        kind: 'chat' as const,
        id: conversation.id,
        relay: null,
        name: conversation.title || conversation.id
      }))
  }, [state, selectedNode, inviteSendMode])

  const selectedInviteSendTarget = inviteSendTargets[rightTopIndex] || null

  useEffect(() => {
    if (!state || selectedNode !== 'groups:my') {
      myGroupPaneLoadKeyRef.current = ''
      return
    }
    if (!selectedCenterRow || selectedCenterRow.kind !== 'group') return
    const group = selectedCenterRow.data as any
    const controller = controllerRef.current
    if (!controller || !group?.id) return

    const actionName = selectedRightTopAction
    if (!actionName.startsWith('Notes') && !actionName.startsWith('Files') && !actionName.startsWith('Join Requests')) {
      return
    }
    const relay = String(group.relay || '').trim()
    const key = `${group.id}|${relay}|${actionName}`
    if (myGroupPaneLoadKeyRef.current === key) return
    myGroupPaneLoadKeyRef.current = key

    if (actionName.startsWith('Notes')) {
      controller.refreshGroupNotes(group.id, relay || undefined).catch(() => {})
    } else if (actionName.startsWith('Files')) {
      controller.refreshGroupFiles(group.id).catch(() => {})
    } else if (actionName.startsWith('Join Requests')) {
      controller.refreshJoinRequests(group.id, relay || undefined).catch(() => {})
    }
  }, [state, selectedNode, selectedCenterRow, selectedRightTopAction])

  useEffect(() => {
    if (selectedNode !== 'invites:send') {
      setInviteSendSuggestions([])
      setInviteSendSuggestionIndex(0)
      return
    }
    const query = String(inviteSendQuery || '').trim()
    if (!query) {
      setInviteSendSuggestions([])
      setInviteSendSuggestionIndex(0)
      return
    }
    const controller = controllerRef.current
    if (!controller) return
    const requestId = ++inviteSearchRequestRef.current
    let cancelled = false
    const timer = setTimeout(() => {
      controller.searchProfileSuggestions(query, 10)
        .then((results) => {
          if (cancelled) return
          if (requestId !== inviteSearchRequestRef.current) return
          setInviteSendSuggestions(results || [])
          setInviteSendSuggestionIndex(0)
        })
        .catch(() => {
          if (cancelled) return
          if (requestId !== inviteSearchRequestRef.current) return
          setInviteSendSuggestions([])
          setInviteSendSuggestionIndex(0)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selectedNode, inviteSendQuery])

  const splitBottomRawRows = useMemo(() => {
    if (!state) return ['No data']
    if (selectedNode === 'invites:send') {
      const lines = [
        `mode: ${inviteSendMode === 'group' ? 'Group Invite' : 'Chat Invite'}`,
        `target: ${selectedInviteSendTarget ? `${selectedInviteSendTarget.name} (${selectedInviteSendTarget.id})` : '-'}`,
        `input: ${inviteSendQuery || ''}`,
        inviteSendBusy ? 'sending: in progress' : `status: ${inviteSendStatus || 'idle'}`
      ]
      if (inviteSendQuery && inviteSendSuggestions.length === 0 && !inviteSendBusy) {
        lines.push('no suggestions')
      }
      inviteSendSuggestions.forEach((entry, idx) => {
        const marker = idx === inviteSendSuggestionIndex ? '>' : ' '
        const name = entry.name ? `${entry.name} ` : ''
        lines.push(`${marker} ${name}${shortId(entry.pubkey, 16)}${entry.nip05 ? ` · ${entry.nip05}` : ''}`)
      })
      return lines
    }
    return splitBottomRows(state, selectedNode, selectedCenterRow, selectedRightTopAction, paneActionMessage)
  }, [
    state,
    selectedNode,
    selectedCenterRow,
    selectedRightTopAction,
    paneActionMessage,
    inviteSendMode,
    selectedInviteSendTarget,
    inviteSendQuery,
    inviteSendSuggestions,
    inviteSendSuggestionIndex,
    inviteSendBusy,
    inviteSendStatus
  ])

  const singleRightRawRows = useMemo(() => {
    if (!state) return ['No data']
    return singleRightRows(state, selectedNode, selectedCenterRow)
  }, [state, selectedNode, selectedCenterRow])

  const rightBottomWrapWidth = Math.max(18, rightPaneWidth - 4)
  const wrappedRightRows = useMemo(() => {
    const rows = splitMode ? splitBottomRawRows : singleRightRawRows
    return rows.flatMap((row) => wrapText(row, rightBottomWrapWidth))
  }, [splitMode, splitBottomRawRows, singleRightRawRows, rightBottomWrapWidth])

  const rightBottomVisibleRows = splitMode
    ? Math.max(1, Math.floor(rightVisibleRows / 2) - 2)
    : Math.max(1, rightVisibleRows)

  const rightBottomOffset = useMemo(() => {
    const raw = rightBottomOffsetByNode[selectedNode] || 0
    const maxOffset = Math.max(0, wrappedRightRows.length - rightBottomVisibleRows)
    return clamp(raw, 0, maxOffset)
  }, [rightBottomOffsetByNode, selectedNode, wrappedRightRows.length, rightBottomVisibleRows])

  useEffect(() => {
    const existing = rightBottomOffsetRef.current[selectedNode]
    if (existing === rightBottomOffset) return
    const next = {
      ...rightBottomOffsetRef.current,
      [selectedNode]: rightBottomOffset
    }
    setRightBottomOffsetByNode(next)
    controllerRef.current?.setDetailPaneOffset(selectedNode, rightBottomOffset).catch(() => {})
  }, [selectedNode, rightBottomOffset])

  const visibleRightRows = wrappedRightRows.slice(rightBottomOffset, rightBottomOffset + rightBottomVisibleRows)

  const buildCurrentCommandContext = (): CommandContext => {
    const snapshot = stateRef.current
    if (!snapshot) {
      return {}
    }

    return {
      currentNode: selectedNodeRef.current,
      resolveSelectedGroup: () => {
        const row = centerRowsForNode(snapshot, selectedNodeRef.current)[nodeViewportRef.current[selectedNodeRef.current]?.cursor || 0]
        if (!row || row.kind !== 'group') return null
        const group = row.data as any
        return {
          id: group.id,
          relay: group.relay || null
        }
      },
      resolveSelectedInvite: () => {
        const row = centerRowsForNode(snapshot, selectedNodeRef.current)[nodeViewportRef.current[selectedNodeRef.current]?.cursor || 0]
        if (!row) return null
        if (row.kind === 'group-invite') {
          const invite = row.data as any
          return {
            kind: 'group',
            id: invite.id,
            groupId: invite.groupId,
            relay: invite.relay || null,
            token: invite.token || null
          }
        }
        if (row.kind === 'chat-invite') {
          const invite = row.data as any
          return {
            kind: 'chat',
            id: invite.id,
            conversationId: invite.conversationId || null
          }
        }
        return null
      },
      resolveSelectedRelay: () => {
        const row = centerRowsForNode(snapshot, selectedNodeRef.current)[nodeViewportRef.current[selectedNodeRef.current]?.cursor || 0]
        if (!row || row.kind !== 'relay') return null
        const relay = row.data as any
        return {
          relayKey: relay.relayKey,
          publicIdentifier: relay.publicIdentifier || null,
          connectionUrl: relay.connectionUrl || null
        }
      },
      resolveSelectedFile: () => {
        const row = centerRowsForNode(snapshot, selectedNodeRef.current)[nodeViewportRef.current[selectedNodeRef.current]?.cursor || 0]
        if (!row || row.kind !== 'file') return null
        const file = row.data as any
        return {
          eventId: file.eventId,
          groupId: file.groupId,
          fileName: file.fileName || null,
          relay: file.groupRelay || null,
          url: file.url || null,
          sha256: file.sha256 || null
        }
      },
      resolveSelectedConversation: () => {
        const row = centerRowsForNode(snapshot, selectedNodeRef.current)[nodeViewportRef.current[selectedNodeRef.current]?.cursor || 0]
        if (!row || row.kind !== 'chat-conversation') return null
        const conversation = row.data as any
        return {
          id: conversation.id
        }
      },
      resolveSelectedNote: () => {
        const node = selectedNodeRef.current
        if (node !== 'groups:my') return null
        const row = centerRowsForNode(snapshot, node)[nodeViewportRef.current[node]?.cursor || 0]
        if (!row || row.kind !== 'group') return null
        const group = row.data as any
        const notes = noteRowsForGroup(snapshot, group)
        const note = notes[0]
        if (!note) return null
        return {
          id: note.eventId,
          pubkey: note.authorPubkey,
          groupId: group.id
        }
      },
      copy: async (text: string) => {
        const result = await copyToClipboard(text)
        await controllerRef.current?.setLastCopied(text, result.method)
        return result
      },
      unsafeCopySecrets: process.env.HYPERTUNA_TUI_ALLOW_UNSAFE_COPY === '1'
    }
  }

  const prefillCommandInput = (): string => {
    const snippet = buildCommandSnippet(buildCurrentCommandContext())
    return snippet || ''
  }

  const closeFieldInput = (): void => {
    setFieldInputOpen(false)
    setFieldInputPrompt('')
    setFieldInputValue('')
    fieldInputContextRef.current = null
  }

  const openFieldInput = (
    node: NavNodeId,
    field: string,
    prompt: string,
    initialValue: string
  ): void => {
    fieldInputContextRef.current = { node, field }
    setFieldInputPrompt(prompt)
    setFieldInputValue(initialValue)
    setFieldInputOpen(true)
  }

  const applyFieldInputValue = (rawValue: string): void => {
    const context = fieldInputContextRef.current
    if (!context) return
    const value = String(rawValue || '')
    if (context.node === 'groups:create') {
      if (context.field === 'name') {
        setGroupCreateDraft((previous) => ({ ...previous, name: value.trim() }))
      } else if (context.field === 'about') {
        setGroupCreateDraft((previous) => ({ ...previous, about: value.trim() }))
      }
      return
    }
    if (context.node === 'chats:create') {
      if (context.field === 'name') {
        setChatCreateDraft((previous) => ({ ...previous, name: value.trim() }))
      } else if (context.field === 'description') {
        setChatCreateDraft((previous) => ({ ...previous, description: value.trim() }))
      } else if (context.field === 'members') {
        const members = value
          .split(/[,\s]+/g)
          .map((entry) => entry.trim())
          .filter(Boolean)
        setChatCreateDraft((previous) => ({ ...previous, inviteMembers: Array.from(new Set(members)) }))
      } else if (context.field === 'relays') {
        const relayUrls = value
          .split(/[,\s]+/g)
          .map((entry) => entry.trim())
          .filter(Boolean)
        setChatCreateDraft((previous) => ({ ...previous, relayUrls: Array.from(new Set(relayUrls)) }))
      }
    }
  }

  const submitFieldInput = (submittedValue: string): void => {
    applyFieldInputValue(submittedValue)
    closeFieldInput()
  }

  const toggleChatRelayDraft = (relayUrl: string): void => {
    const normalized = String(relayUrl || '').trim()
    if (!normalized) return
    setChatCreateDraft((previous) => {
      if (previous.relayUrls.includes(normalized)) {
        return {
          ...previous,
          relayUrls: previous.relayUrls.filter((entry) => entry !== normalized)
        }
      }
      return {
        ...previous,
        relayUrls: [...previous.relayUrls, normalized]
      }
    })
  }

  const runCreateGroup = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return
    const name = String(groupCreateDraft.name || '').trim()
    if (!name) {
      setPaneActionMessage('Group name is required')
      return
    }
    try {
      setPaneActionMessage('Creating group…')
      const result = await controller.createRelay({
        name,
        description: String(groupCreateDraft.about || '').trim() || undefined,
        isOpen: groupCreateDraft.membership === 'open',
        isPublic: groupCreateDraft.visibility === 'public',
        fileSharing: true
      })
      await Promise.all([
        controller.refreshGroups(),
        controller.refreshRelays()
      ])
      const createdId = String(result.publicIdentifier || result.relayKey || name)
      setPaneActionMessage(`Group created: ${createdId}`)
      setGroupCreateDraft({
        name: '',
        about: '',
        membership: 'open',
        visibility: 'public'
      })
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const runCreateChat = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return
    const title = String(chatCreateDraft.name || '').trim()
    if (!title) {
      setPaneActionMessage('Chat name is required')
      return
    }
    try {
      setPaneActionMessage('Creating chat…')
      await controller.createConversation({
        title,
        description: String(chatCreateDraft.description || '').trim() || undefined,
        members: Array.from(new Set(chatCreateDraft.inviteMembers.map((entry) => entry.trim()).filter(Boolean))),
        relayUrls: chatCreateDraft.relayUrls.length ? Array.from(new Set(chatCreateDraft.relayUrls)) : undefined,
        relayMode: 'withFallback'
      })
      setPaneActionMessage(`Chat created: ${title}`)
      setChatCreateDraft({
        name: '',
        description: '',
        inviteMembers: [],
        relayUrls: []
      })
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const handleFormCenterEnter = async (): Promise<void> => {
    if (!selectedCenterRow) return
    if (selectedNode === 'groups:create') {
      if (selectedCenterRow.key === 'groups:create:name') {
        openFieldInput('groups:create', 'name', 'Group name', groupCreateDraft.name)
        return
      }
      if (selectedCenterRow.key === 'groups:create:about') {
        openFieldInput('groups:create', 'about', 'Group description', groupCreateDraft.about)
        return
      }
      if (selectedCenterRow.key === 'groups:create:membership') {
        setGroupCreateDraft((previous) => ({
          ...previous,
          membership: previous.membership === 'open' ? 'closed' : 'open'
        }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:membership:open') {
        setGroupCreateDraft((previous) => ({ ...previous, membership: 'open' }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:membership:closed') {
        setGroupCreateDraft((previous) => ({ ...previous, membership: 'closed' }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:visibility') {
        setGroupCreateDraft((previous) => ({
          ...previous,
          visibility: previous.visibility === 'public' ? 'private' : 'public'
        }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:visibility:public') {
        setGroupCreateDraft((previous) => ({ ...previous, visibility: 'public' }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:visibility:private') {
        setGroupCreateDraft((previous) => ({ ...previous, visibility: 'private' }))
        return
      }
      if (selectedCenterRow.key === 'groups:create:submit') {
        await runCreateGroup()
      }
      return
    }

    if (selectedNode === 'chats:create') {
      if (selectedCenterRow.key === 'chats:create:name') {
        openFieldInput('chats:create', 'name', 'Chat name', chatCreateDraft.name)
        return
      }
      if (selectedCenterRow.key === 'chats:create:about') {
        openFieldInput('chats:create', 'description', 'Chat description', chatCreateDraft.description)
        return
      }
      if (selectedCenterRow.key === 'chats:create:members') {
        openFieldInput('chats:create', 'members', 'Invite members (csv)', chatCreateDraft.inviteMembers.join(','))
        return
      }
      if (selectedCenterRow.key === 'chats:create:relays') {
        openFieldInput('chats:create', 'relays', 'Relay URLs (csv)', chatCreateDraft.relayUrls.join(','))
        return
      }
      if (selectedCenterRow.key.startsWith('chats:create:relay:')) {
        const relayUrl = String((selectedCenterRow.data as { value?: string })?.value || '')
        toggleChatRelayDraft(relayUrl)
        return
      }
      if (selectedCenterRow.key === 'chats:create:submit') {
        await runCreateChat()
      }
      return
    }

    if (selectedNode === 'invites:send') {
      const mode = (selectedCenterRow.data as { mode?: InviteSendMode } | null)?.mode
      if (mode === 'chat' || mode === 'group') {
        setInviteSendQuery('')
        setInviteSendStatus('')
        setInviteSendSuggestionIndex(0)
      }
    }
  }

  const sendInviteFromRightBottom = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller || !state || selectedNode !== 'invites:send') return
    if (inviteSendBusy) return
    if (!selectedInviteSendTarget) {
      setInviteSendStatus('No admin-owned target selected')
      return
    }

    const suggestion = inviteSendSuggestions[inviteSendSuggestionIndex] || null
    const typed = String(inviteSendQuery || '').trim()
    const inviteePubkey = suggestion?.pubkey || (isHex64(typed) ? typed.toLowerCase() : null)
    if (!inviteePubkey) {
      setInviteSendStatus('Select a suggestion or enter a valid 64-char pubkey')
      return
    }

    try {
      setInviteSendBusy(true)
      setInviteSendStatus('Sending invite…')

      if (inviteSendMode === 'group') {
        const group = state.myGroups.find((entry) => entry.id === selectedInviteSendTarget.id)
        const relayUrl = String(group?.relay || selectedInviteSendTarget.relay || '').trim()
        if (!relayUrl) {
          throw new Error('Selected group has no relay URL')
        }
        await controller.sendInvite({
          groupId: selectedInviteSendTarget.id,
          relayUrl,
          inviteePubkey,
          payload: {
            groupName: group?.name || selectedInviteSendTarget.name || selectedInviteSendTarget.id,
            isPublic: group?.isPublic !== false,
            fileSharing: group?.isOpen !== false
          }
        })
      } else {
        const result = await controller.inviteChatMembers(selectedInviteSendTarget.id, [inviteePubkey])
        if (result.failed?.length) {
          throw new Error(result.failed[0]?.error || 'Invite failed')
        }
      }

      setInviteSendStatus(`Invite sent: ${shortId(inviteePubkey, 16)}`)
      setInviteSendQuery('')
      setInviteSendSuggestions([])
      setInviteSendSuggestionIndex(0)
    } catch (error) {
      setInviteSendStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setInviteSendBusy(false)
    }
  }

  const executeRightTopAction = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller || !state) return
    if (!splitMode || !selectedCenterRow || !selectedRightTopAction) return

    try {
      if (selectedNode === 'groups:browse' && selectedCenterRow.kind === 'group') {
        const group = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Join Group')) {
          setPaneActionMessage('Joining group…')
          await controller.startJoinFlow({
            publicIdentifier: group.id,
            relayUrl: group.relay || undefined,
            openJoin: group.isPublic !== false && group.isOpen !== false
          })
          await Promise.all([
            controller.refreshGroups(),
            controller.refreshRelays()
          ])
          setPaneActionMessage(`Joined group: ${group.name || group.id}`)
          return
        }
        if (selectedRightTopAction.startsWith('Request Invite')) {
          setPaneActionMessage('Requesting invite…')
          await controller.requestGroupInvite({
            groupId: group.id,
            relay: group.relay || null
          })
          setPaneActionMessage(`Invite request sent for ${group.name || group.id}`)
          return
        }
      }

      if (selectedNode === 'invites:group' && selectedCenterRow.kind === 'group-invite') {
        const invite = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Accept invite')) {
          setPaneActionMessage('Accepting invite…')
          await controller.acceptGroupInvite(invite.id)
          setPaneActionMessage('Invite accepted')
          await controller.refreshInvites()
          return
        }
        if (selectedRightTopAction.startsWith('Dismiss invite')) {
          setPaneActionMessage('Dismissing invite…')
          await controller.dismissGroupInvite(invite.id)
          setPaneActionMessage('Invite dismissed')
          await controller.refreshInvites()
          return
        }
      }

      if (selectedNode === 'invites:chat' && selectedCenterRow.kind === 'chat-invite') {
        const invite = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Accept invite')) {
          setPaneActionMessage('Accepting chat invite…')
          await controller.acceptChatInvite(invite.id)
          setPaneActionMessage('Chat invite accepted')
          await controller.refreshChats()
          return
        }
        if (selectedRightTopAction.startsWith('Dismiss invite')) {
          setPaneActionMessage('Dismissing chat invite…')
          await controller.dismissChatInvite(invite.id)
          setPaneActionMessage('Chat invite dismissed')
          await controller.refreshChats()
          return
        }
      }

      if ((selectedNode === 'files' || isFileTypeNodeId(selectedNode)) && selectedCenterRow.kind === 'file') {
        const file = selectedCenterRow.data as any
        if (!file?.sha256) {
          setPaneActionMessage('Selected file has no sha256 hash')
          return
        }

        if (selectedRightTopAction.startsWith('Download')) {
          setPaneActionMessage('Downloading file…')
          const result = await controller.downloadGroupFile({
            relayKey: file.groupRelay && /^[a-f0-9]{64}$/i.test(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
            publicIdentifier: file.groupId,
            groupId: file.groupId,
            eventId: file.eventId,
            fileHash: file.sha256,
            fileName: file.fileName || null
          })
          setPaneActionMessage(`Download complete: ${result.savedPath}`)
          return
        }

        if (selectedRightTopAction.startsWith('Delete')) {
          setPaneActionMessage('Deleting local file…')
          const result = await controller.deleteLocalGroupFile({
            relayKey: file.groupRelay && /^[a-f0-9]{64}$/i.test(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
            publicIdentifier: file.groupId,
            groupId: file.groupId,
            eventId: file.eventId,
            fileHash: file.sha256
          })
          setPaneActionMessage(result.deleted ? 'File deleted from local storage' : `Delete failed: ${result.reason || 'unknown'}`)
          return
        }
      }

      if (selectedNode === 'invites:send') {
        if (selectedInviteSendTarget) {
          setPaneActionMessage(`Target selected: ${selectedInviteSendTarget.name}`)
        } else {
          setPaneActionMessage('Select a target and enter an invitee in details pane')
        }
        return
      }

      setPaneActionMessage(`${selectedRightTopAction} selected`)
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!initialized) return
    if (!scriptedCommands?.length) return
    if (scriptStartedRef.current) return

    const controller = controllerRef.current
    if (!controller) return

    scriptStartedRef.current = true
    let cancelled = false

    ;(async () => {
      for (const step of scriptedCommands) {
        if (cancelled) return
        const idle = await waitForControllerIdle(controller, 45_000)
        if (!idle) {
          setCommandMessage('$ [warn] timed out waiting for idle state; continuing')
        }
        await sleep(step.delayMs ?? 450)
        if (cancelled) return

        const command =
          step.resolveCommand
            ? await step.resolveCommand(controller)
            : step.command || null

        if (!command) {
          setCommandMessage('$ [skip] scripted step')
          await sleep(step.pauseAfterMs ?? 600)
          continue
        }

        try {
          const result = await withStepTimeout(
            executeCommand(controller, command, buildCurrentCommandContext()),
            step.timeoutMs ?? 20_000,
            `Script step "${command}"`
          )
          if (cancelled) return
          setCommandMessage(`$ ${command} -> ${result.message}`)
          if (result.gotoNode) {
            setSelectedNode(result.gotoNode)
          }
        } catch (error) {
          if (cancelled) return
          setCommandMessage(`$ ${command} -> ERROR: ${error instanceof Error ? error.message : String(error)}`)
        }

        await sleep(step.pauseAfterMs ?? 600)
      }

      if (autoExitOnScriptComplete) {
        await controller.shutdown().catch(() => {})
        if (!cancelled) {
          exitRef.current()
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [initialized, scriptedCommands, autoExitOnScriptComplete])

  useInput((input, key) => {
    const controller = controllerRef.current
    const snapshot = stateRef.current
    if (!controller || !snapshot) return

    if (commandInputOpen) {
      if (key.escape) {
        setCommandInputOpen(false)
        setCommandInput('')
      }
      return
    }

    if (fieldInputOpen) {
      if (key.escape) {
        closeFieldInput()
        return
      }
      if (key.return) {
        submitFieldInput(fieldInputValue)
        return
      }
      if (key.backspace || key.delete) {
        setFieldInputValue((previous) => previous.slice(0, -1))
        return
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n\t]/g, '')
        if (sanitized) {
          setFieldInputValue((previous) => `${previous}${sanitized}`)
        }
      }
      return
    }

    if (key.ctrl && input === 'c') {
      controller.shutdown().finally(() => exit())
      return
    }

    if (input === 'q') {
      controller.shutdown().finally(() => exit())
      return
    }

    if (input === ':') {
      setCommandInputOpen(true)
      setCommandInput('')
      return
    }

    if (input === 'y') {
      executeCommand(controller, 'copy selected', buildCurrentCommandContext())
        .then((result) => setCommandMessage(result.message))
        .catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
      return
    }

    if (input === 'Y') {
      executeCommand(controller, 'copy command', buildCurrentCommandContext())
        .then((result) => setCommandMessage(result.message))
        .catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
      return
    }

    if (key.tab) {
      const order: FocusPane[] = ['left-tree', 'center', 'right-top', 'right-bottom']
      const current = focusPaneRef.current
      const index = order.indexOf(current)
      const delta = key.shift ? -1 : 1
      const next = order[(index + delta + order.length) % order.length]
      setFocusPane(next)
      controller.setFocusPane(next).catch(() => {})
      return
    }

    if (input === 'r') {
      refreshNode(controller, selectedNodeRef.current, selectedCenterRow)
        .then(() => setCommandMessage(`Refreshed ${selectedNodeRef.current}`))
        .catch((error) => setCommandMessage(error instanceof Error ? error.message : String(error)))
      return
    }

    const currentNode = selectedNodeRef.current
    const currentFocus = focusPaneRef.current

    if (currentFocus === 'left-tree') {
      const navIndex = navIndexById.get(currentNode) ?? 0
      if (key.upArrow) {
        const nextIndex = clamp(navIndex - 1, 0, Math.max(0, navRows.length - 1))
        const nextRow = navRows[nextIndex]
        if (!nextRow) return
        setSelectedNode(nextRow.id)
        controller.setSelectedNode(nextRow.id).catch(() => {})
        return
      }

      if (key.downArrow) {
        const nextIndex = clamp(navIndex + 1, 0, Math.max(0, navRows.length - 1))
        const nextRow = navRows[nextIndex]
        if (!nextRow) return
        setSelectedNode(nextRow.id)
        controller.setSelectedNode(nextRow.id).catch(() => {})
        return
      }

      if (key.rightArrow) {
        if (isParentNavId(currentNode)) {
          if (!treeExpanded[currentNode]) {
            const next = {
              ...treeExpanded,
              [currentNode]: true
            }
            setTreeExpanded(next)
            controller.setTreeExpanded(next).catch(() => {})
            return
          }

          const nextRow = navRows.find((row) => row.parent === currentNode)
          if (nextRow) {
            setSelectedNode(nextRow.id)
            controller.setSelectedNode(nextRow.id).catch(() => {})
          }
        }
        return
      }

      if (key.leftArrow) {
        const currentRow = navRows[navIndex]
        if (!currentRow) return
        if (currentRow.parent) {
          setSelectedNode(currentRow.parent)
          controller.setSelectedNode(currentRow.parent).catch(() => {})
          return
        }
        if (isParentNavId(currentNode) && treeExpanded[currentNode]) {
          const next = {
            ...treeExpanded,
            [currentNode]: false
          }
          setTreeExpanded(next)
          controller.setTreeExpanded(next).catch(() => {})
        }
        return
      }

      if (key.return) {
        if (isParentNavId(currentNode)) {
          const next = {
            ...treeExpanded,
            [currentNode]: !treeExpanded[currentNode]
          }
          setTreeExpanded(next)
          controller.setTreeExpanded(next).catch(() => {})
        } else {
          controller.setSelectedNode(currentNode).catch(() => {})
        }
        return
      }
      return
    }

    if (currentFocus === 'center') {
      const viewport = nodeViewportRef.current[currentNode] || { cursor: 0, offset: 0 }
      const normalized = normalizeViewport(viewport.cursor, viewport.offset, centerRows.length, centerVisibleRows)

      const moveCursor = (nextCursor: number) => {
        const nextViewport = normalizeViewport(nextCursor, normalized.offset, centerRows.length, centerVisibleRows)
        const merged = {
          ...nodeViewportRef.current,
          [currentNode]: {
            cursor: nextViewport.selectedIndex,
            offset: nextViewport.offset
          }
        }
        setNodeViewport(merged)
        controller.setPaneViewport(currentNode, nextViewport.selectedIndex, nextViewport.offset).catch(() => {})
      }

      if (key.upArrow) {
        moveCursor(normalized.selectedIndex - 1)
        return
      }

      if (key.downArrow) {
        moveCursor(normalized.selectedIndex + 1)
        return
      }

      if (key.pageUp) {
        moveCursor(normalized.selectedIndex - centerVisibleRows)
        return
      }

      if (key.pageDown) {
        moveCursor(normalized.selectedIndex + centerVisibleRows)
        return
      }

      const maybeHome = (key as unknown as { home?: boolean }).home
      const maybeEnd = (key as unknown as { end?: boolean }).end

      if (maybeHome || (key.ctrl && input === 'a') || input === 'g') {
        moveCursor(0)
        return
      }

      if (maybeEnd || (key.ctrl && input === 'e') || input === 'G') {
        moveCursor(Math.max(0, centerRows.length - 1))
        return
      }

      if (key.return) {
        if (isFormCenterNode(currentNode)) {
          handleFormCenterEnter().catch((error) => {
            setPaneActionMessage(error instanceof Error ? error.message : String(error))
          })
          return
        }
        setCommandInputOpen(true)
        setCommandInput(prefillCommandInput())
      }

      return
    }

    if (currentFocus === 'right-top') {
      if (!splitMode) return
      const max = rightTopActionsRows.length
      if (max <= 0) return

      const current = rightTopSelectionRef.current[currentNode] || 0
      if (key.upArrow) {
        const nextIndex = clamp(current - 1, 0, max - 1)
        const next = {
          ...rightTopSelectionRef.current,
          [currentNode]: nextIndex
        }
        setRightTopSelectionByNode(next)
        controller.setRightTopSelection(currentNode, nextIndex).catch(() => {})
        return
      }

      if (key.downArrow) {
        const nextIndex = clamp(current + 1, 0, max - 1)
        const next = {
          ...rightTopSelectionRef.current,
          [currentNode]: nextIndex
        }
        setRightTopSelectionByNode(next)
        controller.setRightTopSelection(currentNode, nextIndex).catch(() => {})
        return
      }

      if (key.return) {
        executeRightTopAction().catch((error) => {
          setPaneActionMessage(error instanceof Error ? error.message : String(error))
        })
      }
      return
    }

    if (currentFocus === 'right-bottom') {
      if (currentNode === 'invites:send') {
        if (key.return) {
          sendInviteFromRightBottom().catch((error) => {
            setInviteSendStatus(error instanceof Error ? error.message : String(error))
          })
          return
        }
        if (key.upArrow) {
          setInviteSendSuggestionIndex((previous) => clamp(previous - 1, 0, Math.max(0, inviteSendSuggestions.length - 1)))
          return
        }
        if (key.downArrow) {
          setInviteSendSuggestionIndex((previous) => clamp(previous + 1, 0, Math.max(0, inviteSendSuggestions.length - 1)))
          return
        }
        if (key.backspace || key.delete) {
          setInviteSendQuery((previous) => previous.slice(0, -1))
          return
        }
        if (key.escape) {
          setInviteSendQuery('')
          setInviteSendSuggestions([])
          setInviteSendSuggestionIndex(0)
          setInviteSendStatus('')
          return
        }
        if (!key.ctrl && !key.meta && input) {
          const sanitized = input.replace(/[\r\n\t]/g, '')
          if (sanitized) {
            setInviteSendQuery((previous) => `${previous}${sanitized}`)
          }
          return
        }
      }

      const rows = wrappedRightRows.length
      const visible = rightBottomVisibleRows
      const maxOffset = Math.max(0, rows - visible)
      const currentOffset = rightBottomOffsetRef.current[currentNode] || 0

      const moveOffset = (delta: number) => {
        const nextOffset = clamp(currentOffset + delta, 0, maxOffset)
        if (nextOffset === currentOffset) return
        const next = {
          ...rightBottomOffsetRef.current,
          [currentNode]: nextOffset
        }
        setRightBottomOffsetByNode(next)
        controller.setDetailPaneOffset(currentNode, nextOffset).catch(() => {})
      }

      if (key.upArrow) {
        moveOffset(-1)
        return
      }

      if (key.downArrow) {
        moveOffset(1)
        return
      }

      if ((key.ctrl && input === 'u') || input === '{') {
        moveOffset(-Math.max(1, Math.floor(visible / 2)))
        return
      }

      if ((key.ctrl && input === 'd') || input === '}') {
        moveOffset(Math.max(1, Math.floor(visible / 2)))
      }
    }
  })

  const runCommand = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return

    const value = commandInput.trim()
    if (!value) {
      setCommandInputOpen(false)
      return
    }

    setCommandInputOpen(false)
    setCommandInput('')

    try {
      const result = await executeCommand(controller, value, buildCurrentCommandContext())
      setCommandMessage(result.message)
      if (result.gotoNode) {
        setSelectedNode(result.gotoNode)
        controller.setSelectedNode(result.gotoNode).catch(() => {})
      }
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error))
    }
  }

  if (!state) {
    return (
      <Box flexDirection="column">
        <TruncText color="cyan">Booting Hypertuna TUI…</TruncText>
      </Box>
    )
  }

  const navIndex = navIndexById.get(selectedNode) ?? 0

  const navBoxRows = Math.max(6, narrowLayout ? 10 : frameRows.mainRows)
  const centerBoxRows = Math.max(6, narrowLayout ? Math.floor(frameRows.mainRows * 0.4) : frameRows.mainRows)
  const rightBoxRows = Math.max(6, narrowLayout ? frameRows.mainRows - navBoxRows - centerBoxRows : frameRows.mainRows)

  const keysLabel =
    'Keys: `:` command, center `Enter` prefill (non-form), form `Enter` edit/submit, `y` copy value, `Y` copy command, `Tab/Shift+Tab` pane focus, tree `←/→`, list `↑/↓`, right-bottom `Ctrl+U/Ctrl+D`, `r` refresh, `q` quit'

  const commandStatusLabel = state.lastError
    ? `Error: ${state.lastError}`
    : state.busyTask
      ? `Working: ${state.busyTask}`
      : `Ready · node:${selectedNode} · focus:${focusPane}`

  const splitTopRows = splitMode ? Math.max(3, Math.floor(rightVisibleRows / 2)) : 0
  const splitBottomRowsHeight = splitMode ? Math.max(3, rightVisibleRows - splitTopRows) : 0

  return (
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      {narrowLayout ? (
        <Box flexDirection="column" height={frameRows.mainRows}>
          <Box borderStyle="round" borderColor={focusPane === 'left-tree' ? 'green' : 'cyan'} paddingX={1} height={navBoxRows} overflow="hidden">
            <Box flexDirection="column">
              <TruncText color="cyan">Hypertuna TUI</TruncText>
              <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
              <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'} · worker: {state.lifecycle}</TruncText>
              <Box marginTop={1} flexDirection="column">
                {navRows.map((row, index) => {
                  const isSelected = row.id === selectedNode
                  const indent = row.depth > 0 ? '  ' : ''
                  const prefix = row.isParent
                    ? row.expanded ? '▾' : '▸'
                    : '•'
                  return (
                    <TruncText key={`${row.id}-${index}`} color={isSelected ? 'green' : undefined}>
                      {isSelected ? '>' : ' '} {indent}{prefix} {row.label}
                    </TruncText>
                  )
                })}
              </Box>
            </Box>
          </Box>

          <Box borderStyle="round" borderColor={focusPane === 'center' ? 'green' : 'blue'} paddingX={1} height={centerBoxRows} overflow="hidden">
            <Box flexDirection="column">
              <Text color="cyan">{selectedNode}</Text>
              {centerRows.length === 0 ? <Text dimColor>No items</Text> : null}
              {centerRows.slice(selectedNodeViewport.offset, selectedNodeViewport.offset + centerVisibleRows).map((row, idx) => {
                const absolute = selectedNodeViewport.offset + idx
                const selected = absolute === selectedNodeViewport.selectedIndex
                return (
                  <Text key={`${row.key}-${absolute}`} color={selected ? 'green' : undefined}>
                    {selected ? '>' : ' '} {row.label}
                  </Text>
                )
              })}
            </Box>
          </Box>

          {splitMode ? (
            <Box flexDirection="column" height={rightBoxRows}>
              <Box borderStyle="round" borderColor={focusPane === 'right-top' ? 'green' : 'magenta'} paddingX={1} height={splitTopRows + 2} overflow="hidden">
                <Box flexDirection="column">
                  <Text color="magenta">Actions</Text>
                  {rightTopActionsRows.map((action, idx) => {
                    const selected = idx === rightTopIndex
                    return (
                      <Text key={`${action}-${idx}`} color={selected ? 'green' : undefined}>
                        {selected ? '>' : ' '} {action}
                      </Text>
                    )
                  })}
                </Box>
              </Box>
              <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={splitBottomRowsHeight + 2} overflow="hidden">
                <Box flexDirection="column">
                  <Text color="magenta">Details</Text>
                  {visibleRightRows.map((line, idx) => (
                    <Text key={`${idx}-${line.slice(0, 22)}`}>{line}</Text>
                  ))}
                </Box>
              </Box>
            </Box>
          ) : (
            <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={rightBoxRows} overflow="hidden">
              <Box flexDirection="column">
                <Text color="magenta">Details</Text>
                {visibleRightRows.map((line, idx) => (
                  <Text key={`${idx}-${line.slice(0, 22)}`}>{line}</Text>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      ) : (
        <Box height={frameRows.mainRows}>
          <Box width={navPaneWidth} flexDirection="column" borderStyle="round" borderColor={focusPane === 'left-tree' ? 'green' : 'cyan'} paddingX={1} overflow="hidden">
            <TruncText color="cyan">Hypertuna TUI</TruncText>
            <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
            <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'} · worker: {state.lifecycle}</TruncText>
            <Box marginTop={1} flexDirection="column">
              {navRows.map((row, index) => {
                const isSelected = row.id === selectedNode
                const isCursor = index === navIndex
                const indent = row.depth > 0 ? '  ' : ''
                const prefix = row.isParent
                  ? row.expanded ? '▾' : '▸'
                  : '•'
                return (
                  <TruncText key={`${row.id}-${index}`} color={isSelected ? 'green' : isCursor ? 'yellow' : undefined}>
                    {isSelected ? '>' : ' '} {indent}{prefix} {row.label}
                  </TruncText>
                )
              })}
            </Box>
          </Box>

          <Box width={centerPaneWidth} borderStyle="round" borderColor={focusPane === 'center' ? 'green' : 'blue'} paddingX={1} overflow="hidden">
            <Box flexDirection="column">
              <Text color="cyan">{selectedNode}</Text>
              {centerRows.length === 0 ? <Text dimColor>No items</Text> : null}
              {centerRows.slice(selectedNodeViewport.offset, selectedNodeViewport.offset + centerVisibleRows).map((row, idx) => {
                const absolute = selectedNodeViewport.offset + idx
                const selected = absolute === selectedNodeViewport.selectedIndex
                return (
                  <Text key={`${row.key}-${absolute}`} color={selected ? 'green' : undefined}>
                    {selected ? '>' : ' '} {row.label}
                  </Text>
                )
              })}
            </Box>
          </Box>

          <Box width={rightPaneWidth} overflow="hidden" flexDirection="column">
            {splitMode ? (
              <>
                <Box borderStyle="round" borderColor={focusPane === 'right-top' ? 'green' : 'magenta'} paddingX={1} height={splitTopRows + 2} overflow="hidden">
                  <Box flexDirection="column">
                    <Text color="magenta">Actions</Text>
                    {rightTopActionsRows.map((action, idx) => {
                      const selected = idx === rightTopIndex
                      return (
                        <Text key={`${action}-${idx}`} color={selected ? 'green' : undefined}>
                          {selected ? '>' : ' '} {action}
                        </Text>
                      )
                    })}
                  </Box>
                </Box>
                <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={splitBottomRowsHeight + 2} overflow="hidden">
                  <Box flexDirection="column">
                    <Text color="magenta">Details</Text>
                    {visibleRightRows.map((line, idx) => (
                      <Text key={`${idx}-${line.slice(0, 22)}`}>{line}</Text>
                    ))}
                  </Box>
                </Box>
              </>
            ) : (
              <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={frameRows.mainRows} overflow="hidden">
                <Box flexDirection="column">
                  <Text color="magenta">Details</Text>
                  {visibleRightRows.map((line, idx) => (
                    <Text key={`${idx}-${line.slice(0, 22)}`}>{line}</Text>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )}

      <Box borderStyle="round" borderColor="gray" paddingX={1} height={frameRows.commandRows} overflow="hidden">
        {commandInputOpen ? (
          <Box>
            <TruncText color="yellow">:</TruncText>
            <TextInput
              value={commandInput}
              onChange={setCommandInput}
              onSubmit={runCommand}
              placeholder="command"
            />
          </Box>
        ) : fieldInputOpen ? (
          <Box>
            <TruncText color="yellow">{fieldInputPrompt || 'input'}:</TruncText>
            <TextInput
              value={fieldInputValue}
              onChange={() => {}}
              onSubmit={() => {}}
              placeholder="value"
            />
          </Box>
        ) : (
          <Box>
            <TruncText color="yellow">Command</TruncText>
            <TruncText>: {shortText(commandMessage, Math.max(30, stdoutWidth - 24))}</TruncText>
          </Box>
        )}
      </Box>

      <Box height={frameRows.keysRows} overflow="hidden">
        <TruncText dimColor>{shortText(keysLabel, Math.max(32, stdoutWidth - 2))}</TruncText>
      </Box>

      <Box height={frameRows.statusRows} overflow="hidden">
        {state.busyTask && !options.noAnimations ? <Spinner type="dots" /> : null}
        <TruncText color={state.lastError ? 'red' : state.busyTask ? 'cyan' : 'gray'}>
          {shortText(commandStatusLabel, Math.max(30, stdoutWidth - 2))}
        </TruncText>
      </Box>
    </Box>
  )
}
