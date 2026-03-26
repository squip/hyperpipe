import { parseHtmlDocumentAnalysis } from '@/lib/html-preview'
import { THtmlDocumentAnalysis, TWebMetadata } from '@/types'
import DataLoader from 'dataloader'

class WebService {
  static instance: WebService

  private htmlAnalysisDataLoader = new DataLoader<string, THtmlDocumentAnalysis>(
    async (urls) => {
      return await Promise.all(
        urls.map(async (url) => {
          try {
            const proxyServer = import.meta.env.VITE_PROXY_SERVER
            const requestUrl = proxyServer
              ? `${proxyServer}/sites/${encodeURIComponent(url)}`
              : url
            const res = await fetch(requestUrl)
            const html = await res.text()
            const parser = new DOMParser()
            const doc = parser.parseFromString(html, 'text/html')
            return parseHtmlDocumentAnalysis(html, doc, url)
          } catch {
            return {}
          }
        })
      )
    },
    { maxBatchSize: 1 }
  )

  constructor() {
    if (!WebService.instance) {
      WebService.instance = this
    }
    return WebService.instance
  }

  async fetchHtmlAnalysis(url: string) {
    return await this.htmlAnalysisDataLoader.load(url)
  }

  async fetchWebMetadata(url: string) {
    const analysis = await this.fetchHtmlAnalysis(url)
    return {
      title: analysis.title,
      description: analysis.description,
      image: analysis.image
    } satisfies TWebMetadata
  }
}

const instance = new WebService()

export default instance
