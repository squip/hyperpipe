import GroupFilesTable from '@/components/GroupFilesTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { useGroupFiles } from '@/providers/GroupFilesProvider'
import { TPageRef } from '@/types'
import { Files, Loader2, Search } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const FilesPage = forwardRef<TPageRef>((_, ref) => {
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current!)
  const { t } = useTranslation()
  const { records, isLoading, refresh, lastUpdated } = useGroupFiles()
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PrimaryPageLayout
      pageName="files"
      ref={layoutRef}
      titlebar={<FilesPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('Search files...') as string}
              className="pl-9"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('Refresh') as string}
          >
            <Loader2 className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <GroupFilesTable
          records={records}
          loading={isLoading}
          showGroupColumn
          searchQuery={search}
          emptyLabel={t('No files uploaded yet')}
          defaultSortKey="uploadedAt"
          defaultSortDirection="desc"
        />
        {lastUpdated ? (
          <div className="text-xs text-muted-foreground">
            {t('Last updated')}: {new Date(lastUpdated).toLocaleTimeString()}
          </div>
        ) : null}
      </div>
    </PrimaryPageLayout>
  )
})

FilesPage.displayName = 'FilesPage'

export default FilesPage

function FilesPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center h-full pl-3 [&_svg]:text-muted-foreground">
      <Files />
      <div className="text-lg font-semibold" style={{ fontSize: 'var(--title-font-size, 18px)' }}>
        {t('Files')}
      </div>
    </div>
  )
}
