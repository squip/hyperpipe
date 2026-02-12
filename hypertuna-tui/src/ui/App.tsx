import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { TuiController, type ControllerState, type RuntimeOptions } from '../domain/controller.js'
import { SECTION_LABELS, SECTION_ORDER, type SectionId } from '../lib/constants.js'
import { shortId } from '../lib/format.js'
import { executeCommand } from './commandRouter.js'

type AppProps = {
  options: RuntimeOptions
}

type SelectionState = Record<SectionId, number>

const initialSelection: SelectionState = {
  dashboard: 0,
  relays: 0,
  feed: 0,
  groups: 0,
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
      return state.groups.length
    case 'files':
      return state.files.length
    case 'lists':
      return state.lists.length
    case 'bookmarks':
      return state.bookmarks.eventIds.length
    case 'chats':
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

function shortText(value: string | null | undefined, max = 80): string {
  if (!value) return ''
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function relaysReadyCount(state: ControllerState): number {
  return state.relays.filter((relay) => relay.readyForReq).length
}

function renderCenterPane(state: ControllerState, section: SectionId, selectedIndex: number): React.ReactNode {
  if (section === 'dashboard') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Runtime Summary</Text>
        <Text>Worker: {state.lifecycle}</Text>
        <Text>Relays: {state.relays.length} ({relaysReadyCount(state)} writable)</Text>
        <Text>Feed events: {state.feed.length}</Text>
        <Text>Groups: {state.groups.length}</Text>
        <Text>Invites: {state.invites.length}</Text>
        <Text>Files: {state.files.length}</Text>
        <Text>Starter packs: {state.lists.length}</Text>
        <Text>Bookmarks: {state.bookmarks.eventIds.length}</Text>
        <Text>Chats: {state.conversations.length} / invites {state.chatInvites.length}</Text>
        <Text>Search results: {state.searchResults.length}</Text>
      </Box>
    )
  }

  if (section === 'relays') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Connected Relays</Text>
        {state.relays.length === 0 ? <Text dimColor>No relays</Text> : null}
        {state.relays.map((relay, idx) => {
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Feed</Text>
        {state.feed.length === 0 ? <Text dimColor>No feed events</Text> : null}
        {state.feed.slice(0, 80).map((event, idx) => {
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Groups</Text>
        {state.groups.length === 0 ? <Text dimColor>No discovered groups</Text> : null}
        {state.groups.slice(0, 80).map((group, idx) => {
          const selected = idx === selectedIndex
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Group Files</Text>
        {state.files.length === 0 ? <Text dimColor>No file metadata events</Text> : null}
        {state.files.slice(0, 80).map((file, idx) => {
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

  if (section === 'lists') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Starter Packs</Text>
        {state.lists.length === 0 ? <Text dimColor>No starter packs</Text> : null}
        {state.lists.slice(0, 80).map((list, idx) => {
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Bookmarks</Text>
        {state.bookmarks.eventIds.length === 0 ? <Text dimColor>No bookmarks</Text> : null}
        {state.bookmarks.eventIds.slice(0, 120).map((eventId, idx) => {
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Conversations</Text>
        {state.conversations.length === 0 ? <Text dimColor>No conversations</Text> : null}
        {state.conversations.slice(0, 80).map((conversation, idx) => {
          const selected = idx === selectedIndex
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Search Results ({state.searchMode})</Text>
        {state.searchQuery ? <Text dimColor>query: {state.searchQuery}</Text> : <Text dimColor>No query</Text>}
        {state.searchResults.length === 0 ? <Text dimColor>No results</Text> : null}
        {state.searchResults.slice(0, 80).map((result, idx) => {
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
    return (
      <Box flexDirection="column">
        <Text color="cyan">Accounts</Text>
        {state.accounts.length === 0 ? <Text dimColor>No accounts configured</Text> : null}
        {state.accounts.map((account, idx) => {
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
      {state.logs.slice(-120).map((entry, idx) => {
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
        <Text color="magenta">Details</Text>
        <Text>Current account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 10) : 'none'}</Text>
        <Text>Session: {state.session ? shortId(state.session.pubkey, 10) : 'locked'}</Text>
        <Text>Worker: {state.lifecycle}</Text>
        <Text>Status: {shortText(state.readinessMessage, 40)}</Text>
        <Text>Stdout lines: {state.workerStdout.length}</Text>
        <Text>Stderr lines: {state.workerStderr.length}</Text>
      </Box>
    )
  }

  if (section === 'relays') {
    const relay = state.relays[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Relay Detail</Text>
        {!relay ? <Text dimColor>No relay selected</Text> : null}
        {relay ? (
          <>
            <Text>relayKey: {shortId(relay.relayKey, 14)}</Text>
            <Text>identifier: {relay.publicIdentifier || '-'}</Text>
            <Text>writable: {String(Boolean(relay.writable))}</Text>
            <Text>requiresAuth: {String(Boolean(relay.requiresAuth))}</Text>
            <Text>readyForReq: {String(Boolean(relay.readyForReq))}</Text>
            <Text>members: {relay.members?.length || 0}</Text>
          </>
        ) : null}
        <Text dimColor>Commands: relay refresh | relay create | relay join | relay disconnect | relay leave</Text>
      </Box>
    )
  }

  if (section === 'feed') {
    const event = state.feed[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Event Detail</Text>
        {!event ? <Text dimColor>No event selected</Text> : null}
        {event ? (
          <>
            <Text>id: {shortId(event.id, 14)}</Text>
            <Text>pubkey: {shortId(event.pubkey, 14)}</Text>
            <Text>kind: {event.kind}</Text>
            <Text>created: {new Date(event.created_at * 1000).toLocaleString()}</Text>
            <Text>tags: {event.tags.length}</Text>
            <Text>{shortText(event.content, 180)}</Text>
          </>
        ) : null}
        <Text dimColor>Commands: post | reply | react | bookmark add/remove</Text>
      </Box>
    )
  }

  if (section === 'groups') {
    const group = state.groups[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Group Detail</Text>
        {!group ? <Text dimColor>No group selected</Text> : null}
        {group ? (
          <>
            <Text>id: {group.id}</Text>
            <Text>name: {group.name}</Text>
            <Text>visibility: {group.isPublic === false ? 'private' : 'public'}</Text>
            <Text>join: {group.isOpen ? 'open' : 'closed'}</Text>
            <Text>relay: {group.relay || '-'}</Text>
            <Text>{shortText(group.about, 140)}</Text>
          </>
        ) : null}
        <Text>pending invites: {state.invites.length}</Text>
        <Text dimColor>Commands: group refresh | group invites | group join-flow | group invite | group update-members</Text>
      </Box>
    )
  }

  if (section === 'files') {
    const file = state.files[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">File Detail</Text>
        {!file ? <Text dimColor>No file selected</Text> : null}
        {file ? (
          <>
            <Text>group: {file.groupId}</Text>
            <Text>name: {file.fileName}</Text>
            <Text>mime: {file.mime || '-'}</Text>
            <Text>size: {file.size || 0}</Text>
            <Text>uploader: {shortId(file.uploadedBy, 8)}</Text>
            <Text>url: {shortText(file.url, 120)}</Text>
          </>
        ) : null}
        <Text dimColor>Commands: file refresh | file upload</Text>
      </Box>
    )
  }

  if (section === 'lists') {
    const list = state.lists[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Starter Pack Detail</Text>
        {!list ? <Text dimColor>No list selected</Text> : null}
        {list ? (
          <>
            <Text>dTag: {list.id}</Text>
            <Text>title: {list.title}</Text>
            <Text>pubkeys: {list.pubkeys.length}</Text>
            <Text>author: {shortId(list.event.pubkey, 10)}</Text>
            <Text>{shortText(list.description, 140)}</Text>
          </>
        ) : null}
        <Text dimColor>Commands: list refresh | list create | list apply</Text>
      </Box>
    )
  }

  if (section === 'bookmarks') {
    const eventId = state.bookmarks.eventIds[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Bookmark Detail</Text>
        {!eventId ? <Text dimColor>No bookmark selected</Text> : <Text>eventId: {eventId}</Text>}
        <Text dimColor>Commands: bookmark refresh | bookmark add | bookmark remove</Text>
      </Box>
    )
  }

  if (section === 'chats') {
    const conversation = state.conversations[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Conversation Detail</Text>
        {!conversation ? <Text dimColor>No conversation selected</Text> : null}
        {conversation ? (
          <>
            <Text>id: {shortId(conversation.id, 10)}</Text>
            <Text>title: {conversation.title}</Text>
            <Text>participants: {conversation.participants.length}</Text>
            <Text>admins: {conversation.adminPubkeys.length}</Text>
            <Text>unread: {conversation.unreadCount}</Text>
            <Text>{shortText(conversation.lastMessagePreview, 140)}</Text>
          </>
        ) : null}
        <Text>pending chat invites: {state.chatInvites.length}</Text>
        <Text dimColor>Commands: chat init | chat refresh | chat create | chat accept | chat thread | chat send</Text>
      </Box>
    )
  }

  if (section === 'search') {
    const result = state.searchResults[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Search Detail</Text>
        {!result ? <Text dimColor>No result selected</Text> : null}
        {result ? (
          <>
            <Text>mode: {result.mode}</Text>
            <Text>event id: {shortId(result.event.id, 12)}</Text>
            <Text>author: {shortId(result.event.pubkey, 12)}</Text>
            <Text>{shortText(result.event.content, 180)}</Text>
          </>
        ) : null}
        <Text dimColor>Command: search &lt;notes|profiles|groups|lists&gt; &lt;query&gt;</Text>
      </Box>
    )
  }

  if (section === 'accounts') {
    const account = state.accounts[selectedIndex]
    return (
      <Box flexDirection="column">
        <Text color="magenta">Account Detail</Text>
        {!account ? <Text dimColor>No account selected</Text> : null}
        {account ? (
          <>
            <Text>pubkey: {account.pubkey}</Text>
            <Text>signer: {account.signerType}</Text>
            <Text>label: {account.label || '-'}</Text>
            <Text>created: {new Date(account.createdAt).toLocaleString()}</Text>
            <Text>updated: {new Date(account.updatedAt).toLocaleString()}</Text>
          </>
        ) : null}
        <Text dimColor>Commands: account add-nsec | add-ncryptsec | select | unlock | remove | clear</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="magenta">Logs</Text>
      <Text>stdout: {state.workerStdout.length}</Text>
      <Text>stderr: {state.workerStderr.length}</Text>
      <Text>entries: {state.logs.length}</Text>
      <Text dimColor>Use Up/Down to inspect log stream in center pane.</Text>
    </Box>
  )
}

async function refreshSection(controller: TuiController, section: SectionId): Promise<void> {
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

export function App({ options }: AppProps): React.JSX.Element {
  const { exit } = useApp()
  const controllerRef = useRef<TuiController | null>(null)

  const [state, setState] = useState<ControllerState | null>(null)
  const [section, setSection] = useState<SectionId>('dashboard')
  const [selection, setSelection] = useState<SelectionState>(initialSelection)
  const [commandInputOpen, setCommandInputOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [commandMessage, setCommandMessage] = useState('Type :help for commands')

  useEffect(() => {
    const controller = new TuiController(options)
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
        if (snapshot.currentAccountPubkey) {
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
  }, [options])

  const selectedIndex = useMemo(() => {
    if (!state) return 0
    const length = sectionLength(state, section)
    return safeSelection(selection[section], length)
  }, [section, selection, state])

  useEffect(() => {
    if (!state) return
    const length = sectionLength(state, section)
    const normalized = safeSelection(selection[section], length)
    if (normalized !== selection[section]) {
      setSelection((prev) => ({
        ...prev,
        [section]: normalized
      }))
    }
  }, [section, selection, state])

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

    if (key.tab || key.rightArrow) {
      setSection((current) => nextSection(current, 1))
      return
    }

    if (key.leftArrow) {
      setSection((current) => nextSection(current, -1))
      return
    }

    if (key.upArrow) {
      setSelection((prev) => ({
        ...prev,
        [section]: Math.max(0, prev[section] - 1)
      }))
      return
    }

    if (key.downArrow) {
      const length = state ? sectionLength(state, section) : 0
      setSelection((prev) => ({
        ...prev,
        [section]: Math.min(Math.max(0, length - 1), prev[section] + 1)
      }))
      return
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
      const result = await executeCommand(controller, value)
      setCommandMessage(result.message)
      if (result.gotoSection) {
        setSection(result.gotoSection)
      }
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error))
    }
  }

  if (!state) {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Booting Hypertuna TUI…</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={26} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">Hypertuna TUI</Text>
          <Text dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</Text>
          <Text dimColor>session: {state.session ? 'unlocked' : 'locked'}</Text>
          <Text dimColor>worker: {state.lifecycle}</Text>
          <Text dimColor>{shortText(state.readinessMessage, 24)}</Text>
          <Box marginTop={1} flexDirection="column">
            {SECTION_ORDER.map((entry) => (
              <Text key={entry} color={entry === section ? 'green' : undefined}>
                {entry === section ? '>' : ' '} {SECTION_LABELS[entry]}
              </Text>
            ))}
          </Box>
        </Box>

        <Box flexGrow={1} marginX={1} borderStyle="round" borderColor="blue" paddingX={1}>
          {renderCenterPane(state, section, selectedIndex)}
        </Box>

        <Box width={48} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          {renderDetailPane(state, section, selectedIndex)}
        </Box>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        {commandInputOpen ? (
          <Box>
            <Text color="yellow">:</Text>
            <TextInput
              value={commandInput}
              onChange={setCommandInput}
              onSubmit={runCommand}
              placeholder="command"
            />
          </Box>
        ) : (
          <Box>
            <Text color="yellow">Command</Text>
            <Text>: {shortText(commandMessage, 180)}</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Keys: `:` command, `Tab/←/→` switch section, `↑/↓` move, `r` refresh, `q` quit
        </Text>
      </Box>

      {state.busyTask ? (
        <Box>
          <Text color="cyan">
            {options.noAnimations ? 'Working' : <Spinner type="dots" />} {state.busyTask}
          </Text>
        </Box>
      ) : null}

      {state.lastError ? (
        <Box>
          <Text color="red">Error: {state.lastError}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
