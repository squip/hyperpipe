import { TRelayInfo } from '@/types'
import { FILTER_LANGUAGE_LABELS } from '@/lib/language'

export function checkSearchRelay(relayInfo: TRelayInfo | undefined) {
  return relayInfo?.supported_nips?.includes(50)
}

export function checkNip43Support(relayInfo: TRelayInfo | undefined) {
  return relayInfo?.supported_nips?.includes(43) && !!relayInfo.pubkey
}

export function getRelayDisplayName(relayInfo: TRelayInfo | undefined): string {
  if (!relayInfo) {
    return ''
  }

  const langMatch = relayInfo.url.match(/lang\.relays\.land\/([a-z]{2})$/i)
  if (langMatch) {
    const langCode = langMatch[1].toLowerCase()
    const languageName = FILTER_LANGUAGE_LABELS[langCode]
    if (languageName) {
      return languageName
    }
  }

  return relayInfo.name || relayInfo.shortUrl
}
