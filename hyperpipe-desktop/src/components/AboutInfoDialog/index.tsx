import { SecondaryPageLink } from '@/PageManager'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import ProfileCard from '@/components/ProfileCard'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APP_REPOSITORY_URL,
  DEV_DISPLAY_NAME,
  DEV_PUBKEY
} from '@/constants'
import { toProfile } from '@/lib/link'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { useState } from 'react'

export default function AboutInfoDialog({ children }: { children: React.ReactNode }) {
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)

  const content = (
    <>
      <div className="text-xl font-semibold">{APP_DISPLAY_NAME}</div>
      <div className="text-muted-foreground">{APP_DESCRIPTION}</div>
      <div>
        Made by <DeveloperProfileLink />
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

function DeveloperProfileLink() {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className="inline-flex">
          <SecondaryPageLink
            to={toProfile(DEV_PUBKEY)}
            className="text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            @{DEV_DISPLAY_NAME}
          </SecondaryPageLink>
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <ProfileCard userId={DEV_PUBKEY} />
      </HoverCardContent>
    </HoverCard>
  )
}
