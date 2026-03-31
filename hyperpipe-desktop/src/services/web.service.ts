import { parseHtmlDocumentAnalysis } from '@/lib/html-preview'
import { THtmlDocumentAnalysis, TWebMetadata } from '@/types'
import DataLoader from 'dataloader'

type FetchHtmlAnalysisOptions = {
  force?: boolean
  suppressErrors?: boolean
}

class WebService {
  static instance: WebService

  private buildRequestUrl(url: string) {
    const proxyServer = import.meta.env.VITE_PROXY_SERVER
    return proxyServer
      ? `${proxyServer}/sites/${encodeURIComponent(url)}`
      : url
  }

  private async requestHtmlAnalysis(url: string): Promise<THtmlDocumentAnalysis> {
    const res = await fetch(this.buildRequestUrl(url), { cache: 'no-store' })
    if (!res.ok) {
      throw new Error(`HTML analysis request failed with status ${res.status}`)
    }
    const html = await res.text()
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    return parseHtmlDocumentAnalysis(html, doc, url)
  }

  private htmlAnalysisDataLoader = new DataLoader<string, THtmlDocumentAnalysis>(
    async (urls) => {
      return await Promise.all(urls.map((url) => this.requestHtmlAnalysis(url)))
    },
    { maxBatchSize: 1 }
  )

  constructor() {
    if (!WebService.instance) {
      WebService.instance = this
    }
    return WebService.instance
  }

  async fetchHtmlAnalysis(url: string, options: FetchHtmlAnalysisOptions = {}) {
    if (options.force) {
      this.htmlAnalysisDataLoader.clear(url)
    }

    try {
      return await this.htmlAnalysisDataLoader.load(url)
    } catch (error) {
      this.htmlAnalysisDataLoader.clear(url)
      if (options.suppressErrors) {
        return {}
      }
      throw error
    }
  }

  async fetchWebMetadata(url: string) {
    const analysis = await this.fetchHtmlAnalysis(url, { suppressErrors: true })
    return {
      title: analysis.title,
      description: analysis.description,
      image: analysis.image
    } satisfies TWebMetadata
  }
}

const instance = new WebService()

export default instance
