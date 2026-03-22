import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

if (typeof indexedDB.databases !== 'function') {
  indexedDB.databases = async () => []
}
