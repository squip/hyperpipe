import { THtmlDocumentAnalysis } from '@/types'
import { useEffect, useState } from 'react'
import webService from '@/services/web.service'

export function useFetchHtmlAnalysis(url: string) {
  const [analysis, setAnalysis] = useState<THtmlDocumentAnalysis>({})
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    let cancelled = false
    webService
      .fetchHtmlAnalysis(url, { suppressErrors: true })
      .then((nextAnalysis) => {
        if (cancelled) return
        setAnalysis(nextAnalysis)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('Failed to fetch HTML analysis', error)
        setAnalysis({})
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  return { ...analysis, isLoading }
}
