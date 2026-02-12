import type { SearchMode } from '../domain/types.js'
import type { TuiController } from '../domain/controller.js'
import { SECTION_ORDER, type SectionId } from '../lib/constants.js'
import { normalizeBool, splitCsv } from '../lib/format.js'

export type CommandResult = {
  message: string
  gotoSection?: SectionId
}

function tokenize(input: string): string[] {
  const matches = input.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || []
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''))
}

function remainder(input: string, command: string): string {
  const idx = input.toLowerCase().indexOf(command.toLowerCase())
  if (idx < 0) return ''
  return input.slice(idx + command.length).trim()
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

function parseSection(input: string): SectionId {
  const normalized = input.trim().toLowerCase()
  const section = SECTION_ORDER.find((entry) => entry === normalized)
  if (!section) {
    throw new Error(`Unknown section: ${input}`)
  }
  return section
}

export async function executeCommand(controller: TuiController, input: string): Promise<CommandResult> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { message: 'Empty command' }
  }

  const args = tokenize(trimmed)
  const cmd = args[0]?.toLowerCase() || ''

  if (cmd === 'help') {
    return {
      message:
        'Commands: help | goto <section> | account add-nsec/add-ncryptsec/select/unlock/remove/clear | worker start/stop/restart | relay refresh/create/join/disconnect/leave | feed refresh | post/reply/react | bookmark refresh/add/remove | group refresh/invites/join-flow/invite/update-members/update-auth | file refresh/upload | list refresh/create/apply | chat init/refresh/create/accept/thread/send | search <notes|profiles|groups|lists> <query>'
    }
  }

  if (cmd === 'goto') {
    const section = parseSection(requireArg(args[1], 'section'))
    return {
      message: `Switched to ${section}`,
      gotoSection: section
    }
  }

  if (cmd === 'account') {
    const action = requireArg(args[1], 'account action').toLowerCase()

    if (action === 'add-nsec') {
      const nsec = requireArg(args[2], 'nsec')
      const label = args.slice(3).join(' ') || undefined
      await controller.addNsecAccount(nsec, label)
      await controller.unlockCurrentAccount()
      await controller.startWorker()
      return { message: 'nsec account added and unlocked', gotoSection: 'accounts' }
    }

    if (action === 'add-ncryptsec') {
      const ncryptsec = requireArg(args[2], 'ncryptsec')
      const password = requireArg(args[3], 'password')
      const label = args.slice(4).join(' ') || undefined
      await controller.addNcryptsecAccount(ncryptsec, password, label)
      await controller.unlockCurrentAccount(async () => password)
      await controller.startWorker()
      return { message: 'ncryptsec account added and unlocked', gotoSection: 'accounts' }
    }

    if (action === 'select') {
      const pubkey = requireArg(args[2], 'pubkey')
      await controller.selectAccount(pubkey)
      return { message: `Selected account ${pubkey}`, gotoSection: 'accounts' }
    }

    if (action === 'unlock') {
      const password = args[2]
      await controller.unlockCurrentAccount(password ? async () => password : undefined)
      await controller.startWorker()
      return { message: 'Account unlocked and worker started', gotoSection: 'accounts' }
    }

    if (action === 'remove') {
      const pubkey = requireArg(args[2], 'pubkey')
      await controller.removeAccount(pubkey)
      return { message: `Removed account ${pubkey}`, gotoSection: 'accounts' }
    }

    if (action === 'clear') {
      await controller.clearSession()
      return { message: 'Session cleared', gotoSection: 'accounts' }
    }

    throw new Error(`Unknown account action: ${action}`)
  }

  if (cmd === 'worker') {
    const action = requireArg(args[1], 'worker action').toLowerCase()
    if (action === 'start') {
      await controller.startWorker()
      return { message: 'Worker started', gotoSection: 'dashboard' }
    }
    if (action === 'stop') {
      await controller.stopWorker()
      return { message: 'Worker stopped', gotoSection: 'dashboard' }
    }
    if (action === 'restart') {
      await controller.restartWorker()
      return { message: 'Worker restarted', gotoSection: 'dashboard' }
    }
    throw new Error(`Unknown worker action: ${action}`)
  }

  if (cmd === 'relay') {
    const action = requireArg(args[1], 'relay action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshRelays()
      return { message: 'Relays refreshed', gotoSection: 'relays' }
    }

    if (action === 'create') {
      const name = requireArg(args[2], 'name')
      const isPublic = args.includes('--public') || !args.includes('--private')
      const isOpen = args.includes('--open') || !args.includes('--closed')
      const fileSharing = args.includes('--file-sharing') ? true : args.includes('--no-file-sharing') ? false : true
      await controller.createRelay({
        name,
        isPublic,
        isOpen,
        fileSharing,
        description: args.includes('--desc')
          ? args.slice(args.indexOf('--desc') + 1).join(' ')
          : undefined
      })
      return { message: `Relay created: ${name}`, gotoSection: 'relays' }
    }

    if (action === 'join') {
      const identifier = requireArg(args[2], 'publicIdentifier or relayKey')
      const token = args[3]
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.joinRelay({
        relayKey: isRelayKey ? identifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : identifier,
        authToken: token
      })
      return { message: `Join relay requested for ${identifier}`, gotoSection: 'relays' }
    }

    if (action === 'disconnect') {
      const relayKey = requireArg(args[2], 'relayKey')
      await controller.disconnectRelay(relayKey)
      return { message: `Relay disconnected ${relayKey}`, gotoSection: 'relays' }
    }

    if (action === 'leave') {
      const identifier = requireArg(args[2], 'publicIdentifier or relayKey')
      const saveRelaySnapshot = args.includes('--archive') ? true : args.includes('--no-archive') ? false : true
      const saveSharedFiles = args.includes('--save-files') ? true : args.includes('--drop-files') ? false : true
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.leaveGroup({
        relayKey: isRelayKey ? identifier.toLowerCase() : null,
        publicIdentifier: isRelayKey ? null : identifier,
        saveRelaySnapshot,
        saveSharedFiles
      })
      return { message: `Leave group requested for ${identifier}`, gotoSection: 'relays' }
    }

    if (action === 'join-flow') {
      const publicIdentifier = requireArg(args[2], 'publicIdentifier')
      const token = args[3]
      await controller.startJoinFlow({
        publicIdentifier,
        token,
        openJoin: args.includes('--open')
      })
      return { message: `Join flow started for ${publicIdentifier}`, gotoSection: 'groups' }
    }

    throw new Error(`Unknown relay action: ${action}`)
  }

  if (cmd === 'feed') {
    const action = requireArg(args[1], 'feed action').toLowerCase()
    if (action === 'refresh') {
      const limit = args[2] ? Number(args[2]) : 120
      await controller.refreshFeed(Number.isFinite(limit) ? limit : 120)
      return { message: 'Feed refreshed', gotoSection: 'feed' }
    }
    throw new Error(`Unknown feed action: ${action}`)
  }

  if (cmd === 'post') {
    const content = remainder(trimmed, 'post')
    if (!content) throw new Error('Post content required')
    await controller.publishPost(content)
    return { message: 'Post published', gotoSection: 'feed' }
  }

  if (cmd === 'reply') {
    const eventId = requireArg(args[1], 'eventId')
    const pubkey = requireArg(args[2], 'event pubkey')
    const content = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
    if (!content) throw new Error('Reply content required')
    await controller.publishReply(content, eventId, pubkey)
    return { message: 'Reply published', gotoSection: 'feed' }
  }

  if (cmd === 'react') {
    const eventId = requireArg(args[1], 'eventId')
    const pubkey = requireArg(args[2], 'event pubkey')
    const reaction = requireArg(args[3], 'reaction')
    await controller.publishReaction(eventId, pubkey, reaction)
    return { message: 'Reaction published', gotoSection: 'feed' }
  }

  if (cmd === 'bookmark') {
    const action = requireArg(args[1], 'bookmark action').toLowerCase()
    if (action === 'refresh') {
      await controller.refreshBookmarks()
      return { message: 'Bookmarks refreshed', gotoSection: 'bookmarks' }
    }
    if (action === 'add') {
      const eventId = requireArg(args[2], 'eventId')
      await controller.addBookmark(eventId)
      return { message: 'Bookmark added', gotoSection: 'bookmarks' }
    }
    if (action === 'remove') {
      const eventId = requireArg(args[2], 'eventId')
      await controller.removeBookmark(eventId)
      return { message: 'Bookmark removed', gotoSection: 'bookmarks' }
    }
    throw new Error(`Unknown bookmark action: ${action}`)
  }

  if (cmd === 'group') {
    const action = requireArg(args[1], 'group action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshGroups()
      return { message: 'Groups refreshed', gotoSection: 'groups' }
    }

    if (action === 'invites') {
      await controller.refreshInvites()
      return { message: 'Invites refreshed', gotoSection: 'groups' }
    }

    if (action === 'join-flow') {
      const publicIdentifier = requireArg(args[2], 'publicIdentifier')
      const token = args[3]
      await controller.startJoinFlow({
        publicIdentifier,
        token,
        openJoin: args.includes('--open')
      })
      return { message: `Join flow started for ${publicIdentifier}`, gotoSection: 'groups' }
    }

    if (action === 'invite') {
      const groupId = requireArg(args[2], 'groupId')
      const relayUrl = requireArg(args[3], 'relayUrl')
      const inviteePubkey = requireArg(args[4], 'inviteePubkey')
      const token = args[5]
      await controller.sendInvite({
        groupId,
        relayUrl,
        inviteePubkey,
        token,
        payload: {
          groupName: groupId,
          isPublic: true,
          fileSharing: true
        }
      })
      return { message: `Invite sent to ${inviteePubkey}`, gotoSection: 'groups' }
    }

    if (action === 'update-members') {
      const relayOrIdentifier = requireArg(args[2], 'relayKey or publicIdentifier')
      const op = requireArg(args[3], 'add/remove').toLowerCase()
      const pubkey = requireArg(args[4], 'member pubkey')
      const now = Date.now()
      const isRelayKey = /^[a-f0-9]{64}$/i.test(relayOrIdentifier)

      await controller.updateGroupMembers({
        relayKey: isRelayKey ? relayOrIdentifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : relayOrIdentifier,
        memberAdds: op === 'add' ? [{ pubkey, ts: now }] : undefined,
        memberRemoves: op === 'remove' ? [{ pubkey, ts: now }] : undefined
      })

      return { message: `Membership update sent (${op} ${pubkey})`, gotoSection: 'groups' }
    }

    if (action === 'update-auth') {
      const relayOrIdentifier = requireArg(args[2], 'relayKey or publicIdentifier')
      const pubkey = requireArg(args[3], 'pubkey')
      const token = requireArg(args[4], 'token')
      const isRelayKey = /^[a-f0-9]{64}$/i.test(relayOrIdentifier)

      await controller.updateGroupAuth({
        relayKey: isRelayKey ? relayOrIdentifier.toLowerCase() : undefined,
        publicIdentifier: isRelayKey ? undefined : relayOrIdentifier,
        pubkey,
        token
      })

      return { message: `Auth token updated for ${pubkey}`, gotoSection: 'groups' }
    }

    throw new Error(`Unknown group action: ${action}`)
  }

  if (cmd === 'file') {
    const action = requireArg(args[1], 'file action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshGroupFiles(args[2])
      return { message: 'Files refreshed', gotoSection: 'files' }
    }

    if (action === 'upload') {
      const identifier = requireArg(args[2], 'publicIdentifier or relayKey')
      const filePath = requireArg(args[3], 'filePath')
      const isRelayKey = /^[a-f0-9]{64}$/i.test(identifier)
      await controller.uploadGroupFile({
        relayKey: isRelayKey ? identifier.toLowerCase() : null,
        publicIdentifier: isRelayKey ? null : identifier,
        filePath
      })
      return { message: `Uploaded file ${filePath}`, gotoSection: 'files' }
    }

    throw new Error(`Unknown file action: ${action}`)
  }

  if (cmd === 'list') {
    const action = requireArg(args[1], 'list action').toLowerCase()

    if (action === 'refresh') {
      await controller.refreshStarterPacks()
      return { message: 'Lists refreshed', gotoSection: 'lists' }
    }

    if (action === 'create') {
      const dTag = requireArg(args[2], 'dTag')
      const title = requireArg(args[3], 'title')
      const pubkeys = splitCsv(requireArg(args[4], 'pubkeys csv'))
      await controller.createStarterPack({
        dTag,
        title,
        pubkeys,
        description: args[5]
      })
      return { message: `Starter pack ${dTag} published`, gotoSection: 'lists' }
    }

    if (action === 'apply') {
      const dTag = requireArg(args[2], 'dTag')
      const author = args[3]
      await controller.applyStarterPack(dTag, author)
      return { message: `Applied starter pack ${dTag}`, gotoSection: 'lists' }
    }

    throw new Error(`Unknown list action: ${action}`)
  }

  if (cmd === 'chat') {
    const action = requireArg(args[1], 'chat action').toLowerCase()

    if (action === 'init') {
      await controller.initChats()
      return { message: 'Chats initialized', gotoSection: 'chats' }
    }

    if (action === 'refresh') {
      await controller.refreshChats()
      return { message: 'Chats refreshed', gotoSection: 'chats' }
    }

    if (action === 'create') {
      const title = requireArg(args[2], 'title')
      const members = splitCsv(requireArg(args[3], 'members csv'))
      await controller.createConversation({
        title,
        members,
        description: args[4]
      })
      return { message: 'Conversation created', gotoSection: 'chats' }
    }

    if (action === 'accept') {
      const inviteId = requireArg(args[2], 'inviteId')
      await controller.acceptChatInvite(inviteId)
      return { message: `Invite accepted ${inviteId}`, gotoSection: 'chats' }
    }

    if (action === 'thread') {
      const conversationId = requireArg(args[2], 'conversationId')
      await controller.loadChatThread(conversationId)
      return { message: `Thread loaded ${conversationId}`, gotoSection: 'chats' }
    }

    if (action === 'send') {
      const conversationId = requireArg(args[2], 'conversationId')
      const content = remainder(trimmed, `${args[0]} ${args[1]} ${args[2]}`)
      if (!content) throw new Error('Message content required')
      await controller.sendChatMessage(conversationId, content)
      return { message: 'Message sent', gotoSection: 'chats' }
    }

    throw new Error(`Unknown chat action: ${action}`)
  }

  if (cmd === 'search') {
    const rawMode = requireArg(args[1], 'mode').toLowerCase()
    const mode = rawMode as SearchMode
    if (!['notes', 'profiles', 'groups', 'lists'].includes(mode)) {
      throw new Error('Search mode must be notes|profiles|groups|lists')
    }

    const query = remainder(trimmed, `${args[0]} ${args[1]}`)
    if (!query) throw new Error('Search query required')

    await controller.search(mode, query)
    return { message: `Search complete (${mode})`, gotoSection: 'search' }
  }

  if (cmd === 'refresh') {
    const target = args[1]?.toLowerCase()
    if (!target || target === 'all') {
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
      return { message: 'All views refreshed' }
    }

    if (target === 'true' || target === 'false') {
      return { message: `Refresh expects view name, not boolean (${normalizeBool(target)})` }
    }

    return await executeCommand(controller, `${target} refresh`)
  }

  throw new Error(`Unknown command: ${cmd}`)
}
