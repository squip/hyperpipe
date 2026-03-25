import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nip19, utils } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import { AccountService } from '../src/domain/accountService.js'

describe('AccountService', () => {
  it('supports nsec and ncryptsec flows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperpipe-tui-accounts-'))
    const filePath = path.join(root, 'accounts.json')

    const service = new AccountService(filePath)
    await service.waitUntilReady()

    const secretBytes = utils.hexToBytes('3'.repeat(64))
    const nsec = nip19.nsecEncode(secretBytes)
    const ncryptsec = nip49.encrypt(secretBytes, 'password123')

    const nsecAccount = await service.addNsecAccount(nsec, 'plain')
    expect(nsecAccount.signerType).toBe('nsec')

    const sessionPlain = await service.unlockAccount(nsecAccount.pubkey)
    expect(sessionPlain.pubkey).toBe(nsecAccount.pubkey)
    expect(sessionPlain.nsecHex).toBe('3'.repeat(64))

    const ncryptAccount = await service.addNcryptsecAccount(ncryptsec, 'password123', 'encrypted')
    expect(ncryptAccount.signerType).toBe('ncryptsec')

    const sessionEncrypted = await service.unlockAccount(
      ncryptAccount.pubkey,
      async () => 'password123'
    )
    expect(sessionEncrypted.pubkey).toBe(ncryptAccount.pubkey)
    expect(sessionEncrypted.nsecHex).toBe('3'.repeat(64))
  })
})
