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
    currentSection: 'groups',
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
      currentSection: 'chats',
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
})
