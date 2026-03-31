import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerOverlay } from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { isProtectedEvent } from '@/lib/event'
import {
  dedupeRelayTargetsByIdentity,
  dedupeRelayUrlsByIdentity,
  getRelayIdentity,
  normalizeRelayTransportUrl,
  type RelayDisplayMeta
} from '@/lib/relay-targets'
import { simplifyUrl } from '@/lib/url'
import { useCurrentRelays } from '@/providers/CurrentRelaysProvider'
import { useFavoriteRelays } from '@/providers/FavoriteRelaysProvider'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import client from '@/services/client.service'
import { Check } from 'lucide-react'
import { NostrEvent } from '@jsr/nostr__tools/wasm'
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import RelayIcon from '../RelayIcon'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'

export type { RelayDisplayMeta } from '@/lib/relay-targets'

type TPostTargetItem =
  | {
      type: 'writeRelays'
    }
  | {
      type: 'relay'
      url: string
      relayIdentity: string
    }
  | {
      type: 'relaySet'
      id: string
      urls: string[]
    }

function serializePostTargetItem(item: TPostTargetItem): string {
  if (item.type === 'writeRelays') return 'writeRelays'
  if (item.type === 'relay') return `relay:${item.relayIdentity}`
  return `relaySet:${item.id}:${dedupeRelayUrlsByIdentity(item.urls).join(',')}`
}

function signaturesMatch(a: TPostTargetItem[], b: TPostTargetItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (serializePostTargetItem(a[i]) !== serializePostTargetItem(b[i])) {
      return false
    }
  }
  return true
}

function relayUrlIdentitySignature(relayUrls: string[]): string {
  return dedupeRelayUrlsByIdentity(relayUrls)
    .map((relayUrl) => getRelayIdentity(relayUrl) || relayUrl)
    .sort()
    .join('|')
}

function buildRelayTargetItems(relays: string[]): TPostTargetItem[] {
  return dedupeRelayTargetsByIdentity(relays)
    .sort((left, right) => left.relayIdentity.localeCompare(right.relayIdentity))
    .map(({ relayUrl, relayIdentity }) => ({
      type: 'relay' as const,
      url: relayUrl,
      relayIdentity
    }))
}

function relayDisplayPriority(meta: RelayDisplayMeta | undefined): number {
  if (!meta) return 0
  if (meta.isGroupRelay) return 3
  if (meta.hideUrl) return 2
  return 1
}

function buildRelayDisplayByIdentity(relayDisplayMeta: Record<string, RelayDisplayMeta>) {
  const map = new Map<string, RelayDisplayMeta>()
  Object.entries(relayDisplayMeta || {}).forEach(([relay, meta]) => {
    const relayIdentity = getRelayIdentity(relay)
    if (!relayIdentity) return
    const current = map.get(relayIdentity)
    if (relayDisplayPriority(meta) >= relayDisplayPriority(current)) {
      map.set(relayIdentity, meta || {})
    }
  })
  return map
}

