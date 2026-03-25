import RelayIcon from '@/components/RelayIcon'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Drawer, DrawerContent, DrawerHeader } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type {
  TFeedFilterListOption,
  TFeedFilterRelayOption,
  TSharedFeedFilterSettings
} from '@/lib/shared-feed-filters'
import type { TTimeFrame } from '@/lib/time-frame'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { Check, ChevronDown, ListFilter } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

type SharedFeedFilterMenuProps = {
  settings: TSharedFeedFilterSettings
  defaultSettings: TSharedFeedFilterSettings
  timeFrameOptions: TTimeFrame[]
  relayOptions: TFeedFilterRelayOption[]
  listOptions: TFeedFilterListOption[]
  isActive: boolean
  onApply: (settings: TSharedFeedFilterSettings) => void
  onReset: (settings: TSharedFeedFilterSettings) => void
  className?: string
}

export default function SharedFeedFilterMenu({
  settings,
  defaultSettings,
  timeFrameOptions,
  relayOptions,
  listOptions,
  isActive,
  onApply,
  onReset,
  className
}: SharedFeedFilterMenuProps) {
  const { t } = useTranslation()
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)
  const [tempSettings, setTempSettings] = useState(settings)

  useEffect(() => {
    if (!open) {
      setTempSettings(settings)
    }
  }, [open, settings])

  const handleOpen = () => {
    setTempSettings(settings)
    setOpen(true)
  }

  const handleApply = () => {
    onApply(tempSettings)
    setOpen(false)
  }

  const handleReset = () => {
    setTempSettings(defaultSettings)
    onReset(defaultSettings)
  }

  const trigger = (
    <Button
      variant="ghost"
      size="titlebar-icon"
      className={cn('relative focus:text-foreground', !isActive && 'text-muted-foreground', className)}
      onClick={() => {
        if (isSmallScreen) {
          handleOpen()
        }
      }}
      title={t('Filter') as string}
      aria-label={t('Filter') as string}
    >
      <ListFilter size={18} />
      {isActive && (
        <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
      )}
    </Button>
  )

  const content = (
    <div className="space-y-4 pb-2">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="shared-feed-recency" className="text-sm font-medium">
            {t('Show me results from the last')}
          </Label>
          <Checkbox
            id="shared-feed-recency"
            checked={tempSettings.recencyEnabled}
            onCheckedChange={(checked) =>
              setTempSettings((prev) => ({ ...prev, recencyEnabled: checked === true }))
            }
          />
        </div>
        {tempSettings.recencyEnabled && (
          <Select
            value={`${tempSettings.timeFrame.value}-${tempSettings.timeFrame.unit}`}
            onValueChange={(value) => {
              const [rawValue, unit] = value.split('-')
              const timeFrame = timeFrameOptions.find(
                (option) => option.value === Number(rawValue) && option.unit === unit
              )
              if (timeFrame) {
                setTempSettings((prev) => ({ ...prev, timeFrame }))
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-60">
              {timeFrameOptions.map((timeFrame) => (
                <SelectItem
                  key={`${timeFrame.value}-${timeFrame.unit}`}
                  value={`${timeFrame.value}-${timeFrame.unit}`}
                >
                  {timeFrame.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium leading-4">{t('GroupedNotesFilterMore')}</Label>
        <Select
          value={tempSettings.maxItemsPerAuthor.toString()}
          onValueChange={(value) =>
            setTempSettings((prev) => ({ ...prev, maxItemsPerAuthor: Number(value) || 0 }))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="0">{t('GroupedNotesDisabled')}</SelectItem>
            {Array.from({ length: 100 }, (_, index) => (
              <SelectItem key={index + 1} value={(index + 1).toString()}>
                {index + 1} {index + 1 === 1 ? t('item') : t('items')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="shared-feed-muted-words" className="text-sm font-medium leading-4">
          {t('Muted word list')}
        </Label>
        <Input
          id="shared-feed-muted-words"
          type="text"
          placeholder={t('Comma separated words')}
          className="text-[#e03f8c]"
          value={tempSettings.mutedWords}
          onChange={(event) =>
            setTempSettings((prev) => ({ ...prev, mutedWords: event.target.value }))
          }
          showClearButton
          onClear={() => setTempSettings((prev) => ({ ...prev, mutedWords: '' }))}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium leading-4">{t('Filter by relay')}</Label>
        <MultiSelectField
          triggerLabel={t('Relays')}
          options={relayOptions.map((option) => ({
            value: option.relayIdentity,
            label: option.label,
            description: option.subtitle || null,
            imageUrl: option.imageUrl,
            relayUrl: option.relayUrl,
            hideUrl: option.hideUrl
          }))}
          selectedValues={tempSettings.selectedRelayIdentities}
          emptyLabel={t('No relays available')}
          allSelectedLabel={t('All relays')}
          searchPlaceholder={t('Search relays...')}
          onChange={(selectedValues) =>
            setTempSettings((prev) => ({ ...prev, selectedRelayIdentities: selectedValues }))
          }
          renderOption={(option) => <RelayMenuOption option={option} />}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium leading-4">{t('Filter by list')}</Label>
        <MultiSelectField
          triggerLabel={t('Lists')}
          options={listOptions.map((option) => ({
            value: option.key,
            label: option.label,
            description: option.description || null
          }))}
          selectedValues={tempSettings.selectedListKeys}
          emptyLabel={t('No lists available')}
          allSelectedLabel={t('All lists')}
          searchPlaceholder={t('Search lists...')}
          onChange={(selectedValues) =>
            setTempSettings((prev) => ({ ...prev, selectedListKeys: selectedValues }))
          }
          renderOption={(option) => <ListMenuOption option={option} />}
        />
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={handleReset} className="flex-1">
          {t('Reset')}
        </Button>
        <Button onClick={handleApply} className="flex-1">
          {t('Apply')}
        </Button>
      </div>
    </div>
  )

  if (isSmallScreen) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="px-4">
            <DrawerHeader />
            {content}
          </DrawerContent>
        </Drawer>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onClick={handleOpen}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent className="w-96" collisionPadding={16} sideOffset={0} align="end">
        {content}
      </PopoverContent>
    </Popover>
  )
}

type TMultiSelectOption = {
  value: string
  label: string
  description?: string | null
  imageUrl?: string | null
  relayUrl?: string
  hideUrl?: boolean
}

function MultiSelectField({
  triggerLabel,
  options,
  selectedValues,
  emptyLabel,
  allSelectedLabel,
  searchPlaceholder,
  onChange,
  renderOption
}: {
  triggerLabel: string
  options: TMultiSelectOption[]
  selectedValues: string[]
  emptyLabel: string
  allSelectedLabel: string
  searchPlaceholder: string
  onChange: (selectedValues: string[]) => void
  renderOption: (option: TMultiSelectOption) => ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues])

  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return options
    return options.filter((option) => {
      const values = [option.label, option.description || '', option.relayUrl || '']
      return values.some((value) => value.toLowerCase().includes(query))
    })
  }, [options, search])

  const summary = useMemo(() => {
    if (!options.length) return emptyLabel
    if (selectedValues.length === options.length) return allSelectedLabel
    if (selectedValues.length === 0) return t('None selected')
    if (selectedValues.length === 1) {
      return options.find((option) => option.value === selectedValues[0])?.label || t('1 selected')
    }
    return t('{{count}} selected', { count: selectedValues.length })
  }, [allSelectedLabel, emptyLabel, options, selectedValues, t])

  const toggleValue = (value: string, checked: boolean) => {
    const next = new Set(selectedSet)
    if (checked) {
      next.add(value)
    } else {
      next.delete(value)
    }
    onChange(Array.from(next))
  }

  const allVisibleSelected =
    filteredOptions.length > 0 && filteredOptions.every((option) => selectedSet.has(option.value))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className="truncate text-left">{summary}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="border-b p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </div>
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
          <span>{triggerLabel}</span>
          {filteredOptions.length > 0 ? (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                if (allVisibleSelected) {
                  onChange(selectedValues.filter((value) => !filteredOptions.some((option) => option.value === value)))
                  return
                }
                const next = new Set(selectedValues)
                filteredOptions.forEach((option) => next.add(option.value))
                onChange(Array.from(next))
              }}
            >
              {allVisibleSelected ? t('Clear All') : t('Select All')}
            </button>
          ) : null}
        </div>
        <ScrollArea className="max-h-64">
          <div className="space-y-1 p-2">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const checked = selectedSet.has(option.value)
                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm',
                      checked ? 'bg-primary/5' : 'hover:bg-accent'
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) => toggleValue(option.value, value === true)}
                    />
                    <div className="min-w-0 flex-1">
                      {renderOption(option)}
                    </div>
                    {checked ? <Check className="h-4 w-4 text-primary" /> : null}
                  </label>
                )
              })
            ) : (
              <div className="px-2 py-4 text-sm text-muted-foreground">{t('No results found')}</div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

function RelayMenuOption({ option }: { option: TMultiSelectOption }) {
  const label = option.label.trim()
  const initials = label.slice(0, 2).toUpperCase()

  if (option.hideUrl || option.imageUrl) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="h-5 w-5 shrink-0">
          {option.imageUrl ? <AvatarImage src={option.imageUrl} alt={label} /> : null}
          <AvatarFallback className="text-[9px] font-semibold">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate">{label}</div>
          {option.description ? (
            <div className="truncate text-xs text-muted-foreground">{option.description}</div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {option.relayUrl ? <RelayIcon url={option.relayUrl} /> : null}
      <div className="min-w-0">
        <div className="truncate">{label}</div>
        {option.description ? (
          <div className="truncate text-xs text-muted-foreground">{option.description}</div>
        ) : null}
      </div>
    </div>
  )
}

function ListMenuOption({ option }: { option: TMultiSelectOption }) {
  return (
    <div className="min-w-0">
      <div className="truncate">{option.label}</div>
      {option.description ? (
        <div className="truncate text-xs text-muted-foreground">{option.description}</div>
      ) : null}
    </div>
  )
}
