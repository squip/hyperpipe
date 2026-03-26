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
  TFeedFilterExtensionOption,
  TFeedFilterLanguageOption,
  TFeedFilterListOption,
  TFeedFilterRelayOption,
  TSharedFeedFilterSettings
} from '@/lib/shared-feed-filters'
import type { TTimeFrame } from '@/lib/time-frame'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { Check, ChevronDown, ListFilter, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

type SharedFeedFilterMenuProps = {
  settings: TSharedFeedFilterSettings
  defaultSettings: TSharedFeedFilterSettings
  timeFrameOptions: TTimeFrame[]
  relayOptions: TFeedFilterRelayOption[]
  listOptions: TFeedFilterListOption[]
  languageOptions?: TFeedFilterLanguageOption[]
  fileExtensionOptions?: TFeedFilterExtensionOption[]
  isActive: boolean
  onApply: (settings: TSharedFeedFilterSettings) => void
  onReset: (settings: TSharedFeedFilterSettings) => void
  onCreateRelayOption?: (search: string) => string | null
  onRemoveRelayOption?: (relayIdentity: string) => void
  createFileExtensionValue?: (search: string) => string | null
  className?: string
}

type TMultiSelectOption = {
  value: string
  label: string
  description?: string | null
  imageUrl?: string | null
  relayUrl?: string
  hideUrl?: boolean
  isCustom?: boolean
}

export default function SharedFeedFilterMenu({
  settings,
  defaultSettings,
  timeFrameOptions,
  relayOptions,
  listOptions,
  languageOptions = [],
  fileExtensionOptions = [],
  isActive,
  onApply,
  onReset,
  onCreateRelayOption,
  onRemoveRelayOption,
  createFileExtensionValue,
  className
}: SharedFeedFilterMenuProps) {
  const { t } = useTranslation()
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)
  const [tempSettings, setTempSettings] = useState(settings)
  const allRelayIdentities = useMemo(
    () => relayOptions.map((option) => option.relayIdentity),
    [relayOptions]
  )

  const normalizeRelaySelections = (nextSettings: TSharedFeedFilterSettings) => {
    if (nextSettings.selectedRelayIdentities.length > 0 || allRelayIdentities.length === 0) {
      return nextSettings
    }

    return {
      ...nextSettings,
      selectedRelayIdentities: allRelayIdentities
    }
  }

  useEffect(() => {
    if (!open) {
      setTempSettings(normalizeRelaySelections(settings))
    }
  }, [allRelayIdentities, open, settings])

  const resolvedFileExtensionOptions = useMemo<TFeedFilterExtensionOption[]>(() => {
    const optionByExtension = new Map<string, TFeedFilterExtensionOption>()
    const order: string[] = []

    fileExtensionOptions.forEach((option) => {
      if (!optionByExtension.has(option.extension)) {
        order.push(option.extension)
      }
      optionByExtension.set(option.extension, option)
    })

    tempSettings.customFileExtensions.forEach((extension) => {
      if (!optionByExtension.has(extension)) {
        order.push(extension)
      }
      optionByExtension.set(extension, {
        extension,
        label: extension === 'unknown' ? t('Unknown') : `.${extension}`,
        isCustom: true
      })
    })

    return order
      .map((extension) => optionByExtension.get(extension))
      .filter((option): option is TFeedFilterExtensionOption => !!option)
  }, [fileExtensionOptions, t, tempSettings.customFileExtensions])

  const handleOpen = () => {
    setTempSettings(normalizeRelaySelections(settings))
    setOpen(true)
  }

  const handleApply = () => {
    const nextSettings = normalizeRelaySelections(tempSettings)
    setTempSettings(nextSettings)
    onApply(nextSettings)
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
    <div className="flex max-h-[min(82vh,42rem)] flex-col">
      <ScrollArea className="max-h-[min(82vh,42rem)]">
        <div className="space-y-4 p-4 pb-2">
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
                hideUrl: option.hideUrl,
                isCustom: option.isCustom
              }))}
              selectedValues={tempSettings.selectedRelayIdentities}
              emptyLabel={t('No relays available')}
              allSelectedLabel={t('All relays')}
              searchPlaceholder={t('Search relays...')}
              onChange={(selectedValues) =>
                setTempSettings((prev) => ({ ...prev, selectedRelayIdentities: selectedValues }))
              }
              renderOption={(option) => <RelayMenuOption option={option} />}
              onCreateOption={onCreateRelayOption}
              createActionLabel={t('Add relay')}
              createErrorLabel={t('Invalid relay URL')}
              onRemoveOption={onRemoveRelayOption}
              removeOptionLabel={t('Remove relay')}
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

          {languageOptions.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium leading-4">{t('Filter by language')}</Label>
              <MultiSelectField
                triggerLabel={t('Languages')}
                options={languageOptions.map((option) => ({
                  value: option.code,
                  label: option.label
                }))}
                selectedValues={tempSettings.selectedLanguageCodes}
                emptyLabel={t('No languages available')}
                allSelectedLabel={t('All languages')}
                searchPlaceholder={t('Search languages...')}
                onChange={(selectedValues) =>
                  setTempSettings((prev) => ({ ...prev, selectedLanguageCodes: selectedValues }))
                }
                renderOption={(option) => <ListMenuOption option={option} />}
              />
            </div>
          ) : null}

          {resolvedFileExtensionOptions.length > 0 || createFileExtensionValue ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium leading-4">{t('Filter by file type')}</Label>
              <MultiSelectField
                triggerLabel={t('File types')}
                options={resolvedFileExtensionOptions.map((option) => ({
                  value: option.extension,
                  label: option.label,
                  description: option.description || null,
                  isCustom: option.isCustom
                }))}
                selectedValues={tempSettings.selectedFileExtensions}
                emptyLabel={t('No file types available')}
                allSelectedLabel={t('All file types')}
                searchPlaceholder={t('Search file types...')}
                onChange={(selectedValues) =>
                  setTempSettings((prev) => ({ ...prev, selectedFileExtensions: selectedValues }))
                }
                renderOption={(option) => <ListMenuOption option={option} />}
                onCreateOption={(search) => {
                  if (!createFileExtensionValue) return null
                  const nextExtension = createFileExtensionValue(search)
                  if (!nextExtension) return null
                  setTempSettings((prev) => ({
                    ...prev,
                    customFileExtensions: prev.customFileExtensions.includes(nextExtension)
                      ? prev.customFileExtensions
                      : [...prev.customFileExtensions, nextExtension],
                    selectedFileExtensions: prev.selectedFileExtensions.includes(nextExtension)
                      ? prev.selectedFileExtensions
                      : [...prev.selectedFileExtensions, nextExtension]
                  }))
                  return nextExtension
                }}
                createActionLabel={t('Add file type')}
                createErrorLabel={t('Invalid file extension')}
                onRemoveOption={(extension) => {
                  setTempSettings((prev) => ({
                    ...prev,
                    customFileExtensions: prev.customFileExtensions.filter(
                      (value) => value !== extension
                    ),
                    selectedFileExtensions: prev.selectedFileExtensions.filter(
                      (value) => value !== extension
                    )
                  }))
                }}
                removeOptionLabel={t('Remove file type')}
              />
            </div>
          ) : null}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={handleReset} className="flex-1">
              {t('Reset')}
            </Button>
            <Button onClick={handleApply} className="flex-1">
              {t('Apply')}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </div>
  )

  if (isSmallScreen) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[90vh] overflow-visible px-0">
            <DrawerHeader className="px-4 pb-0" />
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
      <PopoverContent
        className="w-[min(24rem,calc(100vw-1rem))] max-h-[min(82vh,42rem)] overflow-visible p-0"
        collisionPadding={16}
        sideOffset={0}
        align="end"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}

