import test from 'brittle'
import NostrGroupClient from '../NostrGroupClient.js'

class DummyRelayManager {
  constructor () {
    this.added = []
  }
  async addTypedRelay (url, type, id) {
    this.added.push({ url, type, id })
  }
  on () {}
}

test('store auth token from membership event and use in connection', async t => {
  global.window = {}
  const client = new NostrGroupClient(false)
  client.user = { pubkey: 'alice' }
  client.relayManager = new DummyRelayManager()

  const event = {
    kind: 9000,
    created_at: 0,
    tags: [
      ['h', 'group1'],
      ['p', 'alice', 'member', 'tok123']
    ]
  }

  client._processGroupAddUserEvent(event)
  t.is(client.relayAuthTokens.get('group1'), 'tok123')

  await client.connectToGroupRelay('group1', 'wss://relay.example.com')
  t.is(client.relayManager.added[0].url, 'wss://relay.example.com?token=tok123')
})
