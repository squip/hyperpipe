import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Info } from 'lucide-react'

export default function TitlebarInfoButton({
  label,
  content
}: {
  label: string
  content: string
}) {
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <Button variant="ghost" size="titlebar-icon" type="button" aria-label={label}>
          <Info />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="end" className="w-72 text-sm leading-snug">
        {content}
      </HoverCardContent>
    </HoverCard>
  )
}
