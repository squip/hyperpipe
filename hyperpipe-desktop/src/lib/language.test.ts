import {
  detectFilterLanguageCode,
  matchesSelectedLanguageCodes,
  UNKNOWN_LANGUAGE_CODE
} from '@/lib/language'

describe('shared feed language helpers', () => {
  it('detects deterministic language matches from input content', () => {
    expect(detectFilterLanguageCode(['これは日本語のテキストです。'])).toBe('ja')
    expect(matchesSelectedLanguageCodes(['これは日本語のテキストです。'], ['ja'])).toBe(true)
    expect(matchesSelectedLanguageCodes(['これは日本語のテキストです。'], ['en'])).toBe(false)
  })

  it('maps empty or non-linguistic content to the unknown language bucket', () => {
    expect(detectFilterLanguageCode(['https://example.com'])).toBe(UNKNOWN_LANGUAGE_CODE)
    expect(matchesSelectedLanguageCodes(['https://example.com'], [UNKNOWN_LANGUAGE_CODE])).toBe(
      true
    )
  })
})
