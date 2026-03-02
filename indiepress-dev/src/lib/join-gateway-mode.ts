export type TJoinGatewayMode = 'auto' | 'disabled'

export const JOIN_GATEWAY_MODE_TEST_OVERRIDE_KEY = 'hypertuna:test:join-gateway-mode'

export function isJoinGatewayModeTestToggleVisible() {
  return process.env.NODE_ENV === 'development'
}

export function readJoinGatewayModeForTesting(): TJoinGatewayMode {
  if (typeof window === 'undefined') return 'auto'
  try {
    const raw = String(window.localStorage.getItem(JOIN_GATEWAY_MODE_TEST_OVERRIDE_KEY) || '')
      .trim()
      .toLowerCase()
    return raw === 'disabled' ? 'disabled' : 'auto'
  } catch (_err) {
    return 'auto'
  }
}

export function writeJoinGatewayModeForTesting(mode: TJoinGatewayMode) {
  if (typeof window === 'undefined') return
  try {
    if (mode === 'disabled') {
      window.localStorage.setItem(JOIN_GATEWAY_MODE_TEST_OVERRIDE_KEY, 'disabled')
      return
    }
    window.localStorage.removeItem(JOIN_GATEWAY_MODE_TEST_OVERRIDE_KEY)
  } catch (_err) {
    // best effort
  }
}
