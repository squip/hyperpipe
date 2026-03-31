import { THtmlDocumentAnalysis } from '@/types'

function toOptionalString(value?: string | null) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized ? normalized : null
}

function resolveAttributeUrl(value: string | null, baseUrl: string) {
  const normalized = toOptionalString(value)
  if (!normalized) return null

  try {
    const resolved = new URL(normalized, baseUrl)
    if (!['http:', 'https:'].includes(resolved.protocol)) return null
    return resolved.toString()
  } catch {
    return null
  }
}

function resolveOrigin(value: string | null, baseUrl: string, baseOrigin: string | null) {
  const resolved = resolveAttributeUrl(value, baseUrl)
  if (!resolved) return null

  try {
    const origin = new URL(resolved).origin
    if (!origin || origin === 'null') return null
    if (baseOrigin && origin === baseOrigin) return null
    return origin
  } catch {
    return null
  }
}

function getMetaContent(doc: Document, selectors: string[]) {
  for (const selector of selectors) {
    const value = toOptionalString(doc.querySelector(selector)?.getAttribute('content'))
    if (value) return value
  }
  return null
}

function getDocumentTitle(doc: Document) {
  return (
    getMetaContent(doc, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]'
    ])
    || toOptionalString(doc.querySelector('title')?.textContent)
  )
}

function getDocumentDescription(doc: Document) {
  return (
    getMetaContent(doc, [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]'
    ])
  )
}

function getDocumentImage(doc: Document, baseUrl: string) {
  const metaImage =
    getMetaContent(doc, [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[property="og:image:url"]'
    ])
    || toOptionalString(doc.querySelector('link[rel="image_src"]')?.getAttribute('href'))
  return resolveAttributeUrl(metaImage, baseUrl)
}

export function extractDeclaredExternalOrigins(doc: Document, baseUrl: string) {
  let baseOrigin: string | null = null
  try {
    baseOrigin = new URL(baseUrl).origin
  } catch {
    baseOrigin = null
  }

  const candidates: Array<[string, string]> = [
    ['script[src]', 'src'],
    ['link[href]', 'href'],
    ['img[src]', 'src'],
    ['iframe[src]', 'src'],
    ['video[src]', 'src'],
    ['audio[src]', 'src'],
    ['source[src]', 'src']
  ]

  const origins = new Set<string>()
  candidates.forEach(([selector, attribute]) => {
    doc.querySelectorAll(selector).forEach((node) => {
      const origin = resolveOrigin(node.getAttribute(attribute), baseUrl, baseOrigin)
      if (origin) origins.add(origin)
    })
  })

  return Array.from(origins).sort((left, right) => left.localeCompare(right))
}

export function parseHtmlDocumentAnalysis(
  htmlSource: string,
  doc: Document,
  sourceUrl: string
): THtmlDocumentAnalysis {
  const title = getDocumentTitle(doc)
  const description = getDocumentDescription(doc)
  const image = getDocumentImage(doc, sourceUrl)
  const declaredExternalOrigins = extractDeclaredExternalOrigins(doc, sourceUrl)

  return {
    htmlSource,
    title,
    description,
    image,
    declaredExternalOrigins,
    hasMetaPreview: Boolean(title || description || image)
  }
}
