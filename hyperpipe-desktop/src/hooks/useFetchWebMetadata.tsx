import { TWebMetadata } from '@/types'
import { useEffect, useState } from 'react'
import webService from '@/services/web.service'

export function useFetchWebMetadata(url: string) {
  const [metadata, setMetadata] = useState<TWebMetadata>({})
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    let cancelled = false
    webService
      .fetchWebMetadata(url)
      .then((metadata) => {
        if (cancelled) return
        setMetadata(metadata)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('Failed to fetch web metadata', error)
        setMetadata({})
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  return { ...metadata, isLoading }
}
