import { getPublicKey, nip19, utils } from 'nostr-tools'
import * as nip49 from 'nostr-tools/nip49'
import type { AccountRecord, AccountService as IAccountService, AccountSession } from './types.js'
import {
  accountsFileSchema,
  defaultAccountsFile,
  type AccountsFile
} from '../storage/schema.js'
import { readJsonFile, writeJsonFile } from '../storage/jsonStore.js'

function isHex64(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

function decodeNsecToSecretBytes(nsecValue: string): Uint8Array {
  const decoded = nip19.decode(nsecValue.trim())
  if (decoded.type !== 'nsec') {
    throw new Error('Expected nsec credential')
  }
  return decoded.data
}

function decodeNcryptsec(ncryptsec: string, password: string): Uint8Array {
  try {
    return nip49.decrypt(ncryptsec.trim(), password)
  } catch (error) {
    throw new Error(`Failed to decrypt ncryptsec: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export class AccountService implements IAccountService {
  private filePath: string
  private state: AccountsFile = defaultAccountsFile()
  private ready: Promise<void>

  constructor(filePath: string) {
    this.filePath = filePath
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    this.state = await readJsonFile(this.filePath, accountsFileSchema, defaultAccountsFile)
  }

  private async flush(): Promise<void> {
    await writeJsonFile(this.filePath, this.state)
  }

  private async ensureReady(): Promise<void> {
    await this.ready
  }

  async waitUntilReady(): Promise<void> {
    await this.ensureReady()
  }

  listAccounts(): AccountRecord[] {
    return this.state.accounts.map((entry) => ({ ...entry }))
  }

  getCurrentAccountPubkey(): string | null {
    return this.state.currentPubkey ?? null
  }

  async setCurrentAccount(pubkey: string | null): Promise<void> {
    await this.ensureReady()
    if (pubkey === null) {
      this.state.currentPubkey = null
      await this.flush()
      return
    }

    const normalized = normalizePubkey(pubkey)
    if (!this.state.accounts.some((entry) => entry.pubkey === normalized)) {
      throw new Error('Account not found')
    }

    this.state.currentPubkey = normalized
    await this.flush()
  }

  async addNsecAccount(nsec: string, label?: string): Promise<AccountRecord> {
    await this.ensureReady()

    const secret = decodeNsecToSecretBytes(nsec)
    const pubkey = normalizePubkey(getPublicKey(secret))
    const nsecEncoded = nip19.nsecEncode(secret)
    const now = Date.now()

    const account: AccountRecord = {
      pubkey,
      userKey: pubkey,
      signerType: 'nsec',
      nsec: nsecEncoded,
      label: label?.trim() || undefined,
      createdAt: now,
      updatedAt: now
    }

    const existingIndex = this.state.accounts.findIndex((entry) => entry.pubkey === pubkey)
    if (existingIndex >= 0) {
      this.state.accounts[existingIndex] = {
        ...this.state.accounts[existingIndex],
        ...account,
        createdAt: this.state.accounts[existingIndex].createdAt,
        updatedAt: now
      }
    } else {
      this.state.accounts.push(account)
    }

    this.state.currentPubkey = pubkey
    await this.flush()

    return { ...account }
  }

  async addNcryptsecAccount(ncryptsec: string, password: string, label?: string): Promise<AccountRecord> {
    await this.ensureReady()

    if (!password) {
      throw new Error('Password is required for ncryptsec account import')
    }

    const secret = decodeNcryptsec(ncryptsec, password)
    const pubkey = normalizePubkey(getPublicKey(secret))
    const now = Date.now()

    const account: AccountRecord = {
      pubkey,
      userKey: pubkey,
      signerType: 'ncryptsec',
      ncryptsec: ncryptsec.trim(),
      label: label?.trim() || undefined,
      createdAt: now,
      updatedAt: now
    }

    const existingIndex = this.state.accounts.findIndex((entry) => entry.pubkey === pubkey)
    if (existingIndex >= 0) {
      this.state.accounts[existingIndex] = {
        ...this.state.accounts[existingIndex],
        ...account,
        createdAt: this.state.accounts[existingIndex].createdAt,
        updatedAt: now
      }
    } else {
      this.state.accounts.push(account)
    }

    this.state.currentPubkey = pubkey
    await this.flush()

    return { ...account }
  }

  async removeAccount(pubkey: string): Promise<void> {
    await this.ensureReady()
    const normalized = normalizePubkey(pubkey)

    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((entry) => entry.pubkey !== normalized)

    if (this.state.accounts.length === before) return

    if (this.state.currentPubkey === normalized) {
      this.state.currentPubkey = this.state.accounts[0]?.pubkey || null
    }

    await this.flush()
  }

  async unlockAccount(pubkey: string, getPassword?: () => Promise<string>): Promise<AccountSession> {
    await this.ensureReady()
    const normalized = normalizePubkey(pubkey)

    const account = this.state.accounts.find((entry) => entry.pubkey === normalized)
    if (!account) {
      throw new Error('Account not found')
    }

    let secret: Uint8Array
    let signerType = account.signerType

    if (account.signerType === 'nsec') {
      if (!account.nsec) {
        throw new Error('nsec account missing nsec payload')
      }
      secret = decodeNsecToSecretBytes(account.nsec)
    } else {
      if (!account.ncryptsec) {
        throw new Error('ncryptsec account missing ncryptsec payload')
      }
      if (!getPassword) {
        throw new Error('Password prompt unavailable for ncryptsec account')
      }
      const password = await getPassword()
      if (!password) {
        throw new Error('Password is required')
      }
      secret = decodeNcryptsec(account.ncryptsec, password)
      signerType = 'ncryptsec'
    }

    const pubkeyHex = normalizePubkey(getPublicKey(secret))
    if (!isHex64(pubkeyHex) || pubkeyHex !== normalized) {
      throw new Error('Decrypted key does not match account pubkey')
    }

    const nsecHex = utils.bytesToHex(secret)
    if (!isHex64(nsecHex)) {
      throw new Error('Invalid derived nsec hex')
    }

    const nsec = nip19.nsecEncode(secret)

    return {
      pubkey: pubkeyHex,
      userKey: pubkeyHex,
      nsecHex,
      nsec,
      signerType
    }
  }
}
