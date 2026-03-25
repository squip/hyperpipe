import { useMemo } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { isElectron } from '@/lib/platform'
import { Badge } from '@/components/ui/badge'
import { deriveLocalProxyHost } from '@/lib/local-peer-node-ui'

export default function GatewaySettingsPanel() {
  const { gatewayStatus } = useWorkerBridge()

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Local proxy</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: view local proxy details in the Electron app.
        </div>
      </div>
    )
  }

  const status = gatewayStatus
  const proxyHost = useMemo(() => deriveLocalProxyHost(status), [status])

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Local proxy</div>
        <Badge variant={status?.running ? 'default' : 'outline'}>
          {status?.running ? 'Running' : 'Stopped'}
        </Badge>
      </div>
      <div className="rounded-md border border-border/50 bg-background/60 px-3 py-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Proxy host</div>
        <div className="mt-1 text-sm break-all">
          {proxyHost || 'Not available yet'}
        </div>
      </div>
    </div>
  )
}
