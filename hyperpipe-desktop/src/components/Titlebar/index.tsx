import { isMacDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'

export function Titlebar({
  children,
  className,
  hideBottomBorder = false
}: {
  children?: React.ReactNode
  className?: string
  hideBottomBorder?: boolean
}) {
  const macDesktop = isMacDesktop()

  return (
    <div
      className={cn(
        'desktop-titlebar sticky top-0 z-40 flex h-12 w-full items-center bg-background [&_svg]:size-5 [&_svg]:shrink-0 select-none',
        !hideBottomBorder && 'border-b',
        className,
        macDesktop && 'pl-[88px] pr-2'
      )}
    >
      {children}
    </div>
  )
}
