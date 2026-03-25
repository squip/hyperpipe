process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return

  if (message.type === 'config') {
    process.send?.({
      type: 'status',
      phase: 'config-applied',
      message: 'config received'
    })
    return
  }

  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }

  if (message.type === 'no-response') {
    return
  }

  const requestId = typeof message.requestId === 'string' ? message.requestId : null
  if (!requestId) return

  if (message.type === 'fail') {
    process.send?.({
      type: 'worker-response',
      requestId,
      success: false,
      error: 'forced-failure'
    })
    return
  }

  process.send?.({
    type: 'worker-response',
    requestId,
    success: true,
    data: {
      echoType: message.type,
      payload: message.data || null
    }
  })
})

setInterval(() => {
  // keep process alive for integration tests
}, 1000)
