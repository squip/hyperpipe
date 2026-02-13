import { describe, expect, it } from 'vitest'
import { executeCommand } from '../../src/ui/commandRouter.js'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { MockController } from './support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-e2e',
  noAnimations: true,
  logLevel: 'info'
}

function createController(): MockController {
  return MockController.withSeedData(BASE_OPTIONS)
}

describe('TUI e2e feature scenarios', () => {
  it('relay discovery/default/custom set lifecycle', async () => {
    const controller = createController()
    const initialRelayCount = controller.getState().relays.length

    const refreshResult = await executeCommand(controller, 'relay refresh')
    expect(refreshResult.message).toContain('Relays refreshed')

    await executeCommand(controller, 'relay create devgroup --public --open --desc dev_group')
    const afterCreate = controller.getState()
    expect(afterCreate.relays.length).toBe(initialRelayCount + 1)
    expect(afterCreate.groups.some((group) => group.name === 'devgroup')).toBe(true)
    expect(afterCreate.myGroups.some((group) => group.name === 'devgroup')).toBe(true)

    await executeCommand(controller, 'relay join npubexternal:group token123')
    const joinedRelay = controller
      .getState()
      .relays.find((relay) => relay.publicIdentifier === 'npubexternal:group')
    expect(joinedRelay).toBeTruthy()
    expect(joinedRelay?.requiresAuth).toBe(true)

    await executeCommand(controller, `relay disconnect ${joinedRelay?.relayKey || ''}`)
    expect(
      controller
        .getState()
        .relays.some((relay) => relay.publicIdentifier === 'npubexternal:group')
    ).toBe(false)
  })

  it('keeps note authoring commands for group workflows', async () => {
    const controller = createController()
    const seedNote = controller.getState().feed[0]
    expect(seedNote).toBeTruthy()

    await executeCommand(controller, 'post e2e_post_content')
    await executeCommand(controller, `reply ${seedNote?.id} ${seedNote?.pubkey} e2e_reply_content`)
    await executeCommand(controller, `react ${seedNote?.id} ${seedNote?.pubkey} +`)

    const stateAfterPublish = controller.getState()
    expect(stateAfterPublish.feed.some((event) => event.kind === 7 && event.content === '+')).toBe(true)
    expect(stateAfterPublish.feed.some((event) => event.content === 'e2e_post_content')).toBe(true)
    expect(stateAfterPublish.feed.some((event) => event.content === 'e2e_reply_content')).toBe(true)
  })

  it('groups browse/my views and join flow remain functional', async () => {
    const controller = createController()
    await executeCommand(controller, 'group refresh')
    expect(controller.getState().groups.length).toBeGreaterThan(0)

    const tabResult = await executeCommand(controller, 'group tab my')
    expect(tabResult.gotoNode).toBe('groups:my')

    await executeCommand(controller, 'group join-flow npubexternal:groupflow token-flow --open')
    expect(controller.getState().logs.some((log) => log.message.includes('join-flow:npubexternal:groupflow'))).toBe(true)
  })

  it('invites accept/dismiss workflows update inbox counts', async () => {
    const controller = createController()
    const groupInviteId = controller.getState().groupInvites[0]?.id
    const chatInviteId = controller.getState().chatInvites[0]?.id
    expect(groupInviteId).toBeTruthy()
    expect(chatInviteId).toBeTruthy()

    await executeCommand(controller, `invites accept group ${groupInviteId}`)
    expect(controller.getState().groupInvites.some((invite) => invite.id === groupInviteId)).toBe(false)

    await executeCommand(controller, `invites dismiss chat ${chatInviteId}`)
    expect(controller.getState().chatInvites.some((invite) => invite.id === chatInviteId)).toBe(false)
  })

  it('file upload, download, and local delete workflows operate via file commands', async () => {
    const controller = createController()
    const groupId = controller.getState().groups[0]?.id || 'npubseed:group-a'

    await executeCommand(controller, `file refresh ${groupId}`)
    const beforeUpload = controller.getState().files.length
    await executeCommand(controller, `file upload ${groupId} /tmp/e2e-upload.bin`)
    expect(controller.getState().files.length).toBe(beforeUpload + 1)

    const file = controller.getState().files[0]
    expect(file?.sha256).toBeTruthy()
    const hash = String(file?.sha256)

    const downloadResult = await executeCommand(controller, `file download ${hash}`)
    expect(downloadResult.message).toContain('Downloaded')
    expect(controller.getState().fileActionStatus.state).toBe('success')

    const deleteResult = await executeCommand(controller, `file delete ${hash}`)
    expect(deleteResult.message).toContain('Deleted local file')
    expect(controller.getState().hiddenDeletedFileKeys).toContain(hash.toLowerCase())
  })

  it('account switching and worker lifecycle remain functional', async () => {
    const controller = createController()

    const generated = await executeCommand(controller, 'account generate generated_profile')
    expect(generated.message).toContain('Generated profile')
    const generatedPubkey = controller.getState().currentAccountPubkey
    expect(generatedPubkey).toBeTruthy()
    expect(controller.getState().lifecycle).toBe('ready')

    await executeCommand(controller, 'worker restart')
    expect(controller.getState().lifecycle).toBe('ready')

    await executeCommand(controller, 'account clear')
    expect(controller.getState().session).toBeNull()
    expect(controller.getState().lifecycle).toBe('stopped')
  })

  it('removed commands are rejected from user-facing UX', async () => {
    const controller = createController()
    await expect(executeCommand(controller, 'feed refresh')).rejects.toThrow(/Unknown command: feed/i)
    await expect(executeCommand(controller, 'bookmark add test')).rejects.toThrow(/Unknown command: bookmark/i)
    await expect(executeCommand(controller, 'list refresh')).rejects.toThrow(/Unknown command: list/i)
    await expect(executeCommand(controller, 'search notes hello')).rejects.toThrow(/Unknown command: search/i)
  })
})
