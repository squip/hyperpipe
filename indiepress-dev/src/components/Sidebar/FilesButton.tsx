import { usePrimaryPage } from '@/PageManager'
import { useGroupFiles } from '@/providers/GroupFilesProvider'
import { Files } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function FilesButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()
  const { count } = useGroupFiles()
  const label = count > 0 ? `Files (${count})` : 'Files'

  return (
    <SidebarItem
      title="Files"
      description={label}
      onClick={() => navigate('files')}
      active={display && current === 'files'}
      collapse={collapse}
    >
      <Files strokeWidth={1.3} />
    </SidebarItem>
  )
}