function MultiSelectField({
  triggerLabel,
  options,
  selectedValues,
  emptyLabel,
  allSelectedLabel,
  searchPlaceholder,
  onChange,
  renderOption,
  onCreateOption,
  createActionLabel,
  createErrorLabel,
  onRemoveOption,
  removeOptionLabel
}: {
  triggerLabel: string
  options: TMultiSelectOption[]
  selectedValues: string[]
  emptyLabel: string
  allSelectedLabel: string
  searchPlaceholder: string
  onChange: (selectedValues: string[]) => void
  renderOption: (option: TMultiSelectOption) => ReactNode
  onCreateOption?: (search: string) => string | null
  createActionLabel?: string
  createErrorLabel?: string
  onRemoveOption?: (value: string) => void
  removeOptionLabel?: string
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
  const canCreateOption = Boolean(onCreateOption && search.trim())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className="truncate text-left">{summary}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(22rem,calc(100vw-2rem))] max-h-[min(78vh,28rem)] overflow-visible p-0"
        align="start"
      >
        <div className="border-b p-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
          />
          {canCreateOption ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-start"
              onClick={() => {
                if (!onCreateOption) return
                const nextValue = onCreateOption(search)
                if (!nextValue) {
                  if (createErrorLabel) {
                    toast.error(createErrorLabel)
                  }
                  return
                }
                const nextSelectedValues = new Set(selectedValues)
                nextSelectedValues.add(nextValue)
                onChange(Array.from(nextSelectedValues))
                setSearch('')
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              {createActionLabel || t('Add')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
          <span>{triggerLabel}</span>
          {filteredOptions.length > 0 ? (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                if (allVisibleSelected) {
                  onChange(
                    selectedValues.filter(
                      (value) => !filteredOptions.some((option) => option.value === value)
                    )
                  )
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
        <ScrollArea
          className={cn(
            options.length > 5 ? 'h-[min(65vh,22rem)]' : 'max-h-[min(65vh,22rem)]'
          )}
        >
          <div className="space-y-1 p-2 pb-3">
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
                    {option.isCustom && onRemoveOption ? (
                      <button
                        type="button"
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={removeOptionLabel || t('Remove')}
                        title={removeOptionLabel || t('Remove')}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onRemoveOption(option.value)
                          if (checked) {
                            onChange(selectedValues.filter((value) => value !== option.value))
                          }
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
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
