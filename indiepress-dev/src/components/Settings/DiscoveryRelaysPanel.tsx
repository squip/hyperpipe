import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { normalizeUrl } from '@/lib/url'
import { useGroups } from '@/providers/GroupsProvider'
import { useState } from 'react'

export default function DiscoveryRelaysPanel() {
  const { discoveryRelays, setDiscoveryRelays, resetDiscoveryRelays } = useGroups()
  const [draftRelay, setDraftRelay] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleAddRelay = () => {
    const normalized = normalizeUrl(draftRelay)
    if (!normalized) {
      setError('Enter a valid relay URL')
      return
    }

    if (discoveryRelays.includes(normalized)) {
      setError('Relay already added')
      return
    }

    setDiscoveryRelays([...discoveryRelays, normalized])
    setDraftRelay('')
    setError(null)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
        <div>
          <div className="font-semibold">Discovery relays</div>
          <div className="text-sm text-muted-foreground">
            Choose which relays the desktop client uses to discover public groups.
          </div>
        </div>

        <div className="space-y-2">
          {discoveryRelays.map((relay) => (
            <div
              key={relay}
              className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1 truncate text-sm">{relay}</div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={discoveryRelays.length <= 1}
                onClick={() => {
                  setDiscoveryRelays(discoveryRelays.filter((entry) => entry !== relay))
                  setError(null)
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={draftRelay}
            onChange={(event) => {
              setDraftRelay(event.target.value)
              if (error) setError(null)
            }}
            placeholder="wss://relay.example.com"
          />
          <div className="flex gap-2">
            <Button type="button" onClick={handleAddRelay}>
              Add relay
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetDiscoveryRelays()
                setDraftRelay('')
                setError(null)
              }}
            >
              Reset to defaults
            </Button>
          </div>
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}
      </div>
    </div>
  )
}
