import type { WorkerEvent } from './workerProtocol.js'
import type { WorkerHost } from './workerHost.js'

export async function waitForWorkerEvent(
  host: WorkerHost,
  predicate: (event: WorkerEvent) => boolean,
  timeoutMs = 30_000
): Promise<WorkerEvent> {
  const timeout = Math.max(1_000, Math.min(timeoutMs, 300_000))

  return await new Promise<WorkerEvent>((resolve, reject) => {
    const off = host.onMessage((event) => {
      if (!predicate(event)) return
      clearTimeout(timeoutId)
      off()
      resolve(event)
    })

    const timeoutId = setTimeout(() => {
      off()
      reject(new Error(`Timed out waiting for worker event after ${timeout}ms`))
    }, timeout)
  })
}
