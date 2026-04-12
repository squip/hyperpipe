export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function isWeb(): boolean {
  return !isElectron()
}

export function isMacDesktop(): boolean {
  if (!isElectron() || typeof navigator === 'undefined') return false
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  return /mac/i.test(platform)
}
