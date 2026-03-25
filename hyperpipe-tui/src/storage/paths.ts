import path from 'node:path'

export type StoragePaths = {
  rootDir: string
  accountsFile: string
  uiStateFile: string
  userCacheDir: string
}

export function resolveStoragePaths(rootDir: string): StoragePaths {
  const stateRoot = path.join(rootDir, 'tui-state')
  return {
    rootDir,
    accountsFile: path.join(stateRoot, 'accounts.json'),
    uiStateFile: path.join(stateRoot, 'ui-state.json'),
    userCacheDir: path.join(stateRoot, 'users')
  }
}
