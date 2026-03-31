import { useMemo, useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { buildPublicGatewayPanelModel } from '@/lib/local-peer-node-ui'

export default function PublicGatewayPanel() {
  const { publicGatewayStatus, sendToWorker } = useWorkerBridge()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({})

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Public gateways</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: view public gateway access in the Electron app.
        </div>
      </div>
    )
  }

  const status = publicGatewayStatus
  const panelModel = useMemo(() => buildPublicGatewayPanelModel(status), [status])

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

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Public gateways</div>
        <Button size="sm" variant="outline" onClick={refreshStatus} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {error && (
        <div className="text-sm text-red-500">{error}</div>
      )}
      <div className="text-sm text-muted-foreground">
        Approved gateways: {panelModel.approvedCount}
        {panelModel.lastUpdatedAt
          ? ` • Last updated ${new Date(panelModel.lastUpdatedAt).toLocaleString()}`
          : ''}
      </div>
      {panelModel.warning && (
        <div className="rounded-md border border-border/50 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
          {panelModel.warning}
        </div>
      )}
      {!panelModel.cards.length ? (
        <div className="rounded-md border border-border/50 bg-background/60 p-3 text-sm text-muted-foreground">
          No public gateway status has been loaded yet.
        </div>
      ) : (
        <div className="space-y-3">
          {panelModel.cards.map((card) => {
            const isExpanded = expandedCards[card.key] ?? false
            return (
              <div
                key={card.key}
                className="rounded-lg border border-border/50 bg-background/60 p-3 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{card.title}</div>
                    {card.subtitle && (
                      <div className="text-xs text-muted-foreground break-all">{card.subtitle}</div>
                    )}
                    {card.detail && (
                      <div className="mt-1 text-sm text-muted-foreground">{card.detail}</div>
                    )}
                    {card.lastCheckedAt && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Last checked {new Date(card.lastCheckedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <Badge variant={card.badgeVariant}>{card.statusLabel}</Badge>
                </div>

                {card.relays.length > 0 ? (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-left"
                      onClick={() =>
                        setExpandedCards((prev) => ({
                          ...prev,
                          [card.key]: !isExpanded
                        }))
                      }
                    >
                      <span className="text-sm font-medium">Registered relays ({card.relays.length})</span>
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="space-y-2">
                        {card.relays.map((relay) => (
                          <div
                            key={relay.key}
                            className="rounded-md border border-border/50 bg-background/80 px-3 py-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">{relay.label}</div>
                                {relay.subtitle && (
                                  <div className="truncate text-xs text-muted-foreground">
                                    {relay.subtitle}
                                  </div>
                                )}
                                {relay.lastSyncedAt && (
                                  <div className="text-xs text-muted-foreground">
                                    Last sync {new Date(relay.lastSyncedAt).toLocaleString()}
                                  </div>
                                )}
                                {relay.error && (
                                  <div className="text-xs text-red-500">{relay.error}</div>
                                )}
                              </div>
                              <Badge variant="outline">{relay.statusLabel}</Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No registered relays here yet.</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
