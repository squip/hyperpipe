import test from 'brittle'
import WebSocketRelayManager from '../WebSocketRelayManager.js'

class FakeWebSocket {
  constructor (url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    FakeWebSocket.instances.push(this)
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN
      if (this.onopen) this.onopen()
    })
  }
  send () {}
  close () {
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose({ code: 1000 })
  }
}
FakeWebSocket.CONNECTING = 0
FakeWebSocket.OPEN = 1
FakeWebSocket.CLOSED = 3
FakeWebSocket.instances = []

test('reconnect when auth token changes', async t => {
  const OriginalWS = global.WebSocket
  global.WebSocket = FakeWebSocket

  const mgr = new WebSocketRelayManager()

  await mgr.addRelay('wss://example.com/relay?token=one')
  t.is(FakeWebSocket.instances.length, 1)
  const first = FakeWebSocket.instances[0]
  const entry1 = mgr.relays.get('wss://example.com/relay')
  t.ok(entry1)
  t.is(entry1.authToken, 'one')

  await mgr.addRelay('wss://example.com/relay?token=two')
  t.is(FakeWebSocket.instances.length, 2)
  t.is(first.readyState, FakeWebSocket.CLOSED)
  const entry2 = mgr.relays.get('wss://example.com/relay')
  t.ok(entry2)
  t.is(entry2.authToken, 'two')

  global.WebSocket = OriginalWS
})
