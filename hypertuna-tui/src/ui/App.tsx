import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { TuiController, type ControllerState, type RuntimeOptions } from '../domain/controller.js'
import { copy as copyToClipboard } from '../runtime/clipboard.js'
import { SECTION_LABELS, SECTION_ORDER, type SectionId } from '../lib/constants.js'
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
}

export type ScriptedCommand = {
  command?: string
  resolveCommand?: (controller: AppController) => string | null | Promise<string | null>
  delayMs?: number
  pauseAfterMs?: number
  timeoutMs?: number
}

type SelectionState = Record<SectionId, number>
type OffsetState = Record<SectionId, number>

const initialSelection: SelectionState = {
  dashboard: 0,
  relays: 0,
  feed: 0,
  groups: 0,
  invites: 0,
  files: 0,
  lists: 0,
  bookmarks: 0,
  chats: 0,
  search: 0,
  accounts: 0,
  logs: 0
}

const initialOffsets: OffsetState = {
  dashboard: 0,
  relays: 0,
  feed: 0,
  groups: 0,
  invites: 0,
  files: 0,
  lists: 0,
  bookmarks: 0,
  chats: 0,
  search: 0,
  accounts: 0,
  logs: 0
}

function nextSection(current: SectionId, delta: 1 | -1): SectionId {
  const index = SECTION_ORDER.indexOf(current)
  const next = (index + delta + SECTION_ORDER.length) % SECTION_ORDER.length
  return SECTION_ORDER[next]
}

function sectionLength(state: ControllerState, section: SectionId): number {
  switch (section) {
    case 'dashboard':
      return 1
    case 'relays':
      return state.relays.length
    case 'feed':
      return state.feed.length
    case 'groups':
      if (state.groupViewTab === 'my') return state.myGroups.length
      if (state.groupViewTab === 'invites') return state.groupInvites.length
      return state.groupDiscover.length
    case 'invites':
      return state.invitesInbox.length
    case 'files':
      return state.files.length
    case 'lists':
      return state.lists.length
    case 'bookmarks':
      return state.bookmarks.eventIds.length
    case 'chats':
      if (state.chatViewTab === 'invites') return state.chatInvites.length
      return state.conversations.length
    case 'search':
      return state.searchResults.length
    case 'accounts':
      return state.accounts.length
    case 'logs':
      return state.logs.length
  }
}

function safeSelection(index: number, length: number): number {
  if (length <= 0) return 0
  if (index < 0) return 0
  if (index >= length) return length - 1
  return index
}

function normalizeViewport(
  selectedIndex: number,
  offset: number,
  totalRows: number,
  visibleRows: number
): { selectedIndex: number; offset: number } {
  const rows = Math.max(1, visibleRows)
  const total = Math.max(0, totalRows)
  const selected = safeSelection(selectedIndex, total)
  if (total <= rows) {
    return {
      selectedIndex: selected,
      offset: 0
    }
  }

  const maxOffset = Math.max(0, total - rows)
  let nextOffset = Math.max(0, Math.min(offset, maxOffset))
  if (selected < nextOffset) {
    nextOffset = selected
  } else if (selected >= nextOffset + rows) {
    nextOffset = selected - rows + 1
  }

  nextOffset = Math.max(0, Math.min(nextOffset, maxOffset))
  return {
    selectedIndex: selected,
    offset: nextOffset
  }
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

function relaysReadyCount(state: ControllerState): number {
  return state.relays.filter((relay) => relay.readyForReq).length
}

function resolveSelectedGroupForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
): { id: string; relay?: string | null } | null {
  if (section !== 'groups') return null
  const rows = state.groupViewTab === 'my' ? state.myGroups : state.groupDiscover
  if (state.groupViewTab === 'invites') return null
  if (selectedIndex < 0 || selectedIndex >= rows.length) return null
  const group = rows[selectedIndex]
  if (!group) return null
  return {
    id: group.id,
    relay: group.relay || null
  }
}

function resolveSelectedInviteForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
):
  | { kind: 'group'; id: string; groupId: string; relay?: string | null; token?: string | null }
  | { kind: 'chat'; id: string; conversationId?: string | null }
  | null {
  if (section === 'groups') {
    if (state.groupViewTab !== 'invites') return null
    const invite = state.groupInvites[selectedIndex]
    if (!invite) return null
    return {
      kind: 'group',
      id: invite.id,
      groupId: invite.groupId,
      relay: invite.relay || null,
      token: invite.token || null
    }
  }

  if (section === 'chats') {
    if (state.chatViewTab !== 'invites') return null
    const invite = state.chatInvites[selectedIndex]
    if (!invite) return null
    return {
      kind: 'chat',
      id: invite.id,
      conversationId: invite.conversationId || null
    }
  }

  if (section === 'invites') {
    const invite = state.invitesInbox[selectedIndex]
    if (!invite) return null
    if (invite.type === 'group') {
      return {
        kind: 'group',
        id: invite.id,
        groupId: invite.groupId,
        relay: invite.relay || null,
        token: invite.token || null
      }
    }
    return {
      kind: 'chat',
      id: invite.id,
      conversationId: invite.conversationId || null
    }
  }

  return null
}

function resolveSelectedRelayForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
): { relayKey: string; publicIdentifier?: string | null; connectionUrl?: string | null } | null {
  if (section !== 'relays') return null
  const relay = state.relays[selectedIndex]
  if (!relay) return null
  return {
    relayKey: relay.relayKey,
    publicIdentifier: relay.publicIdentifier || null,
    connectionUrl: relay.connectionUrl || null
  }
}

function resolveSelectedFileForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
): { eventId: string; groupId: string; url?: string | null; sha256?: string | null } | null {
  if (section !== 'files') return null
  const file = state.files[selectedIndex]
  if (!file) return null
  return {
    eventId: file.eventId,
    groupId: file.groupId,
    url: file.url || null,
    sha256: file.sha256 || null
  }
}

function resolveSelectedConversationForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
): { id: string } | null {
  if (section !== 'chats') return null
  if (state.chatViewTab !== 'conversations') return null
  if (selectedIndex < 0 || selectedIndex >= state.conversations.length) return null
  const conversation = state.conversations[selectedIndex]
  if (!conversation) return null
  return {
    id: conversation.id
  }
}

function resolveSelectedFeedEventForContext(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number
): { id: string; pubkey: string } | null {
  if (section !== 'feed') return null
  const event = state.feed[selectedIndex]
  if (!event) return null
  return {
    id: event.id,
    pubkey: event.pubkey
  }
}

