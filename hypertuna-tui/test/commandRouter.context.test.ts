import { describe, expect, it, vi } from 'vitest'
import type { RuntimeOptions } from '../src/domain/controller.js'
import { executeCommand, type CommandContext } from '../src/ui/commandRouter.js'
import { MockController } from './e2e/support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-command-context',
  noAnimations: true,
  logLevel: 'info'
}

function createController(): MockController {
  return MockController.withSeedData(BASE_OPTIONS)
}

function groupContext(controller: MockController, copyImpl?: CommandContext['copy']): CommandContext {
  return {
    currentNode: 'groups:my',
    resolveSelectedGroup: () => {
      const group = controller.getState().groups[0]
      if (!group) return null
      return { id: group.id, relay: group.relay || null }
    },
    resolveSelectedInvite: () => null,
    resolveSelectedRelay: () => {
      const relay = controller.getState().relays[0]
      if (!relay) return null
      return {
        relayKey: relay.relayKey,
        publicIdentifier: relay.publicIdentifier || null,
        connectionUrl: relay.connectionUrl || null
      }
    },
    copy: copyImpl
  }
}

describe('command router context-first workflows', () => {
  it('supports relay goto aliases for consolidated tree workflow nodes', async () => {
    const controller = createController()

    const gotoCreateRelay = await executeCommand(controller, 'goto relay:create')
    const gotoBrowseRelay = await executeCommand(controller, 'goto relay:browse')
    const gotoMyRelay = await executeCommand(controller, 'goto relays')
    const gotoCreateChat = await executeCommand(controller, 'goto chats:create')

    expect(gotoCreateRelay.gotoNode).toBe('groups:create')
    expect(gotoBrowseRelay.gotoNode).toBe('groups:browse')
    expect(gotoMyRelay.gotoNode).toBe('groups:my')
    expect(gotoCreateChat.gotoNode).toBe('chats:create')
    await expect(executeCommand(controller, 'goto send-invite')).rejects.toThrow(/removed/i)
  })

  it('returns explicit migration errors for removed group command and goto aliases', async () => {
    const controller = createController()
    await expect(executeCommand(controller, 'group refresh')).rejects.toThrow(/Use "relay refresh" instead/i)
    await expect(executeCommand(controller, 'goto groups:my')).rejects.toThrow(/goto relay:my/i)
  })

  it('runs consolidated relay refresh across relay and group state', async () => {
    const controller = createController()
    const refreshRelaysSpy = vi.spyOn(controller, 'refreshRelays')
    const refreshGroupsSpy = vi.spyOn(controller, 'refreshGroups')

    const result = await executeCommand(controller, 'relay refresh')
    expect(result.gotoNode).toBe('groups:my')
    expect(refreshRelaysSpy).toHaveBeenCalledTimes(1)
    expect(refreshGroupsSpy).toHaveBeenCalledTimes(1)
  })

  it('uses selected relay for join-flow when relay id is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()

    const result = await executeCommand(controller, 'relay join-flow demo-token --open', context)
    expect(result.message).toContain(groupId)
    expect(controller.getState().logs.some((entry) => entry.message.includes(`join-flow:${groupId}`))).toBe(true)
  })

  it('uses selected relay and relay url for invite when metadata is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    const inviteePubkey = 'c'.repeat(64)

    await executeCommand(controller, `relay invite ${inviteePubkey} invite-token`, context)

    const latestInvite = controller.getState().invites[0]
    expect(latestInvite).toBeTruthy()
    expect(latestInvite?.groupId).toBe(groupId)
    expect(latestInvite?.token).toBe('invite-token')
  })

  it('uses selected relay for update-members and update-auth when identifier is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const memberPubkey = 'd'.repeat(64)

    await executeCommand(controller, `relay update-members add ${memberPubkey}`, context)
    await executeCommand(controller, `relay update-auth ${memberPubkey} auth-token-2`, context)

    const logMessages = controller.getState().logs.map((entry) => entry.message)
    expect(logMessages.some((message) => message.includes('members-updated'))).toBe(true)
    expect(logMessages.some((message) => message.includes('auth-updated'))).toBe(true)
  })

  it('accepts chat invite using selected invite when invite id is omitted', async () => {
    const controller = createController()
    const inviteId = controller.getState().chatInvites[0]?.id
    expect(inviteId).toBeTruthy()

    const context: CommandContext = {
      currentNode: 'invites:chat',
      resolveSelectedInvite: () => {
        const invite = controller.getState().chatInvites[0]
        if (!invite) return null
        return {
          kind: 'chat',
          id: invite.id,
          conversationId: invite.conversationId || null
        }
      }
    }

    await executeCommand(controller, 'chat accept', context)
    expect(controller.getState().chatInvites.some((invite) => invite.id === inviteId)).toBe(false)
  })

  it('routes relay request-invite through selected relay context when relay id is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()

    const result = await executeCommand(controller, 'relay request-invite join-code-1 please approve', context)
    expect(result.message).toContain(groupId)
    expect(controller.getState().logs.some((entry) => entry.message.includes(`request-invite:${groupId}`))).toBe(true)
  })

  it('routes chat invite through selected conversation context', async () => {
    const controller = createController()
    const conversationId = controller.getState().conversations[0]?.id
    expect(conversationId).toBeTruthy()

    const invitee = 'b'.repeat(64)
    const context: CommandContext = {
      currentNode: 'chats',
      resolveSelectedConversation: () => ({ id: conversationId as string })
    }

    const result = await executeCommand(controller, `chat invite ${invitee}`, context)
    expect(result.message).toContain('Invited')
    const updatedConversation = controller.getState().conversations.find((entry) => entry.id === conversationId)
    expect(updatedConversation?.participants.includes(invitee)).toBe(true)
  })

  it('joins relay using selected relay when identifier is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const before = controller.getState().relays.length

    await executeCommand(controller, 'relay join', context)
    expect(controller.getState().relays.length).toBe(before + 1)
  })

  it('copies selected value and command snippets without manual metadata typing', async () => {
    const controller = createController()
    const copiedValues: string[] = []
    const copySpy = vi.fn(async (value: string) => {
      copiedValues.push(value)
      return { ok: true, method: 'pbcopy' as const }
    })
    const context = groupContext(controller, copySpy)
    const groupId = controller.getState().groups[0]?.id || ''

    const selectedResult = await executeCommand(controller, 'copy selected', context)
    const commandResult = await executeCommand(controller, 'copy command', context)

    expect(selectedResult.message).toContain('Copied')
    expect(commandResult.message).toContain('Copied')
    expect(copiedValues[0]).toBe(groupId)
    expect(copiedValues[1]).toBe(`relay members ${groupId}`)
  })

  it('blocks sensitive copy fields by default', async () => {
    const controller = createController()
    const context = groupContext(controller)

    await expect(executeCommand(controller, 'copy token', context)).rejects.toThrow(
      /sensitive fields/i
    )
  })
})
