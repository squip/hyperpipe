import os from 'node:os'
import path from 'node:path'

function platformUserDataRoot(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    const appData = String(process.env.APPDATA || '').trim()
    return appData || path.join(os.homedir(), 'AppData', 'Roaming')
  }
  const xdgConfigHome = String(process.env.XDG_CONFIG_HOME || '').trim()
  return xdgConfigHome || path.join(os.homedir(), '.config')
}

export function resolveDesktopParityStorageDir(cwd: string): string {
  const explicit = String(process.env.HYPERTUNA_STORAGE_DIR || process.env.HYPERTUNA_DATA_DIR || '').trim()
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit)
  }
  const userDataRoot = platformUserDataRoot()
  return path.join(userDataRoot, 'hypertuna-desktop', 'hypertuna-data')
}
