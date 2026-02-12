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
  it('feature 1: relay discovery/default/custom set lifecycle', async () => {
    const controller = createController()

    const initialRelayCount = controller.getState().relays.length

    const refreshResult = await executeCommand(controller, 'relay refresh')
    expect(refreshResult.message).toContain('Relays refreshed')

    await executeCommand(controller, 'relay create devgroup --public --open --desc dev_group')
    const afterCreate = controller.getState()
    expect(afterCreate.relays.length).toBe(initialRelayCount + 1)
    expect(afterCreate.groups.some((group) => group.name === 'devgroup')).toBe(true)

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

  it('feature 2: feed subscribe and browse refresh output', async () => {
    const controller = createController()

    const result = await executeCommand(controller, 'feed refresh 8')
    expect(result.message).toContain('Feed refreshed')

    const state = controller.getState()
    expect(state.feed.length).toBe(8)
    expect(state.feed[0]?.content).toContain('feed message')
  })

  it('feature 3: publish post/reply/reaction and feature 9 bookmark flow', async () => {
    const controller = createController()

    await executeCommand(controller, 'feed refresh 4')
    const firstFeed = controller.getState().feed[0]
    expect(firstFeed).toBeTruthy()

    await executeCommand(controller, 'post e2e_post_content')
    await executeCommand(controller, `reply ${firstFeed?.id} ${firstFeed?.pubkey} e2e_reply_content`)
    await executeCommand(controller, `react ${firstFeed?.id} ${firstFeed?.pubkey} +`)

    const stateAfterPublish = controller.getState()
    expect(stateAfterPublish.feed[0]?.kind).toBe(7)
    expect(stateAfterPublish.feed.some((event) => event.content === 'e2e_post_content')).toBe(true)
    expect(stateAfterPublish.feed.some((event) => event.content === 'e2e_reply_content')).toBe(true)

    await executeCommand(controller, `bookmark add ${firstFeed?.id}`)
    expect(controller.getState().bookmarks.eventIds).toContain(firstFeed?.id)

    await executeCommand(controller, `bookmark remove ${firstFeed?.id}`)
    expect(controller.getState().bookmarks.eventIds).not.toContain(firstFeed?.id)
  })

  it('feature 4: create public/private open/closed group relay instances', async () => {
    const controller = createController()

    await executeCommand(controller, 'relay create closedgroup --private --closed --no-file-sharing --desc locked')
    await executeCommand(controller, 'relay create publicgroup --public --open --file-sharing --desc open')

    const state = controller.getState()
    const closed = state.groups.find((group) => group.name === 'closedgroup')
    const opened = state.groups.find((group) => group.name === 'publicgroup')

    expect(closed).toBeTruthy()
    expect(closed?.isPublic).toBe(false)
    expect(closed?.isOpen).toBe(false)

    expect(opened).toBeTruthy()
    expect(opened?.isPublic).toBe(true)
    expect(opened?.isOpen).toBe(true)
  })

  it('feature 5: discover and join external groups / p2p relays', async () => {
    const controller = createController()

    await executeCommand(controller, 'group refresh')
    expect(controller.getState().groups.length).toBeGreaterThan(0)

    await executeCommand(controller, 'group join-flow npubexternal:groupflow token-flow --open')
    await executeCommand(controller, 'relay join npubexternal:groupflow token-flow')

    const state = controller.getState()
    expect(state.logs.some((log) => log.message.includes('join-flow:npubexternal:groupflow'))).toBe(true)
    expect(state.relays.some((relay) => relay.publicIdentifier === 'npubexternal:groupflow')).toBe(true)
  })

  it('feature 6: invites and admin-controlled membership/auth updates', async () => {
    const controller = createController()

    await executeCommand(controller, 'group refresh')
    const groupId = controller.getState().groups[0]?.id
    expect(groupId).toBeTruthy()

    const beforeInvites = controller.getState().invites.length
    const inviteePubkey = 'b'.repeat(64)

    await executeCommand(
      controller,
      `group invite ${groupId} wss://relay.damus.io/ ${inviteePubkey} token-invite`
    )

    const afterInvite = controller.getState()
    expect(afterInvite.invites.length).toBe(beforeInvites + 1)

    await executeCommand(controller, `group update-members ${groupId} add ${inviteePubkey}`)
    await executeCommand(controller, `group update-auth ${groupId} ${inviteePubkey} auth-token-1`)

    const logs = controller.getState().logs.map((entry) => entry.message)
    expect(logs.some((message) => message.includes('members-updated'))).toBe(true)
    expect(logs.some((message) => message.includes('auth-updated'))).toBe(true)
  })

  it('feature 7: group file upload/share listing and refresh', async () => {
    const controller = createController()

    const groupId = controller.getState().groups[0]?.id || 'npubseed:group-a'

    await executeCommand(controller, `file refresh ${groupId}`)
    const beforeUpload = controller.getState().files.length

    await executeCommand(controller, `file upload ${groupId} /tmp/e2e-upload.bin`)

    const state = controller.getState()
    expect(state.files.length).toBe(beforeUpload + 1)
    expect(state.files[0]?.fileName).toBe('e2e-upload.bin')
  })

  it('feature 8: follow-pack list discover/create/apply', async () => {
    const controller = createController()

    await executeCommand(controller, 'list refresh')
    expect(controller.getState().lists.length).toBeGreaterThan(0)

    await executeCommand(controller, 'list create team-pack TeamPack cccccccc,dddddddd,eeeeeeee')
    expect(controller.getState().lists.some((list) => list.id === 'team-pack')).toBe(true)

    await executeCommand(controller, 'list apply team-pack')
    expect(controller.getState().logs.some((entry) => entry.message.includes('starter-applied:team-pack'))).toBe(true)
  })

  it('feature 10: encrypted chat initialize/create/join/thread/send', async () => {
    const controller = createController()

    await executeCommand(controller, 'chat init')
    await executeCommand(controller, 'chat refresh')

    await executeCommand(controller, 'chat create E2EChat aaaaaaaa,bbbbbbbb')

    const inviteId = controller.getState().chatInvites[0]?.id
    expect(inviteId).toBeTruthy()

    await executeCommand(controller, `chat accept ${inviteId}`)

    const conversationId = controller.getState().conversations[0]?.id
    expect(conversationId).toBeTruthy()

    await executeCommand(controller, `chat thread ${conversationId}`)
    await executeCommand(controller, `chat send ${conversationId} e2e-chat-message`)

    const threadMessages = controller.getState().threadMessages
    expect(threadMessages.length).toBeGreaterThan(0)
    expect(threadMessages[threadMessages.length - 1]?.content).toBe('e2e-chat-message')
  })

  it('feature 11: global search across notes/profiles/groups/lists', async () => {
    const controller = createController()

    await executeCommand(controller, 'feed refresh 6')

    await executeCommand(controller, 'search notes feed')
    expect(controller.getState().searchMode).toBe('notes')
    expect(controller.getState().searchResults.length).toBeGreaterThan(0)

    await executeCommand(controller, 'search profiles feed')
    expect(controller.getState().searchMode).toBe('profiles')

    await executeCommand(controller, 'search groups feed')
    expect(controller.getState().searchMode).toBe('groups')

    await executeCommand(controller, 'search lists feed')
    expect(controller.getState().searchMode).toBe('lists')
  })

  it('feature 12: leave group relay with archive options and remove from relay set', async () => {
    const controller = createController()

    await executeCommand(controller, 'relay create leavegroup --public --open')
    const createdRelay = controller
      .getState()
      .relays.find((relay) => relay.publicIdentifier?.includes(':leavegroup'))
    expect(createdRelay).toBeTruthy()
    expect(createdRelay?.publicIdentifier).toBeTruthy()

    const relayCountBefore = controller.getState().relays.length

    await executeCommand(controller, `relay leave ${createdRelay?.publicIdentifier} --archive --save-files`)
    const afterIdentifierLeave = controller.getState()
    expect(afterIdentifierLeave.relays.length).toBe(relayCountBefore - 1)
    expect(afterIdentifierLeave.groups.some((group) => group.name === 'leavegroup')).toBe(false)
  })

  it('feature 13: multi-account switch, session isolation, and worker lifecycle', async () => {
    const controller = createController()

    const generated = await executeCommand(controller, 'account generate generated_profile')
    expect(generated.message).toContain('Generated profile')
    const generatedPubkey = controller.getState().currentAccountPubkey
    expect(generatedPubkey).toBeTruthy()
    expect(controller.getState().lifecycle).toBe('ready')

    const profilesMessage = await executeCommand(controller, 'account profiles')
    expect(profilesMessage.message).toContain('Profiles')

    await executeCommand(controller, 'account add-nsec nsec-e2e account_one')
    const accountOnePubkey = controller.getState().currentAccountPubkey
    expect(accountOnePubkey).toBeTruthy()
    expect(controller.getState().lifecycle).toBe('ready')

    await executeCommand(controller, 'account add-ncryptsec ncryptsec-e2e pass123 account_two')
    const accountTwoPubkey = controller.getState().currentAccountPubkey
    expect(accountTwoPubkey).toBeTruthy()
    expect(accountTwoPubkey).not.toBe(accountOnePubkey)

    await executeCommand(controller, 'account login account_one')
    expect(controller.getState().currentAccountPubkey).toBe(accountOnePubkey)
    expect(controller.getState().session?.pubkey).toBe(accountOnePubkey)

    await executeCommand(controller, 'worker restart')
    expect(controller.getState().lifecycle).toBe('ready')

    await executeCommand(controller, 'account clear')
    expect(controller.getState().session).toBeNull()
    expect(controller.getState().lifecycle).toBe('stopped')

    await executeCommand(controller, 'account login account_two pass123')
    expect(controller.getState().currentAccountPubkey).toBe(accountTwoPubkey)
    expect(controller.getState().session?.pubkey).toBe(accountTwoPubkey)

    await executeCommand(controller, `account remove ${accountTwoPubkey}`)
    expect(controller.getState().accounts.some((account) => account.pubkey === accountTwoPubkey)).toBe(false)
  })
})
