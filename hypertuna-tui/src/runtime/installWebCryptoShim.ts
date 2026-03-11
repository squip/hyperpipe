import nodeCrypto from 'node:crypto'

const hasGlobalWebCrypto = (
  typeof globalThis.crypto !== 'undefined'
  && typeof globalThis.crypto?.getRandomValues === 'function'
  && typeof globalThis.crypto?.subtle !== 'undefined'
)

if (!hasGlobalWebCrypto && nodeCrypto.webcrypto) {
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: nodeCrypto.webcrypto,
      configurable: true,
      writable: true
    })
  } catch {
    // Fallback for runtimes where defineProperty on globalThis is restricted.
    ;(globalThis as { crypto?: Crypto }).crypto = nodeCrypto.webcrypto as Crypto
  }
}
