import { detectLanguage } from '@/lib/utils'

export const UNKNOWN_LANGUAGE_CODE = 'unknown'

export const FILTER_LANGUAGE_LABELS: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fa: 'Persian',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  th: 'Thai',
  zh: 'Chinese',
  [UNKNOWN_LANGUAGE_CODE]: 'Unknown'
}

export const FILTER_LANGUAGE_CODES = Object.keys(FILTER_LANGUAGE_LABELS).filter(
  (code) => code !== UNKNOWN_LANGUAGE_CODE
)

export function getFilterLanguageLabel(code: string) {
  return FILTER_LANGUAGE_LABELS[code] || code.toUpperCase()
}

export function detectFilterLanguageCode(values: Array<string | null | undefined>) {
  const input = values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()

  if (!input) return UNKNOWN_LANGUAGE_CODE

  const detected = detectLanguage(input)
  if (!detected || detected === 'und') {
    return UNKNOWN_LANGUAGE_CODE
  }

  return detected
}

export function matchesSelectedLanguageCodes(
  values: Array<string | null | undefined>,
  selectedLanguageCodes: string[]
) {
  if (!selectedLanguageCodes.length) return true
  const detected = detectFilterLanguageCode(values)
  return selectedLanguageCodes.includes(detected)
}
