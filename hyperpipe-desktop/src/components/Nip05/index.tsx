import { Skeleton } from '@/components/ui/skeleton'
import { useFetchProfile } from '@/hooks'
import { useFetchNip05 } from '@/hooks/useFetchNip05'
import { toNoteList } from '@/lib/link'
import { cn } from '@/lib/utils'
import { SecondaryPageLink } from '@/PageManager'
import { BadgeAlert, BadgeCheck } from 'lucide-react'
import { Favicon } from '../Favicon'
import { NostrUser } from '@nostr/gadgets/metadata'

export default function Nip05({
  profile: providedProfile,
  pubkey,
  append,
  className
}: {
  pubkey?: string
  profile?: NostrUser
  append?: string
  className?: string
}) {
  const { profile: fetchedProfile } = useFetchProfile(providedProfile ? undefined : pubkey)
  const profile = providedProfile || fetchedProfile

  const { nip05IsVerified, nip05Name, nip05Domain, isFetching } = useFetchNip05(
    profile?.metadata?.nip05,
    pubkey
  )

  if (isFetching) {
    return (
      <div className="flex items-center py-1">
        <Skeleton className="h-3 w-16" />
      </div>
    )
  }

  if (!profile?.metadata?.nip05 || !nip05Name || !nip05Domain) return null

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 truncate [&_svg]:!size-3.5 [&_svg]:shrink-0',
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {nip05Name !== '_' ? (
        <span className="min-w-0 truncate text-sm text-muted-foreground">@{nip05Name}</span>
      ) : null}
      {nip05IsVerified ? (
        <Favicon
          domain={nip05Domain}
          className="w-3.5 h-3.5 rounded-full"
          fallback={<BadgeCheck className="text-primary" />}
        />
      ) : (
        <BadgeAlert className="text-muted-foreground" />
      )}
      <SecondaryPageLink
        to={toNoteList({ domain: nip05Domain })}
        className={`min-w-0 truncate text-sm hover:underline ${nip05IsVerified ? 'text-primary' : 'text-muted-foreground'}`}
      >
        {nip05Domain}
      </SecondaryPageLink>
      {append && <span className="min-w-0 truncate text-sm text-muted-foreground">{append}</span>}
    </div>
  )
}
