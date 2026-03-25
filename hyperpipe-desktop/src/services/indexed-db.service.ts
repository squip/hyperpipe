import { APP_INDEXED_DB_NAME } from '@/constants'
import { TRelayInfo } from '@/types'
import {
  TPersistedGroupMembershipRecord,
  TPersistedGroupMetadataRecord
} from '@/types/groups'
import { NostrUser } from '@nostr/gadgets/metadata'

type TValue<T = any> = {
  key: string
  value: T | null
  addedAt: number
}

const StoreNames = {
  RELAY_INFOS: 'relayInfos',
  GROUP_MEMBERSHIP_CACHE: 'groupMembershipCache',
  GROUP_METADATA_CACHE: 'groupMetadataCache'
}

class IndexedDbService {
  static instance: IndexedDbService
  static getInstance(): IndexedDbService {
    if (!IndexedDbService.instance) {
      IndexedDbService.instance = new IndexedDbService()
      IndexedDbService.instance.init()
    }
    return IndexedDbService.instance
  }

  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = new Promise((resolve, reject) => {
        const request = window.indexedDB.open(APP_INDEXED_DB_NAME, 11)

        request.onerror = (event) => {
          reject(event)
        }

        request.onsuccess = () => {
          this.db = request.result
          resolve()
        }

        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(StoreNames.RELAY_INFOS)) {
            db.createObjectStore(StoreNames.RELAY_INFOS, { keyPath: 'key' })
          }
          if (!db.objectStoreNames.contains(StoreNames.GROUP_MEMBERSHIP_CACHE)) {
            const store = db.createObjectStore(StoreNames.GROUP_MEMBERSHIP_CACHE, {
              keyPath: 'key'
            })
            store.createIndex('accountPubkey', 'accountPubkey', { unique: false })
          } else {
            const transaction = request.transaction
            if (transaction) {
              const store = transaction.objectStore(StoreNames.GROUP_MEMBERSHIP_CACHE)
              if (!store.indexNames.contains('accountPubkey')) {
                store.createIndex('accountPubkey', 'accountPubkey', { unique: false })
              }
            }
          }
          if (!db.objectStoreNames.contains(StoreNames.GROUP_METADATA_CACHE)) {
            const store = db.createObjectStore(StoreNames.GROUP_METADATA_CACHE, {
              keyPath: 'key'
            })
            store.createIndex('accountPubkey', 'accountPubkey', { unique: false })
          } else {
            const transaction = request.transaction
            if (transaction) {
              const store = transaction.objectStore(StoreNames.GROUP_METADATA_CACHE)
              if (!store.indexNames.contains('accountPubkey')) {
                store.createIndex('accountPubkey', 'accountPubkey', { unique: false })
              }
            }
          }
          this.db = db
        }
      })
      setTimeout(() => this.cleanUp(), 1000 * 60) // 1 minute
    }
    return this.initPromise
  }

  async getAllProfiles(): Promise<NostrUser[]> {
    const databases = await window.indexedDB.databases()
    if (!databases.find((idb) => idb.name === '@nostr/gadgets/metadata')) {
      // do not try to create this database if it doesn't exist, or idb-keyval breaks
      return []
    }

    return new Promise<NostrUser[]>((resolve, reject) => {
      const request = window.indexedDB.open('@nostr/gadgets/metadata')

      request.onerror = (event) => {
        reject(event)
      }

      request.onsuccess = () => {
        const db = request.result

        let transaction: IDBTransaction | undefined
        let getAllRequest: IDBRequest<any> | undefined
        try {
          transaction = db.transaction('cache', 'readonly')
          const store = transaction.objectStore('cache')
          getAllRequest = store.getAll()
        } catch (error) {
          transaction?.commit?.()
          db.close()
          reject(error)
          return
        }

        getAllRequest!.onsuccess = async (event) => {
          const values = (event.target as IDBRequest).result as NostrUser[]
          try {
            transaction!.commit()
            db.close()
            resolve(values)
          } catch (error) {
            transaction!.commit()
            db.close()
            reject(error)
          }
        }

        getAllRequest!.onerror = (event) => {
          transaction!.commit()
          db.close()
          reject(event)
        }
      }
    })
  }

  async putRelayInfo(relayInfo: TRelayInfo): Promise<void> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.RELAY_INFOS, 'readwrite')
      const store = transaction.objectStore(StoreNames.RELAY_INFOS)

      const putRequest = store.put(this.formatValue(relayInfo.url, relayInfo))
      putRequest.onsuccess = () => {
        transaction.commit()
        resolve()
      }

      putRequest.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async getRelayInfo(url: string): Promise<TRelayInfo | null> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.RELAY_INFOS, 'readonly')
      const store = transaction.objectStore(StoreNames.RELAY_INFOS)
      const request = store.get(url)

      request.onsuccess = () => {
        transaction.commit()
        resolve((request.result as TValue<TRelayInfo>)?.value)
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async getAllGroupMembershipCache(
    accountPubkey: string
  ): Promise<TPersistedGroupMembershipRecord[]> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_MEMBERSHIP_CACHE, 'readonly')
      const store = transaction.objectStore(StoreNames.GROUP_MEMBERSHIP_CACHE)
      const index = store.index('accountPubkey')
      const request = index.getAll(String(accountPubkey || '').trim())

      request.onsuccess = () => {
        transaction.commit()
        resolve((request.result || []) as TPersistedGroupMembershipRecord[])
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async getGroupMembershipCache(
    accountPubkey: string,
    groupId: string,
    relayBase?: string | null
  ): Promise<TPersistedGroupMembershipRecord | null> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_MEMBERSHIP_CACHE, 'readonly')
      const store = transaction.objectStore(StoreNames.GROUP_MEMBERSHIP_CACHE)
      const key = `${String(accountPubkey || '').trim()}|${String(relayBase || '').trim()}|${String(groupId || '').trim()}`
      const request = store.get(key)

      request.onsuccess = () => {
        transaction.commit()
        resolve((request.result as TPersistedGroupMembershipRecord) || null)
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async putGroupMembershipCache(record: TPersistedGroupMembershipRecord): Promise<void> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_MEMBERSHIP_CACHE, 'readwrite')
      const store = transaction.objectStore(StoreNames.GROUP_MEMBERSHIP_CACHE)
      const putRequest = store.put({
        ...record,
        persistedAt: Date.now()
      } as TPersistedGroupMembershipRecord)

      putRequest.onsuccess = () => {
        transaction.commit()
        resolve()
      }

      putRequest.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async deleteGroupMembershipCache(
    accountPubkey: string,
    groupId: string,
    relayBase?: string | null
  ): Promise<void> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_MEMBERSHIP_CACHE, 'readwrite')
      const store = transaction.objectStore(StoreNames.GROUP_MEMBERSHIP_CACHE)

      if (relayBase) {
        const key = `${String(accountPubkey || '').trim()}|${String(relayBase || '').trim()}|${String(groupId || '').trim()}`
        const request = store.delete(key)
        request.onsuccess = () => {
          transaction.commit()
          resolve()
        }
        request.onerror = (event) => {
          transaction.commit()
          reject(event)
        }
        return
      }

      const index = store.index('accountPubkey')
      const request = index.openCursor(IDBKeyRange.only(String(accountPubkey || '').trim()))
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
        if (!cursor) {
          transaction.commit()
          resolve()
          return
        }
        const value = cursor.value as TPersistedGroupMembershipRecord
        if (String(value.groupId || '').trim() === String(groupId || '').trim()) {
          cursor.delete()
        }
        cursor.continue()
      }
      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async getAllGroupMetadataCache(accountPubkey: string): Promise<TPersistedGroupMetadataRecord[]> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_METADATA_CACHE, 'readonly')
      const store = transaction.objectStore(StoreNames.GROUP_METADATA_CACHE)
      const index = store.index('accountPubkey')
      const request = index.getAll(String(accountPubkey || '').trim())

      request.onsuccess = () => {
        transaction.commit()
        resolve((request.result || []) as TPersistedGroupMetadataRecord[])
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async getGroupMetadataCache(
    accountPubkey: string,
    groupId: string
  ): Promise<TPersistedGroupMetadataRecord | null> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_METADATA_CACHE, 'readonly')
      const store = transaction.objectStore(StoreNames.GROUP_METADATA_CACHE)
      const key = `${String(accountPubkey || '').trim()}|${String(groupId || '').trim()}`
      const request = store.get(key)

      request.onsuccess = () => {
        transaction.commit()
        resolve((request.result as TPersistedGroupMetadataRecord) || null)
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async putGroupMetadataCache(record: TPersistedGroupMetadataRecord): Promise<void> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_METADATA_CACHE, 'readwrite')
      const store = transaction.objectStore(StoreNames.GROUP_METADATA_CACHE)
      const putRequest = store.put({
        ...record,
        persistedAt: Date.now()
      } as TPersistedGroupMetadataRecord)

      putRequest.onsuccess = () => {
        transaction.commit()
        resolve()
      }

      putRequest.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  async deleteGroupMetadataCache(accountPubkey: string, groupId: string): Promise<void> {
    await this.initPromise
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject('database not initialized')
      }
      const transaction = this.db.transaction(StoreNames.GROUP_METADATA_CACHE, 'readwrite')
      const store = transaction.objectStore(StoreNames.GROUP_METADATA_CACHE)
      const key = `${String(accountPubkey || '').trim()}|${String(groupId || '').trim()}`
      const request = store.delete(key)

      request.onsuccess = () => {
        transaction.commit()
        resolve()
      }

      request.onerror = (event) => {
        transaction.commit()
        reject(event)
      }
    })
  }

  private formatValue<T>(key: string, value: T): TValue<T> {
    return {
      key,
      value,
      addedAt: Date.now()
    }
  }

  private async cleanUp() {
    await this.initPromise
    if (!this.db) {
      return
    }

    const stores = [
      {
        name: StoreNames.RELAY_INFOS,
        expirationTimestamp: Date.now() - 1000 * 60 * 60 * 24, // 1 day
        getTimestamp: (value: TValue) => value.addedAt
      },
      {
        name: StoreNames.GROUP_MEMBERSHIP_CACHE,
        expirationTimestamp: Date.now() - 1000 * 60 * 60 * 24 * 30, // 30 days
        getTimestamp: (value: TPersistedGroupMembershipRecord) => value.persistedAt
      },
      {
        name: StoreNames.GROUP_METADATA_CACHE,
        expirationTimestamp: Date.now() - 1000 * 60 * 60 * 24 * 30, // 30 days
        getTimestamp: (value: TPersistedGroupMetadataRecord) => value.persistedAt
      }
    ]
    const transaction = this.db!.transaction(
      stores.map((store) => store.name),
      'readwrite'
    )
    await Promise.allSettled(
      stores.map(({ name, expirationTimestamp, getTimestamp }) => {
        if (expirationTimestamp < 0) {
          return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
          const store = transaction.objectStore(name)
          const request = store.openCursor()
          request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result
            if (cursor) {
              const value = cursor.value
              const timestamp = Number(getTimestamp(value))
              if (Number.isFinite(timestamp) && timestamp < expirationTimestamp) {
                cursor.delete()
              }
              cursor.continue()
            } else {
              resolve()
            }
          }

          request.onerror = (event) => {
            reject(event)
          }
        })
      })
    )
  }
}

const instance = IndexedDbService.getInstance()
export default instance
