import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import { APP_DESCRIPTION, APP_DISPLAY_NAME, APP_REPOSITORY_URL, DEV_PUBKEY } from '@/constants'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { useState } from 'react'
import Username from '../Username'

export default function AboutInfoDialog({ children }: { children: React.ReactNode }) {
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)

  const content = (
    <>
      <div className="text-xl font-semibold">{APP_DISPLAY_NAME}</div>
      <div className="text-muted-foreground">{APP_DESCRIPTION}</div>
      <div>
        Made by <Username userId={DEV_PUBKEY} className="inline-block text-primary" showAt />
      </div>
      <div>
        Source code:{' '}
        <a
          href={APP_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          GitHub
        </a>
        <div className="text-sm text-muted-foreground">
          If this build is useful, a star on the repository helps.
        </div>
      </div>
    </>
  )

  if (isSmallScreen) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{children}</DrawerTrigger>
        <DrawerContent>
          <div className="p-4 space-y-4">{content}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>{content}</DialogContent>
    </Dialog>
  )
}
