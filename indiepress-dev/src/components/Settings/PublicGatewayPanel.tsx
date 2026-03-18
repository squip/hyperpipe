import { useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export default function PublicGatewayPanel() {
  const { publicGatewayStatus, lastError, sendToWorker } = useWorkerBridge()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Public gateway</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: configure public gateway access in the Electron app.
        </div>
      </div>
    )
  }

  const status = publicGatewayStatus
  const accessCatalog = Array.isArray(status?.gatewayAccessCatalog) ? status.gatewayAccessCatalog : []
  const authorizedGateways = Array.isArray(status?.authorizedGateways) ? status.authorizedGateways : []
  const discoveredGateways = Array.isArray(status?.discoveredGateways) ? status.discoveredGateways : []

  const refreshStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'get-public-gateway-status' })
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch status')
    } finally {
      setBusy(false)
    }
  }

  const resyncAll = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'refresh-public-gateway-all' })
      await refreshStatus().catch(() => {})
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Public gateway</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refreshStatus} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="outline" onClick={resyncAll} disabled={busy}>
            Resync all
          </Button>
        </div>
      </div>
      {(error || lastError) && (
        <div className="text-sm text-red-500">{error || lastError}</div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={status?.enabled ? 'default' : 'outline'}>
          {status?.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
        {status?.authMethod && <Badge variant="outline">{status.authMethod}</Badge>}
        {status?.baseUrl && <div className="text-muted-foreground">{status.baseUrl}</div>}
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div>Discovered: {discoveredGateways.length}</div>
        <div>Approved for hosting: {authorizedGateways.length}</div>
        <div>Last update: {status?.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleString() : 'n/a'}</div>
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">Gateway access</div>
        {!accessCatalog.length ? (
          <div className="text-xs text-muted-foreground">
            No gateway access state cached yet. Refresh to probe discovered gateways.
          </div>
        ) : (
          <div className="space-y-1 text-xs">
            {accessCatalog.map((entry, index) => (
              <div key={`${entry.gatewayId || entry.gatewayOrigin || 'gateway'}:${index}`} className="rounded-md border border-border/50 bg-background/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">{entry.gatewayOrigin || entry.gatewayId || 'Gateway'}</div>
                  <Badge
                    variant={
                      entry.hostingState === 'approved'
                        ? 'default'
                        : entry.hostingState === 'denied'
                          ? 'destructive'
                          : 'outline'
                    }
                    className="capitalize"
                  >
                    {entry.hostingState || 'unknown'}
                  </Badge>
                </div>
                <div className="text-muted-foreground">
                  Policy: {entry.policy?.hostPolicy || 'unknown'}
                  {entry.memberDelegationMode ? ` • Delegation: ${entry.memberDelegationMode}` : ''}
                </div>
                {entry.reason && <div className="text-muted-foreground">Reason: {entry.reason}</div>}
                {entry.lastCheckedAt && (
                  <div className="text-muted-foreground">
                    Checked: {new Date(entry.lastCheckedAt).toLocaleString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">Registered relays</div>
        {!status?.relays || !Object.keys(status.relays).length ? (
          <div className="text-xs text-muted-foreground">No relays reported.</div>
        ) : (
          <div className="space-y-1 text-xs">
            {Object.entries(status.relays).map(([id, entry]) => (
              <div key={id} className="rounded-md border border-border/50 bg-background/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">{id}</div>
                  <Badge variant="outline" className="capitalize">
                    {entry?.status || 'unknown'}
                  </Badge>
                </div>
                {entry?.error && <div className="text-red-500">{entry.error}</div>}
                {entry?.lastSyncedAt && (
                  <div className="text-muted-foreground">Last sync: {entry.lastSyncedAt}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