export default function PostRelaySelector({
  parentEvent,
  openFrom,
  setIsProtectedEvent,
  setAdditionalRelayUrls,
  allowWriteRelays = true,
  allowRelaySets = true,
  extraRelayUrls = [],
  relayDisplayMeta = {},
  valueRelayUrls,
  onValueRelayUrlsChange
}: {
  parentEvent?: NostrEvent
  openFrom?: string[]
  setIsProtectedEvent?: Dispatch<SetStateAction<boolean>>
  setAdditionalRelayUrls?: Dispatch<SetStateAction<string[]>>
  allowWriteRelays?: boolean
  allowRelaySets?: boolean
  extraRelayUrls?: string[]
  relayDisplayMeta?: Record<string, RelayDisplayMeta>
  valueRelayUrls?: string[]
  onValueRelayUrlsChange?: (relayUrls: string[]) => void
}) {
  const { t } = useTranslation()
  const { isSmallScreen } = useScreenSize()
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const { relayUrls } = useCurrentRelays()
  const { relaySets, urls } = useFavoriteRelays()
  const [postTargetItems, setPostTargetItems] = useState<TPostTargetItem[]>(() => {
    const initialFromValue = dedupeRelayUrlsByIdentity(valueRelayUrls || [])
    if (initialFromValue.length) {
      return buildRelayTargetItems(initialFromValue)
    }
    const initialFromOpenFrom = dedupeRelayUrlsByIdentity(openFrom || [])
    if (initialFromOpenFrom.length) {
      return buildRelayTargetItems(initialFromOpenFrom)
    }
    return allowWriteRelays ? [{ type: 'writeRelays' }] : []
  })

  const parentEventSeenOnRelays = useMemo(() => {
    if (!parentEvent || !isProtectedEvent(parentEvent)) {
      return []
    }
    return dedupeRelayUrlsByIdentity(client.getSeenEventRelayUrls(parentEvent.id, parentEvent))
  }, [parentEvent])

  const selectableRelayTargets = useMemo(() => {
    return dedupeRelayTargetsByIdentity(
      parentEventSeenOnRelays
        .concat(relayUrls)
        .concat(urls)
        .concat(Array.isArray(extraRelayUrls) ? extraRelayUrls : [])
    )
  }, [parentEventSeenOnRelays, relayUrls, urls, extraRelayUrls])

  const relayDisplayByIdentity = useMemo(
    () => buildRelayDisplayByIdentity(relayDisplayMeta || {}),
    [relayDisplayMeta]
  )

  const description = useMemo(() => {
    if (postTargetItems.length === 0) {
      return t('No relays selected')
    }

    if (postTargetItems.length === 1) {
      const item = postTargetItems[0]
      if (item.type === 'writeRelays') {
        return t('Write relays')
      }
      if (item.type === 'relay') {
        const meta = relayDisplayByIdentity.get(item.relayIdentity)
        if (meta?.hideUrl && meta.label?.trim()) {
          return meta.label.trim()
        }
        return simplifyUrl(item.url)
      }
      if (item.type === 'relaySet') {
        return item.urls.length > 1
          ? t('{{count}} relays', { count: item.urls.length })
          : simplifyUrl(item.urls[0])
      }
    }

    const hasWriteRelays = postTargetItems.some((item) => item.type === 'writeRelays')
    const relayCount = postTargetItems.reduce((count, item) => {
      if (item.type === 'relay') {
        return count + 1
      }
      if (item.type === 'relaySet') {
        return count + item.urls.length
      }
      return count
    }, 0)

    if (hasWriteRelays) {
      return t('Write relays and {{count}} other relays', { count: relayCount })
    }
    return t('{{count}} relays', { count: relayCount })
  }, [postTargetItems, relayDisplayByIdentity, t])

  useEffect(() => {
    const fromValue = dedupeRelayUrlsByIdentity(valueRelayUrls || [])
    if (fromValue.length) {
      const nextItems = buildRelayTargetItems(fromValue)
      setPostTargetItems((previous) => (signaturesMatch(previous, nextItems) ? previous : nextItems))
      return
    }
    if (openFrom && openFrom.length) {
      const nextItems = buildRelayTargetItems(openFrom)
      setPostTargetItems((previous) => (signaturesMatch(previous, nextItems) ? previous : nextItems))
      return
    }
    if (parentEventSeenOnRelays && parentEventSeenOnRelays.length) {
      const nextItems = buildRelayTargetItems(parentEventSeenOnRelays)
      setPostTargetItems((previous) => (signaturesMatch(previous, nextItems) ? previous : nextItems))
      return
    }
    const fallbackItems = allowWriteRelays ? [{ type: 'writeRelays' as const }] : []
    setPostTargetItems((previous) =>
      signaturesMatch(previous, fallbackItems) ? previous : fallbackItems
    )
  }, [allowWriteRelays, openFrom, parentEventSeenOnRelays, valueRelayUrls])

  useEffect(() => {
    const isProtected = postTargetItems.every((item) => item.type !== 'writeRelays')
    const selectedRelayUrls = dedupeRelayUrlsByIdentity(
      postTargetItems.flatMap((item) => {
        if (item.type === 'relay') {
          return [item.url]
        }
        if (item.type === 'relaySet') {
          return item.urls
        }
        return []
      })
    )

    setIsProtectedEvent?.(isProtected)
    setAdditionalRelayUrls?.(selectedRelayUrls)

    if (onValueRelayUrlsChange) {
      const currentValueSignature = relayUrlIdentitySignature(valueRelayUrls || [])
      const nextValueSignature = relayUrlIdentitySignature(selectedRelayUrls)
      if (nextValueSignature !== currentValueSignature) {
        onValueRelayUrlsChange(selectedRelayUrls)
      }
    }
  }, [onValueRelayUrlsChange, postTargetItems, setAdditionalRelayUrls, setIsProtectedEvent, valueRelayUrls])

  const handleWriteRelaysCheckedChange = useCallback((checked: boolean) => {
    if (checked) {
      setPostTargetItems((prev) => [...prev, { type: 'writeRelays' }])
    } else {
      setPostTargetItems((prev) => prev.filter((item) => item.type !== 'writeRelays'))
    }
  }, [])

  const handleRelayCheckedChange = useCallback((checked: boolean, relayUrl: string) => {
    const normalizedRelay = normalizeRelayTransportUrl(relayUrl)
    const relayIdentity = normalizedRelay ? getRelayIdentity(normalizedRelay) : null
    if (!normalizedRelay || !relayIdentity) return

    setPostTargetItems((prev) => {
      const withoutRelay = prev.filter(
        (item) => !(item.type === 'relay' && item.relayIdentity === relayIdentity)
      )
      if (!checked) return withoutRelay
      return [...withoutRelay, { type: 'relay', url: normalizedRelay, relayIdentity }]
    })
  }, [])

  const handleRelaySetCheckedChange = useCallback(
    (checked: boolean, id: string, relaySetUrls: string[]) => {
      const canonicalUrls = dedupeRelayUrlsByIdentity(relaySetUrls)
      if (!canonicalUrls.length) return
      if (checked) {
        setPostTargetItems((prev) => [...prev, { type: 'relaySet', id, urls: canonicalUrls }])
      } else {
        setPostTargetItems((prev) =>
          prev.filter((item) => !(item.type === 'relaySet' && item.id === id))
        )
      }
    },
    []
  )

  const content = useMemo(() => {
    const selectableRelaySets = relaySets.filter(({ relayUrls }) => relayUrls.length)
    const hasRelaySetSection = allowRelaySets && selectableRelaySets.length > 0
    const hasSectionBeforeRelayList = allowWriteRelays || hasRelaySetSection

    return (
      <>
        {allowWriteRelays && (
          <MenuItem
            checked={postTargetItems.some((item) => item.type === 'writeRelays')}
            onCheckedChange={handleWriteRelaysCheckedChange}
          >
            {t('Write relays')}
          </MenuItem>
        )}
        {hasRelaySetSection && (
          <>
            <MenuSeparator />
            {selectableRelaySets.map(({ id, name, relayUrls: relaySetUrls }) => (
              <MenuItem
                key={id}
                checked={postTargetItems.some(
                  (item) => item.type === 'relaySet' && item.id === id
                )}
                onCheckedChange={(checked) => handleRelaySetCheckedChange(checked, id, relaySetUrls)}
              >
                <div className="truncate">
                  {name} ({relaySetUrls.length})
                </div>
              </MenuItem>
            ))}
          </>
        )}
        {selectableRelayTargets.length > 0 && (
          <>
            {hasSectionBeforeRelayList ? <MenuSeparator /> : null}
            {selectableRelayTargets.map(({ relayUrl, relayIdentity }) => {
              const meta = relayDisplayByIdentity.get(relayIdentity)
              return (
                <MenuItem
                  key={relayIdentity}
                  checked={postTargetItems.some(
                    (item) => item.type === 'relay' && item.relayIdentity === relayIdentity
                  )}
                  onCheckedChange={(checked) => handleRelayCheckedChange(checked, relayUrl)}
                >
                  {meta ? (
                    <RelayDisplayRow relayUrl={relayUrl} meta={meta} />
                  ) : (
                    <div className="flex items-center gap-2">
                      <RelayIcon url={relayUrl} />
                      <div className="truncate">{simplifyUrl(relayUrl)}</div>
                    </div>
                  )}
                </MenuItem>
              )
            })}
          </>
        )}
      </>
    )
  }, [
    allowRelaySets,
    allowWriteRelays,
    handleRelayCheckedChange,
    handleRelaySetCheckedChange,
    handleWriteRelaysCheckedChange,
    postTargetItems,
    relayDisplayByIdentity,
    relaySets,
    selectableRelayTargets,
    t
  ])

  if (isSmallScreen) {
    return (
      <>
        <div className="flex items-center gap-2">
          {t('Post to')}
          <Button
            variant="outline"
            className="px-2 flex-1 max-w-fit justify-start"
            onClick={() => setIsDrawerOpen(true)}
          >
            <div className="truncate">{description}</div>
          </Button>
        </div>
        <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
          <DrawerOverlay onClick={() => setIsDrawerOpen(false)} />
          <DrawerContent className="max-h-[80vh]" hideOverlay>
            <div
              className="overflow-y-auto overscroll-contain py-2"
              style={{ touchAction: 'pan-y' }}
            >
              {content}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }

  return (
    <DropdownMenu>
      <div className="flex items-center gap-2">
        {t('Post to')}
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="px-2 flex-1 max-w-fit justify-start"
            data-post-relay-selector
          >
            <div className="truncate">{description}</div>
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" className="max-w-96 max-h-[50vh]" showScrollButtons>
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RelayDisplayRow({ relayUrl, meta }: { relayUrl: string; meta: RelayDisplayMeta }) {
  const label = meta.label?.trim() || simplifyUrl(relayUrl)
  const displayRelayUrl = simplifyUrl(relayUrl)
  const initials = label.slice(0, 2).toUpperCase()

  return (
    <div className="flex min-w-0 items-center gap-2">
      {meta.imageUrl ? (
        <Avatar className="h-5 w-5 shrink-0">
          <AvatarImage src={meta.imageUrl} alt={label} />
          <AvatarFallback className="text-[9px] font-semibold">{initials}</AvatarFallback>
        </Avatar>
      ) : (
        <RelayIcon url={relayUrl} />
      )}
      <div className="min-w-0">
        <div className="truncate">{label}</div>
        {!meta.hideUrl ? (
          <div className="truncate text-[11px] text-muted-foreground">{displayRelayUrl}</div>
        ) : null}
        {meta.subtitle ? (
          <div className="truncate text-[11px] text-muted-foreground">{meta.subtitle}</div>
        ) : null}
      </div>
    </div>
  )
}

function MenuSeparator() {
  const { isSmallScreen } = useScreenSize()
  if (isSmallScreen) {
    return <Separator />
  }
  return <DropdownMenuSeparator />
}

function MenuItem({
  children,
  checked,
  onCheckedChange
}: {
  children: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const { isSmallScreen } = useScreenSize()

  if (isSmallScreen) {
    return (
      <div
        onClick={() => onCheckedChange(!checked)}
        className="flex items-center gap-2 px-4 py-3 clickable"
      >
        <div className="flex items-center justify-center size-4 shrink-0">
          {checked && <Check className="size-4" />}
        </div>
        {children}
      </div>
    )
  }

  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onSelect={(e) => e.preventDefault()}
      onCheckedChange={onCheckedChange}
      className="flex items-center gap-2"
    >
      {children}
    </DropdownMenuCheckboxItem>
  )
}