function renderCenterPane(
  state: ControllerState,
  section: SectionId,
  selectedIndex: number,
  offset: number,
  visibleRows: number
): React.ReactNode {
  if (section === 'dashboard') {
    const lines = [
      `Worker: ${state.lifecycle}`,
      `Relays: ${state.relays.length} (${relaysReadyCount(state)} writable)`,
      `Feed events: ${state.feed.length}`,
      `Groups: ${state.groupDiscover.length}`,
      `My groups: ${state.myGroups.length}`,
      `Invites: ${state.invitesCount}`,
      `Files: ${state.filesCount}`,
      `Starter packs: ${state.lists.length}`,
      `Bookmarks: ${state.bookmarks.eventIds.length}`,
      `Chats: ${state.conversations.length} / invites ${state.chatPendingInviteCount}`,
      `Search results: ${state.searchResults.length}`
    ].slice(0, Math.max(1, visibleRows - 1))

    return (
      <Box flexDirection="column">
        <Text color="cyan">Runtime Summary</Text>
        {lines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
    )
  }

  if (section === 'relays') {
    const rows = state.relays.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Connected Relays</Text>
        {state.relays.length === 0 ? <Text dimColor>No relays</Text> : null}
        {rows.map((relay, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          const label = relay.publicIdentifier || relay.relayKey
          const status = relay.readyForReq ? 'ready' : relay.writable ? 'writable' : 'readonly'
          return (
            <Text key={`${relay.relayKey}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortId(label, 7)} · {status}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'feed') {
    const rows = state.feed.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Feed</Text>
        {state.feed.length === 0 ? <Text dimColor>No feed events</Text> : null}
        {rows.map((event, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          const content = shortText(event.content || '', 68)
          return (
            <Text key={event.id} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortId(event.id, 6)} · {shortId(event.pubkey, 6)} · {content}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'groups') {
    const rows = state.groupViewTab === 'my'
      ? state.myGroups
      : state.groupViewTab === 'invites'
        ? state.groupInvites
        : state.groupDiscover
    const visible = rows.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          Groups [{state.groupViewTab}] d:{state.groupDiscover.length} m:{state.myGroups.length} i:{state.groupInvites.length}
        </Text>
        {rows.length === 0 ? <Text dimColor>No groups in this tab</Text> : null}
        {visible.map((row, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          if (state.groupViewTab === 'invites') {
            const invite = row as unknown as typeof state.groupInvites[number]
            const mode = invite.fileSharing === false ? 'closed' : 'open'
            return (
              <Text key={`${invite.id}-${idx}`} color={selected ? 'green' : undefined}>
                {selected ? '>' : ' '} invite · {shortText(invite.groupName || invite.groupId, 24)} · {mode}
              </Text>
            )
          }

          const group = row as unknown as typeof state.groupDiscover[number]
          const mode = `${group.isPublic === false ? 'private' : 'public'} / ${group.isOpen ? 'open' : 'closed'}`
          return (
            <Text key={`${group.id}-${group.event?.id || idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortText(group.name, 26)} · {mode}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'files') {
    const rows = state.files.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Group Files</Text>
        {state.files.length === 0 ? <Text dimColor>No file metadata events</Text> : null}
        {rows.map((file, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          return (
            <Text key={`${file.eventId}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortText(file.fileName, 32)} · {shortId(file.groupId, 8)}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'invites') {
    const rows = state.invitesInbox.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Invites Inbox ({state.invitesInbox.length})</Text>
        {state.invitesInbox.length === 0 ? <Text dimColor>No actionable invites</Text> : null}
        {rows.map((invite, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          if (invite.type === 'group') {
            return (
              <Text key={`${invite.type}-${invite.id}`} color={selected ? 'green' : undefined}>
                {selected ? '>' : ' '} group · {shortText(invite.title, 24)} · {shortId(invite.groupId, 8)}
              </Text>
            )
          }
          return (
            <Text key={`${invite.type}-${invite.id}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} chat · {shortText(invite.title, 24)} · {invite.status}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'lists') {
    const rows = state.lists.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Starter Packs</Text>
        {state.lists.length === 0 ? <Text dimColor>No starter packs</Text> : null}
        {rows.map((list, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          return (
            <Text key={`${list.event.id}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortText(list.title, 28)} · {list.pubkeys.length} accounts
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'bookmarks') {
    const rows = state.bookmarks.eventIds.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Bookmarks</Text>
        {state.bookmarks.eventIds.length === 0 ? <Text dimColor>No bookmarks</Text> : null}
        {rows.map((eventId, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          return (
            <Text key={`${eventId}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortId(eventId, 10)}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'chats') {
    const rows = state.chatViewTab === 'invites' ? state.chatInvites : state.conversations
    const visible = rows.slice(offset, offset + visibleRows)
    const retrySeconds = state.chatNextRetryAt
      ? Math.max(0, Math.ceil((state.chatNextRetryAt - Date.now()) / 1000))
      : null
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          Chats [{state.chatViewTab}] unread:{state.chatUnreadTotal} pending:{state.chatPendingInviteCount}
        </Text>
        <Text dimColor>
          init:{state.chatRuntimeState}
          {retrySeconds !== null ? ` retry:${retrySeconds}s` : ''}
          {state.chatWarning ? ' · degraded' : ''}
        </Text>
        {rows.length === 0 ? <Text dimColor>No chats in this tab</Text> : null}
        {visible.map((row, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          if (state.chatViewTab === 'invites') {
            const invite = row as unknown as typeof state.chatInvites[number]
            return (
              <Text key={`${invite.id}-${idx}`} color={selected ? 'green' : undefined}>
                {selected ? '>' : ' '} invite · {shortText(invite.title || invite.id, 24)} · {invite.status}
              </Text>
            )
          }
          const conversation = row as unknown as typeof state.conversations[number]
          return (
            <Text key={`${conversation.id}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {shortText(conversation.title, 24)} · {conversation.unreadCount} unread
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'search') {
    const rows = state.searchResults.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Search Results ({state.searchMode})</Text>
        {state.searchQuery ? <Text dimColor>query: {state.searchQuery}</Text> : <Text dimColor>No query</Text>}
        {state.searchResults.length === 0 ? <Text dimColor>No results</Text> : null}
        {rows.map((result, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          return (
            <Text key={`${result.event.id}-${idx}`} color={selected ? 'green' : undefined}>
              {selected ? '>' : ' '} {result.mode} · {shortId(result.event.id, 6)} · {shortText(result.event.content, 40)}
            </Text>
          )
        })}
      </Box>
    )
  }

  if (section === 'accounts') {
    const rows = state.accounts.slice(offset, offset + visibleRows)
    return (
      <Box flexDirection="column">
        <Text color="cyan">Accounts</Text>
        {state.accounts.length === 0 ? <Text dimColor>No accounts configured</Text> : null}
        {rows.map((account, localIdx) => {
          const idx = offset + localIdx
          const selected = idx === selectedIndex
          const isCurrent = state.currentAccountPubkey === account.pubkey
          return (
            <Text key={`${account.pubkey}-${idx}`} color={selected ? 'green' : isCurrent ? 'yellow' : undefined}>
              {selected ? '>' : ' '} {isCurrent ? '*' : ' '} {shortId(account.pubkey, 8)} · {account.signerType}
            </Text>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan">Logs</Text>
      {state.logs.slice(offset, offset + visibleRows).map((entry, localIdx) => {
        const idx = offset + localIdx
        const selected = idx === selectedIndex
        const color = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : entry.level === 'debug' ? 'gray' : undefined
        return (
          <Text key={`${entry.ts}-${idx}`} color={selected ? 'green' : color}>
            {selected ? '>' : ' '} {new Date(entry.ts).toLocaleTimeString()} [{entry.level}] {shortText(entry.message, 86)}
          </Text>
        )
      })}
    </Box>
  )
}

function renderDetailPane(state: ControllerState, section: SectionId, selectedIndex: number): React.ReactNode {
  if (section === 'dashboard') {
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Details</TruncText>
        <TruncText>Current account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 10) : 'none'}</TruncText>
        <TruncText>Session: {state.session ? shortId(state.session.pubkey, 10) : 'locked'}</TruncText>
        <TruncText>Worker: {state.lifecycle}</TruncText>
        <TruncText>Status: {shortText(state.readinessMessage, 40)}</TruncText>
        <TruncText>Stdout lines: {state.workerStdout.length}</TruncText>
        <TruncText>Stderr lines: {state.workerStderr.length}</TruncText>
        <TruncText>Recovery: {state.workerRecoveryState.status} (attempt {state.workerRecoveryState.attempt})</TruncText>
        <TruncText>Perf: avg {state.perfMetrics.avgLatencyMs.toFixed(1)}ms / p95 {state.perfMetrics.p95LatencyMs.toFixed(1)}ms</TruncText>
        <TruncText>Clipboard: {state.lastCopiedMethod || 'none'}</TruncText>
        <TruncText>Last copied: {state.lastCopiedValue ? shortText(state.lastCopiedValue, 36) : '-'}</TruncText>
      </Box>
    )
  }

  if (section === 'relays') {
    const relay = state.relays[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Relay Detail</TruncText>
        {!relay ? <TruncText dimColor>No relay selected</TruncText> : null}
        {relay ? (
          <>
            <TruncText>relayKey: {shortId(relay.relayKey, 14)}</TruncText>
            <TruncText>identifier: {relay.publicIdentifier || '-'}</TruncText>
            <TruncText>writable: {String(Boolean(relay.writable))}</TruncText>
            <TruncText>requiresAuth: {String(Boolean(relay.requiresAuth))}</TruncText>
            <TruncText>readyForReq: {String(Boolean(relay.readyForReq))}</TruncText>
            <TruncText>members: {relay.members?.length || 0}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Commands: relay refresh | relay create | relay join | relay disconnect | relay leave</TruncText>
      </Box>
    )
  }

  if (section === 'feed') {
    const event = state.feed[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Event Detail</TruncText>
        {!event ? <TruncText dimColor>No event selected</TruncText> : null}
        {event ? (
          <>
            <TruncText>id: {shortId(event.id, 14)}</TruncText>
            <TruncText>pubkey: {shortId(event.pubkey, 14)}</TruncText>
            <TruncText>kind: {event.kind}</TruncText>
            <TruncText>created: {new Date(event.created_at * 1000).toLocaleString()}</TruncText>
            <TruncText>tags: {event.tags.length}</TruncText>
            <TruncText>{shortText(event.content, 180)}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Commands: post | reply | react | bookmark add/remove</TruncText>
      </Box>
    )
  }

  if (section === 'groups') {
    const rows = state.groupViewTab === 'my'
      ? state.myGroups
      : state.groupViewTab === 'invites'
        ? state.groupInvites
        : state.groupDiscover
    const group = state.groupViewTab !== 'invites'
      ? rows[selectedIndex] as typeof state.groupDiscover[number] | undefined
      : undefined
    const invite = state.groupViewTab === 'invites'
      ? rows[selectedIndex] as typeof state.groupInvites[number] | undefined
      : undefined
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Group Detail</TruncText>
        {!group && !invite ? <TruncText dimColor>No group selected</TruncText> : null}
        {group ? (
          <>
            <TruncText>id: {group.id}</TruncText>
            <TruncText>name: {group.name}</TruncText>
            <TruncText>visibility: {group.isPublic === false ? 'private' : 'public'}</TruncText>
            <TruncText>join: {group.isOpen ? 'open' : 'closed'}</TruncText>
            <TruncText>relay: {group.relay || '-'}</TruncText>
            <TruncText>{shortText(group.about, 140)}</TruncText>
          </>
        ) : null}
        {invite ? (
          <>
            <TruncText>inviteId: {invite.id}</TruncText>
            <TruncText>groupId: {invite.groupId}</TruncText>
            <TruncText>group: {invite.groupName || invite.groupId}</TruncText>
            <TruncText>relay: {invite.relay || '-'}</TruncText>
            <TruncText>mode: {invite.fileSharing === false ? 'closed' : 'open'}</TruncText>
          </>
        ) : null}
        <TruncText>pending invites: {state.groupInvites.length}</TruncText>
        <TruncText>join requests: {Object.values(state.groupJoinRequests).reduce((total, rows) => total + rows.length, 0)}</TruncText>
        <TruncText dimColor>Tabs: group tab discover|my|invites</TruncText>
        <TruncText dimColor>Quick Actions (Groups): join-flow | invite | update-members | update-auth</TruncText>
        <TruncText dimColor>Quick Actions (Invites): invite-accept | invite-dismiss | copy group-id</TruncText>
        <TruncText dimColor>Commands: group refresh | group tab | group invites | group join-flow | group invite | group join-requests | group approve | group reject | group invite-accept | group invite-dismiss | group update-members | group update-auth</TruncText>
      </Box>
    )
  }

  if (section === 'invites') {
    const invite = state.invitesInbox[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Invite Detail</TruncText>
        {!invite ? <TruncText dimColor>No invite selected</TruncText> : null}
        {invite?.type === 'group' ? (
          <>
            <TruncText>type: group</TruncText>
            <TruncText>id: {invite.id}</TruncText>
            <TruncText>groupId: {invite.groupId}</TruncText>
            <TruncText>title: {shortText(invite.title, 42)}</TruncText>
            <TruncText>relay: {invite.relay || '-'}</TruncText>
          </>
        ) : null}
        {invite?.type === 'chat' ? (
          <>
            <TruncText>type: chat</TruncText>
            <TruncText>id: {invite.id}</TruncText>
            <TruncText>title: {shortText(invite.title, 42)}</TruncText>
            <TruncText>status: {invite.status}</TruncText>
            <TruncText>conversationId: {invite.conversationId || '-'}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Commands: invites refresh | invites accept group|chat [id] | invites dismiss group|chat [id]</TruncText>
      </Box>
    )
  }

  if (section === 'files') {
    const file = state.files[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">File Detail</TruncText>
        {!file ? <TruncText dimColor>No file selected</TruncText> : null}
        {file ? (
          <>
            <TruncText>group: {file.groupId}</TruncText>
            <TruncText>name: {file.fileName}</TruncText>
            <TruncText>mime: {file.mime || '-'}</TruncText>
            <TruncText>size: {file.size || 0}</TruncText>
            <TruncText>uploader: {shortId(file.uploadedBy, 8)}</TruncText>
            <TruncText>url: {shortText(file.url, 120)}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Quick Actions: copy group-id | copy sha256 | copy url</TruncText>
        <TruncText dimColor>Commands: file refresh | file upload</TruncText>
      </Box>
    )
  }

  if (section === 'lists') {
    const list = state.lists[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Starter Pack Detail</TruncText>
        {!list ? <TruncText dimColor>No list selected</TruncText> : null}
        {list ? (
          <>
            <TruncText>dTag: {list.id}</TruncText>
            <TruncText>title: {list.title}</TruncText>
            <TruncText>pubkeys: {list.pubkeys.length}</TruncText>
            <TruncText>author: {shortId(list.event.pubkey, 10)}</TruncText>
            <TruncText>{shortText(list.description, 140)}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Commands: list refresh | list create | list apply</TruncText>
      </Box>
    )
  }

  if (section === 'bookmarks') {
    const eventId = state.bookmarks.eventIds[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Bookmark Detail</TruncText>
        {!eventId ? <TruncText dimColor>No bookmark selected</TruncText> : <TruncText>eventId: {eventId}</TruncText>}
        <TruncText dimColor>Commands: bookmark refresh | bookmark add | bookmark remove</TruncText>
      </Box>
    )
  }

  if (section === 'chats') {
    const conversation = state.chatViewTab === 'conversations' ? state.conversations[selectedIndex] : null
    const invite = state.chatViewTab === 'invites' ? state.chatInvites[selectedIndex] : null
    const retrySeconds = state.chatNextRetryAt
      ? Math.max(0, Math.ceil((state.chatNextRetryAt - Date.now()) / 1000))
      : null
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Conversation Detail</TruncText>
        {!conversation && !invite ? <TruncText dimColor>No conversation selected</TruncText> : null}
        {conversation ? (
          <>
            <TruncText>id: {shortId(conversation.id, 10)}</TruncText>
            <TruncText>title: {conversation.title}</TruncText>
            <TruncText>participants: {conversation.participants.length}</TruncText>
            <TruncText>admins: {conversation.adminPubkeys.length}</TruncText>
            <TruncText>unread: {conversation.unreadCount}</TruncText>
            <TruncText>{shortText(conversation.lastMessagePreview, 140)}</TruncText>
          </>
        ) : null}
        {invite ? (
          <>
            <TruncText>inviteId: {shortId(invite.id, 10)}</TruncText>
            <TruncText>title: {invite.title || '-'}</TruncText>
            <TruncText>sender: {shortId(invite.senderPubkey, 10)}</TruncText>
            <TruncText>status: {invite.status}</TruncText>
            <TruncText>conversationId: {invite.conversationId || '-'}</TruncText>
          </>
        ) : null}
        <TruncText>
          chat runtime: {state.chatRuntimeState}
          {retrySeconds !== null ? ` (retry ${retrySeconds}s)` : ''}
        </TruncText>
        {state.chatWarning ? <TruncText color="yellow">{shortText(state.chatWarning, 120)}</TruncText> : null}
        <TruncText>pending chat invites: {state.chatPendingInviteCount}</TruncText>
        <TruncText>unread total: {state.chatUnreadTotal}</TruncText>
        <TruncText dimColor>Tabs: chat tab conversations|invites</TruncText>
        <TruncText dimColor>Quick Actions (Chats): open thread | send message | copy conversation-id</TruncText>
        <TruncText dimColor>Quick Actions (Invites): accept | dismiss | copy invite-id</TruncText>
        <TruncText dimColor>Commands: chat init | chat refresh | chat create | chat accept | chat dismiss | chat thread | chat send</TruncText>
      </Box>
    )
  }

  if (section === 'search') {
    const result = state.searchResults[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Search Detail</TruncText>
        {!result ? <TruncText dimColor>No result selected</TruncText> : null}
        {result ? (
          <>
            <TruncText>mode: {result.mode}</TruncText>
            <TruncText>event id: {shortId(result.event.id, 12)}</TruncText>
            <TruncText>author: {shortId(result.event.pubkey, 12)}</TruncText>
            <TruncText>{shortText(result.event.content, 180)}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>Command: search &lt;notes|profiles|groups|lists&gt; &lt;query&gt;</TruncText>
      </Box>
    )
  }

  if (section === 'accounts') {
    const account = state.accounts[selectedIndex]
    return (
      <Box flexDirection="column">
        <TruncText color="magenta">Account Detail</TruncText>
        {!account ? <TruncText dimColor>No account selected</TruncText> : null}
        {account ? (
          <>
            <TruncText>pubkey: {account.pubkey}</TruncText>
            <TruncText>signer: {account.signerType}</TruncText>
            <TruncText>label: {account.label || '-'}</TruncText>
            <TruncText>created: {new Date(account.createdAt).toLocaleString()}</TruncText>
            <TruncText>updated: {new Date(account.updatedAt).toLocaleString()}</TruncText>
          </>
        ) : null}
        <TruncText dimColor>
          Commands: account generate | profiles | login | add-nsec | add-ncryptsec | select | unlock | remove | clear
        </TruncText>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <TruncText color="magenta">Logs</TruncText>
      <TruncText>stdout: {state.workerStdout.length}</TruncText>
      <TruncText>stderr: {state.workerStderr.length}</TruncText>
      <TruncText>entries: {state.logs.length}</TruncText>
      <TruncText dimColor>Use Up/Down to inspect log stream in center pane.</TruncText>
    </Box>
  )
}

async function refreshSection(controller: CommandController, section: SectionId): Promise<void> {
  switch (section) {
    case 'dashboard':
      await Promise.all([
        controller.refreshRelays(),
        controller.refreshFeed(),
        controller.refreshGroups(),
        controller.refreshInvites(),
        controller.refreshGroupFiles(),
        controller.refreshStarterPacks(),
        controller.refreshBookmarks(),
        controller.refreshChats()
      ])
      break
    case 'relays':
      await controller.refreshRelays()
      break
    case 'feed':
      await controller.refreshFeed()
      break
    case 'groups':
      await Promise.all([controller.refreshGroups(), controller.refreshInvites()])
      break
    case 'invites':
      await Promise.all([controller.refreshInvites(), controller.refreshChats()])
      break
    case 'files':
      await controller.refreshGroupFiles()
      break
    case 'lists':
      await controller.refreshStarterPacks()
      break
    case 'bookmarks':
      await controller.refreshBookmarks()
      break
    case 'chats':
      await controller.refreshChats()
      break
    case 'search':
      break
    case 'accounts':
      break
    case 'logs':
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
  const [section, setSection] = useState<SectionId>('dashboard')
  const [selection, setSelection] = useState<SelectionState>(initialSelection)
  const [offsets, setOffsets] = useState<OffsetState>(initialOffsets)
  const [commandInputOpen, setCommandInputOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [commandMessage, setCommandMessage] = useState('Type :help for commands')
  const initialized = state?.initialized || false
  const stateRef = useRef<ControllerState | null>(null)
  const sectionRef = useRef<SectionId>('dashboard')
  const selectionRef = useRef<SelectionState>(initialSelection)
  const offsetsRef = useRef<OffsetState>(initialOffsets)

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
            await refreshSection(controller, 'dashboard')
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
      controllerRef.current = null
    }
  }, [options, scriptedCommands, controllerFactory])

  const selectedIndex = useMemo(() => {
    if (!state) return 0
    const length = sectionLength(state, section)
    return safeSelection(selection[section], length)
  }, [section, selection, state])

  const narrowLayout = stdoutWidth < 132
  const topPaneHeight = Math.max(14, stdoutHeight - 8)
  const centerVisibleRows = Math.max(4, (narrowLayout ? Math.floor((topPaneHeight - 6) / 2) : topPaneHeight - 4))
  const commandMessageMax = Math.max(24, stdoutWidth - 20)

  const normalizedViewport = useMemo(() => {
    if (!state) {
      return { selectedIndex: 0, offset: 0 }
    }
    const length = sectionLength(state, section)
    return normalizeViewport(selectedIndex, offsets[section], length, centerVisibleRows)
  }, [centerVisibleRows, offsets, section, selectedIndex, state])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    sectionRef.current = section
  }, [section])

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  useEffect(() => {
    offsetsRef.current = offsets
  }, [offsets])

  useEffect(() => {
    if (!state) return
    const incoming = state.paneViewport || {}
    setSelection((prev) => {
      let changed = false
      const next = { ...prev }
      for (const key of SECTION_ORDER) {
        const saved = incoming[key]
        if (!saved) continue
        if (typeof saved.cursor === 'number' && prev[key] !== saved.cursor) {
          next[key] = Math.max(0, Math.trunc(saved.cursor))
          changed = true
        }
      }
      return changed ? next : prev
    })
    setOffsets((prev) => {
      let changed = false
      const next = { ...prev }
      for (const key of SECTION_ORDER) {
        const saved = incoming[key]
        if (!saved) continue
        if (typeof saved.offset === 'number' && prev[key] !== saved.offset) {
          next[key] = Math.max(0, Math.trunc(saved.offset))
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [state?.currentAccountPubkey])

  const buildCurrentCommandContext = (): CommandContext | undefined => {
    const snapshot = stateRef.current
    if (!snapshot) return undefined

    const currentSection = sectionRef.current
    const currentSelection = selectionRef.current
    const controller = controllerRef.current
    const selected = safeSelection(
      currentSelection[currentSection] ?? 0,
      sectionLength(snapshot, currentSection)
    )

    return {
      currentSection,
      resolveSelectedGroup: () => resolveSelectedGroupForContext(snapshot, currentSection, selected),
      resolveSelectedInvite: () => resolveSelectedInviteForContext(snapshot, currentSection, selected),
      resolveSelectedRelay: () => resolveSelectedRelayForContext(snapshot, currentSection, selected),
      resolveSelectedFile: () => resolveSelectedFileForContext(snapshot, currentSection, selected),
      resolveSelectedConversation: () =>
        resolveSelectedConversationForContext(snapshot, currentSection, selected),
      resolveSelectedFeedEvent: () =>
        resolveSelectedFeedEventForContext(snapshot, currentSection, selected),
      copy: async (text: string) => {
        const result = await copyToClipboard(text)
        if (controller) {
          await controller.setLastCopied(text, result.method)
        }
        return result
      },
      unsafeCopySecrets: process.env.HYPERTUNA_TUI_ALLOW_UNSAFE_COPY === '1'
    }
  }

  const prefillCommandInput = (): string => {
    const context = buildCurrentCommandContext()
    return buildCommandSnippet(context) || ''
  }

  useEffect(() => {
    if (!state) return
    if (normalizedViewport.selectedIndex !== selection[section]) {
      setSelection((prev) => ({
        ...prev,
        [section]: normalizedViewport.selectedIndex
      }))
    }
    if (normalizedViewport.offset !== offsets[section]) {
      setOffsets((prev) => ({
        ...prev,
        [section]: normalizedViewport.offset
      }))
    }
    const controller = controllerRef.current
    if (controller) {
      controller.setPaneViewport(section, normalizedViewport.selectedIndex, normalizedViewport.offset).catch(() => {})
    }
  }, [state, normalizedViewport, section, selection, offsets])

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
          if (result.gotoSection) {
            setSection(result.gotoSection)
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
    if (!controller) return

    if (commandInputOpen) {
      if (key.escape) {
        setCommandInputOpen(false)
        setCommandInput('')
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

    if (key.return) {
      setCommandInputOpen(true)
      setCommandInput(prefillCommandInput())
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

    if (key.tab || key.rightArrow) {
      setSection((current) => nextSection(current, 1))
      return
    }

    if (key.leftArrow) {
      setSection((current) => nextSection(current, -1))
      return
    }

    const moveSelection = (nextSelection: number): void => {
      const snapshot = stateRef.current
      if (!snapshot) return
      const currentSection = sectionRef.current
      const length = sectionLength(snapshot, currentSection)
      const currentOffset = offsetsRef.current[currentSection] || 0
      const normalized = normalizeViewport(nextSelection, currentOffset, length, centerVisibleRows)
      setSelection((prev) => ({
        ...prev,
        [currentSection]: normalized.selectedIndex
      }))
      setOffsets((prev) => ({
        ...prev,
        [currentSection]: normalized.offset
      }))
    }

    const vimNavEnabled = Boolean(state?.keymap?.vimNavigation)

    if (key.upArrow || (vimNavEnabled && input === 'k')) {
      moveSelection((selectionRef.current[sectionRef.current] || 0) - 1)
      return
    }

    if (key.downArrow || (vimNavEnabled && input === 'j')) {
      moveSelection((selectionRef.current[sectionRef.current] || 0) + 1)
      return
    }

    if (key.pageUp) {
      moveSelection((selectionRef.current[sectionRef.current] || 0) - centerVisibleRows)
      return
    }

    if (key.pageDown) {
      moveSelection((selectionRef.current[sectionRef.current] || 0) + centerVisibleRows)
      return
    }

    const maybeHome = (key as unknown as { home?: boolean }).home
    const maybeEnd = (key as unknown as { end?: boolean }).end

    if (maybeHome || (key.ctrl && input === 'a') || input === 'g') {
      moveSelection(0)
      return
    }

    if (maybeEnd || (key.ctrl && input === 'e') || input === 'G') {
      const snapshot = stateRef.current
      if (!snapshot) return
      const length = sectionLength(snapshot, sectionRef.current)
      moveSelection(Math.max(0, length - 1))
      return
    }

    if (input === '[' || input === ']') {
      if (section === 'groups') {
        const tabs: Array<'discover' | 'my' | 'invites'> = ['discover', 'my', 'invites']
        const index = tabs.indexOf(state?.groupViewTab || 'discover')
        const next = tabs[(index + (input === ']' ? 1 : -1) + tabs.length) % tabs.length]
        controller.setGroupViewTab(next).then(() => {
          setCommandMessage(`Group tab ${next}`)
        }).catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
        return
      }
      if (section === 'chats') {
        const tabs: Array<'conversations' | 'invites'> = ['conversations', 'invites']
        const index = tabs.indexOf(state?.chatViewTab || 'conversations')
        const next = tabs[(index + (input === ']' ? 1 : -1) + tabs.length) % tabs.length]
        controller.setChatViewTab(next).then(() => {
          setCommandMessage(`Chat tab ${next}`)
        }).catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
        return
      }
    }

    if (input === 'r') {
      refreshSection(controller, section)
        .then(() => setCommandMessage(`Refreshed ${SECTION_LABELS[section]}`))
        .catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
      return
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
      if (result.gotoSection) {
        setSection(result.gotoSection)
      }
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const navLabel = (entry: SectionId): string => {
    if (!state) return SECTION_LABELS[entry]
    if (entry === 'files') return `Files (${state.filesCount})`
    if (entry === 'invites') return `Invites (${state.invitesCount})`
    if (entry === 'chats') return `Chats (${state.chatUnreadTotal + state.chatPendingInviteCount})`
    return SECTION_LABELS[entry]
  }

  if (!state) {
    return (
      <Box flexDirection="column">
        <TruncText color="cyan">Booting Hypertuna TUI…</TruncText>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {narrowLayout ? (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="cyan" paddingX={1} height={Math.max(9, Math.floor(topPaneHeight * 0.3))}>
            <Box flexDirection="column">
              <TruncText color="cyan">Hypertuna TUI</TruncText>
              <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
              <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'} · worker: {state.lifecycle}</TruncText>
              <TruncText dimColor>{shortText(state.readinessMessage, Math.max(20, stdoutWidth - 6))}</TruncText>
              <TruncText dimColor>
                section: {navLabel(section)}
                {section === 'dashboard' ? ' · Runtime Summary' : ''}
              </TruncText>
            </Box>
          </Box>

          <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} height={Math.max(8, Math.floor(topPaneHeight * 0.35))}>
            {renderCenterPane(
              state,
              section,
              normalizedViewport.selectedIndex,
              normalizedViewport.offset,
              centerVisibleRows
            )}
          </Box>

          <Box marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1} height={Math.max(8, Math.floor(topPaneHeight * 0.35))} overflow="hidden">
            {renderDetailPane(state, section, normalizedViewport.selectedIndex)}
          </Box>
        </Box>
      ) : (
        <Box height={topPaneHeight}>
          <Box width={28} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <TruncText color="cyan">Hypertuna TUI</TruncText>
            <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
            <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'}</TruncText>
            <TruncText dimColor>worker: {state.lifecycle}</TruncText>
            <TruncText dimColor>{shortText(state.readinessMessage, 24)}</TruncText>
            {section === 'dashboard' ? <TruncText dimColor>Runtime Summary</TruncText> : null}
            <Box marginTop={1} flexDirection="column">
              {SECTION_ORDER.map((entry) => (
                <TruncText key={entry} color={entry === section ? 'green' : undefined}>
                  {entry === section ? '>' : ' '} {navLabel(entry)}
                </TruncText>
              ))}
            </Box>
          </Box>

          <Box flexGrow={1} marginX={1} borderStyle="round" borderColor="blue" paddingX={1}>
            {renderCenterPane(
              state,
              section,
              normalizedViewport.selectedIndex,
              normalizedViewport.offset,
              centerVisibleRows
            )}
          </Box>

          <Box width={50} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} overflow="hidden">
            {renderDetailPane(state, section, normalizedViewport.selectedIndex)}
          </Box>
        </Box>
      )}

      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} overflow="hidden">
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
        ) : (
          <Box>
            <TruncText color="yellow">Command</TruncText>
            <TruncText>: {shortText(commandMessage, commandMessageMax)}</TruncText>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <TruncText dimColor>
          Keys: `:` command, `Enter` prefill command, `y` copy value, `Y` copy command, `Tab/←/→` switch section, `↑/↓` move, `r` refresh, `q` quit
        </TruncText>
      </Box>

      {state.busyTask ? (
        <Box>
          <TruncText color="cyan">
            {options.noAnimations ? 'Working' : <Spinner type="dots" />} {state.busyTask}
          </TruncText>
        </Box>
      ) : null}

      {state.lastError ? (
        <Box>
          <TruncText color="red">Error: {state.lastError}</TruncText>
        </Box>
      ) : null}
    </Box>
  )
}
