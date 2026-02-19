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

function gatewayCreateContext(args: {
  gatewayMetadata: Array<{
    origin: string
    operatorPubkey: string
    policy: 'OPEN' | 'CLOSED'
    allowList?: string[]
  }>
  currentPubkey?: string
}): CommandContext {
  return {
    resolveGatewayMetadata: () => args.gatewayMetadata,
    resolveCurrentPubkey: () => args.currentPubkey || null
  }
}

describe('command router context-first workflows', () => {
  it('supports goto aliases for new tree workflow nodes', async () => {
    const controller = createController()

    const gotoCreateGroup = await executeCommand(controller, 'goto create-group')
    const gotoCreateChat = await executeCommand(controller, 'goto chats:create')
    const gotoSendInvite = await executeCommand(controller, 'goto send-invite')

    expect(gotoCreateGroup.gotoNode).toBe('groups:create')
    expect(gotoCreateChat.gotoNode).toBe('chats:create')
    expect(gotoSendInvite.gotoNode).toBe('invites:send')
  })

  it('uses selected group for join-flow when group id is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()

    const result = await executeCommand(controller, 'group join-flow demo-token --open', context)
    expect(result.message).toContain(groupId)
    expect(controller.getState().logs.some((entry) => entry.message.includes(`join-flow:${groupId}`))).toBe(true)
  })

  it('uses selected group and relay for invite when metadata is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    const inviteePubkey = 'c'.repeat(64)

    await executeCommand(controller, `group invite ${inviteePubkey} invite-token`, context)

    const latestInvite = controller.getState().invites[0]
    expect(latestInvite).toBeTruthy()
    expect(latestInvite?.groupId).toBe(groupId)
    expect(latestInvite?.token).toBe('invite-token')
  })

  it('uses selected group for update-members and update-auth when identifier is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const memberPubkey = 'd'.repeat(64)

    await executeCommand(controller, `group update-members add ${memberPubkey}`, context)
    await executeCommand(controller, `group update-auth ${memberPubkey} auth-token-2`, context)

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

  it('routes group request-invite through selected group context when group id is omitted', async () => {
    const controller = createController()
    const context = groupContext(controller)
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()

    const result = await executeCommand(controller, 'group request-invite join-code-1 please approve', context)
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
    expect(copiedValues[1]).toBe(`group members ${groupId}`)
  })

  it('blocks sensitive copy fields by default', async () => {
    const controller = createController()
    const context = groupContext(controller)

    await expect(executeCommand(controller, 'copy token', context)).rejects.toThrow(
      /sensitive fields/i
    )
  })

  it('supports relay create --gateway-origin resolution from metadata', async () => {
    const controller = createController()
    const gateway = {
      origin: 'https://gateway-open.example',
      operatorPubkey: 'e'.repeat(64),
      policy: 'OPEN' as const,
      allowList: []
    }
    const context = gatewayCreateContext({
      gatewayMetadata: [gateway],
      currentPubkey: 'f'.repeat(64)
    })

    const result = await executeCommand(
      controller,
      'relay create gateway-origin-ok --gateway-origin https://gateway-open.example',
      context
    )
    expect(result.message).toContain('Relay created')
  })

  it('fails relay create --gateway-origin when origin is unknown', async () => {
    const controller = createController()
    const context = gatewayCreateContext({
      gatewayMetadata: [],
      currentPubkey: 'f'.repeat(64)
    })

    await expect(
      executeCommand(
        controller,
        'relay create gateway-origin-missing --gateway-origin https://missing-gateway.example',
        context
      )
    ).rejects.toThrow(/Unknown --gateway-origin/)
  })

  it('fails relay create --gateway-origin for CLOSED gateway when user is not allow-listed', async () => {
    const controller = createController()
    const context = gatewayCreateContext({
      gatewayMetadata: [
        {
          origin: 'https://gateway-closed.example',
          operatorPubkey: 'a'.repeat(64),
          policy: 'CLOSED',
          allowList: ['b'.repeat(64)]
        }
      ],
      currentPubkey: 'c'.repeat(64)
    })

    await expect(
      executeCommand(
        controller,
        'relay create gateway-origin-closed --gateway-origin https://gateway-closed.example',
        context
      )
    ).rejects.toThrow(/not allow-listed/)
  })
})
