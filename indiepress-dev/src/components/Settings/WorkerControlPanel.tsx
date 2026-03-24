import { useMemo } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useNostr } from '@/providers/NostrProvider'
import { isElectron } from '@/lib/platform'
import { Badge } from '@/components/ui/badge'

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

export default function WorkerControlPanel() {
  const nostr = useNostr()
  const {
    lifecycle,
    ready
  } = useWorkerBridge()

  const identityReady = useMemo(
    () => isHex64(nostr.pubkey) && isHex64(nostr.nsecHex),
    [nostr.nsecHex, nostr.pubkey]
  )

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Local peer node</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: manage local peer node services in the Electron app.
        </div>
      </div>
    )
  }

  const badgeLabel = ready
    ? 'Ready'
    : !identityReady
      ? 'Needs sign-in'
      : lifecycle === 'starting' || lifecycle === 'initializing' || lifecycle === 'restarting'
        ? 'Starting'
        : lifecycle === 'error'
          ? 'Unavailable'
          : 'Not ready'
  const badgeVariant = ready ? 'default' : lifecycle === 'error' ? 'destructive' : 'outline'
  const statusText = ready
    ? 'Running on this device.'
    : !identityReady
      ? 'Sign in with your local account to enable the local peer node.'
      : lifecycle === 'starting' || lifecycle === 'initializing' || lifecycle === 'restarting'
        ? 'Starting local peer node…'
        : lifecycle === 'error'
          ? 'Could not start the local peer node.'
          : 'Preparing local peer node…'

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">Local peer node</div>
          <div className="text-sm text-muted-foreground">{statusText}</div>
        </div>
        <Badge variant={badgeVariant}>{badgeLabel}</Badge>
      </div>
    </div>
  )
}
