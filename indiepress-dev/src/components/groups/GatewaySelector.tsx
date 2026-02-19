import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { dedupeGatewayDescriptors, parseGatewayDescriptorInput, serializeGatewayDescriptorInput } from '@/lib/gateway-tags'
import { TGatewayDescriptor, TGatewayDirectoryEntry } from '@/types/groups'

function shortPubkey(value: string, size = 8): string {
  const normalized = String(value || '').trim()
  if (!normalized) return '-'
  if (normalized.length <= size) return normalized
  return `${normalized.slice(0, Math.max(4, size - 4))}…${normalized.slice(-4)}`
}

function avatarFallbackText(entry: TGatewayDirectoryEntry): string {
  const name = String(entry.operatorName || '').trim()
  if (name) {
    const first = name.charAt(0).toUpperCase()
    return first || 'GW'
  }
  return shortPubkey(entry.operatorPubkey, 2).replace('…', '').toUpperCase() || 'GW'
}

export default function GatewaySelector({
  value,
  onChange,
  directory,
  maxResults = 10
}: {
  value: TGatewayDescriptor[]
  onChange: (next: TGatewayDescriptor[]) => void
  directory: TGatewayDirectoryEntry[]
  maxResults?: number
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [manualValue, setManualValue] = useState(serializeGatewayDescriptorInput(value))

  useEffect(() => {
    if (!advanced) {
      setManualValue(serializeGatewayDescriptorInput(value))
    }
  }, [advanced, value])

  const selectedByOrigin = useMemo(() => {
    const map = new Map<string, TGatewayDescriptor>()
    dedupeGatewayDescriptors(value).forEach((entry) => map.set(entry.origin, entry))
    return map
  }, [value])

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return directory.slice(0, maxResults)
    return directory
      .filter((entry) => {
        const fields = [
          entry.origin,
          entry.operatorPubkey,
          entry.policy,
          entry.operatorName,
          entry.operatorNip05
        ]
        return fields.some((value) => String(value || '').toLowerCase().includes(normalizedQuery))
      })
      .slice(0, maxResults)
  }, [directory, maxResults, query])

  const setSelectedGateways = (next: TGatewayDescriptor[]) => {
    onChange(dedupeGatewayDescriptors(next))
  }

  const addGateway = (entry: TGatewayDirectoryEntry) => {
    setSelectedGateways([
      ...value,
      {
        origin: entry.origin,
        operatorPubkey: entry.operatorPubkey,
        policy: entry.policy
      }
    ])
  }

  const removeGateway = (origin: string) => {
    setSelectedGateways(value.filter((entry) => entry.origin !== origin))
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('Search known gateways by origin or operator') as string}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
          {visibleEntries.map((entry) => {
            const selected = selectedByOrigin.has(entry.origin)
            return (
              <button
                key={entry.origin}
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-2 text-left hover:bg-accent"
                onClick={() => {
                  if (selected) {
                    removeGateway(entry.origin)
                  } else {
                    addGateway(entry)
                  }
                }}
              >
                <div className="min-w-0 flex items-center gap-2">
                  <Avatar className="h-7 w-7 shrink-0">
                    <AvatarImage src={entry.operatorPicture || undefined} />
                    <AvatarFallback>{avatarFallbackText(entry)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      {entry.operatorName || shortPubkey(entry.operatorPubkey)}
                      {entry.followedOperator ? ` • ${t('followed')}` : ''}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {entry.operatorNip05 || shortPubkey(entry.operatorPubkey, 12)}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{entry.origin}</div>
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                  <div>{entry.policy}</div>
                  <div>{t('used')}: {entry.popularityCount}</div>
                  <div>{selected ? '[x]' : '[ ]'}</div>
                </div>
              </button>
            )
          })}
          {!visibleEntries.length ? (
            <div className="rounded-md border border-dashed px-2 py-3 text-xs text-muted-foreground">
              {t('No gateway matches your search. Use Advanced mode for manual entry.')}
            </div>
          ) : null}
        </div>
      </div>

      {selectedByOrigin.size ? (
        <div className="flex flex-wrap gap-2">
          {Array.from(selectedByOrigin.values()).map((entry) => (
            <span
              key={entry.origin}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="max-w-[16rem] truncate">{entry.origin}</span>
              <span className="text-muted-foreground">{entry.policy}</span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted"
                onClick={() => removeGateway(entry.origin)}
                aria-label={t('Remove gateway') as string}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{t('No gateways selected')}</div>
      )}

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = !advanced
            setAdvanced(next)
            if (next) {
              setManualValue(serializeGatewayDescriptorInput(value))
            }
          }}
        >
          {advanced ? t('Hide Advanced') : t('Advanced manual entry')}
        </Button>
      </div>

      {advanced ? (
        <div className="space-y-1">
          <Textarea
            value={manualValue}
            onChange={(event) => {
              const next = event.target.value
              setManualValue(next)
              setSelectedGateways(parseGatewayDescriptorInput(next))
            }}
            placeholder="https://gateway.example,<operator-pubkey>,OPEN"
            rows={4}
          />
          <div className="text-xs text-muted-foreground">
            {t('One per line: origin,operator-pubkey,OPEN|CLOSED')}
          </div>
        </div>
      ) : null}
    </div>
  )
}
