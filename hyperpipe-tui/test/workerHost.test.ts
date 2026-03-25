import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerHost } from '../src/runtime/workerHost.js'

const PUBKEY = '1'.repeat(64)
const NSEC = '2'.repeat(64)

describe('WorkerHost', () => {
  it('starts, sends requests, and stops', async () => {
    const host = new WorkerHost()
    const fixtureRoot = path.resolve(process.cwd(), 'test/fixtures')
    const storageDir = path.join(os.tmpdir(), 'hypertuna-tui-test-storage')

    const started = await host.start({
      workerRoot: fixtureRoot,
      workerEntry: path.join(fixtureRoot, 'echo-worker.js'),
      storageDir,
      config: {
        nostr_pubkey_hex: PUBKEY,
        nostr_nsec_hex: NSEC,
        userKey: PUBKEY
      }
    })

    expect(started.success).toBe(true)

    const response = await host.request<{ echoType: string; payload: { key: string } }>(
      {
        type: 'echo',
        data: { key: 'value' }
      },
      2_000
    )

    expect(response.echoType).toBe('echo')
    expect(response.payload).toEqual({ key: 'value' })

    await host.stop()
  })

  it('throws for worker failures and timeouts', async () => {
    const host = new WorkerHost()
    const fixtureRoot = path.resolve(process.cwd(), 'test/fixtures')
    const storageDir = path.join(os.tmpdir(), 'hypertuna-tui-test-storage-timeout')

    const started = await host.start({
      workerRoot: fixtureRoot,
      workerEntry: path.join(fixtureRoot, 'echo-worker.js'),
      storageDir,
      config: {
        nostr_pubkey_hex: PUBKEY,
        nostr_nsec_hex: NSEC,
        userKey: PUBKEY
      }
    })

    expect(started.success).toBe(true)

    await expect(
      host.request(
        {
          type: 'fail',
          data: {}
        },
        2_000
      )
    ).rejects.toThrow(/forced-failure/)

    await expect(
      host.request(
        {
          type: 'no-response',
          data: {}
        },
        1_100
      )
    ).rejects.toThrow(/timeout/i)

    await host.stop()
  })
})
