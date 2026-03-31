import {
  createDefaultSharedFeedFilterSettings,
  restoreSharedFeedFilterSettings,
  toStoredSharedFeedFilterSettings,
  type TSharedFeedFilterPage,
  type TSharedFeedFilterSettings
} from '@/lib/shared-feed-filters'
import { createTimeFrameOptions } from '@/lib/time-frame'
import { useNostr } from '@/providers/NostrProvider'
import storage from '@/services/local-storage.service'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function useSharedFeedFilterSettings(page: TSharedFeedFilterPage) {
  const { t } = useTranslation()
  const { pubkey } = useNostr()
  const timeFrameOptions = useMemo(() => createTimeFrameOptions(t), [t])

  const readSettings = useCallback(() => {
    const storedSettings = storage.getSharedFeedFilterSettings(pubkey, page)
    return {
      storedSettings,
      resolvedSettings: storedSettings
        ? restoreSharedFeedFilterSettings(storedSettings, page, timeFrameOptions)
        : createDefaultSharedFeedFilterSettings(page, timeFrameOptions)
    }
  }, [page, pubkey, timeFrameOptions])

  const initial = useMemo(() => readSettings(), [readSettings])
  const [settings, setSettings] = useState<TSharedFeedFilterSettings>(initial.resolvedSettings)
  const [hasSavedSettings, setHasSavedSettings] = useState(Boolean(initial.storedSettings))

  useEffect(() => {
    const next = readSettings()
    setSettings(next.resolvedSettings)
    setHasSavedSettings(Boolean(next.storedSettings))
  }, [readSettings])

  const persistSettings = useCallback(
    (nextSettings: TSharedFeedFilterSettings) => {
      setSettings(nextSettings)
      storage.setSharedFeedFilterSettings(
        pubkey,
        page,
        toStoredSharedFeedFilterSettings(nextSettings)
      )
      setHasSavedSettings(true)
    },
    [page, pubkey]
  )

  const resetSettings = useCallback(
    (nextSettings?: TSharedFeedFilterSettings) => {
      const resolvedSettings =
        nextSettings || createDefaultSharedFeedFilterSettings(page, timeFrameOptions)
      persistSettings(resolvedSettings)
    },
    [page, persistSettings, timeFrameOptions]
  )

  return {
    settings,
    setSettings: persistSettings,
    resetSettings,
    timeFrameOptions,
    hasSavedSettings
  }
}
