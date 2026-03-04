import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import { useGroups } from '@/providers/GroupsProvider'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { normalizeGatewayOrigin } from '@/lib/hypertuna-group-events'
import { toast } from 'sonner'
import Uploader from '@/components/PostEditor/Uploader'
import { Upload, X } from 'lucide-react'

export default function GroupCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { createHypertunaRelayGroup, discoveryGroups } = useGroups()
  const { publicGatewayStatus } = useWorkerBridge()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [gatewaySelection, setGatewaySelection] = useState<'default' | 'custom' | 'none'>('default')
  const [gatewayOriginInput, setGatewayOriginInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const defaultGatewayOrigin = useMemo(
    () => normalizeGatewayOrigin(publicGatewayStatus?.baseUrl || null),
    [publicGatewayStatus?.baseUrl]
  )

  const discoveredGatewayOrigins = useMemo(() => {
    const values = Array.isArray(discoveryGroups)
      ? discoveryGroups
        .map((entry) => normalizeGatewayOrigin(entry?.gatewayOrigin || null))
        .filter((entry): entry is string => !!entry)
      : []
    return Array.from(new Set(values))
  }, [discoveryGroups])

  const gatewayOriginOptions = useMemo(() => {
    return Array.from(
      new Set([
        ...(defaultGatewayOrigin ? [defaultGatewayOrigin] : []),
        ...discoveredGatewayOrigins
      ])
    )
  }, [defaultGatewayOrigin, discoveredGatewayOrigins])

  useEffect(() => {
    if (!open) return
    if (!gatewayOriginInput && defaultGatewayOrigin) {
      setGatewayOriginInput(defaultGatewayOrigin)
    }
  }, [defaultGatewayOrigin, gatewayOriginInput, open])

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    let selectedGatewayOrigin: string | null | undefined
    if (gatewaySelection === 'none') {
      selectedGatewayOrigin = 'none'
    } else if (gatewaySelection === 'custom') {
      const normalized = normalizeGatewayOrigin(gatewayOriginInput)
      if (!normalized) {
        toast.error(t('Please enter a valid gateway origin URL'))
        return
      }
      selectedGatewayOrigin = normalized
    } else {
      selectedGatewayOrigin = defaultGatewayOrigin || undefined
    }

    setIsSaving(true)
    try {
      await createHypertunaRelayGroup({
        name: name.trim(),
        about: about.trim(),
        isPublic,
        isOpen,
        picture: picture.trim() || undefined,
        fileSharing: true,
        gatewayOrigin: selectedGatewayOrigin
      })
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
      setName('')
      setAbout('')
      setPicture('')
      setGatewaySelection('default')
      setGatewayOriginInput(defaultGatewayOrigin || '')
    } catch (err) {
      toast.error(t('Failed to create group'))
      console.error(err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('New Group')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('Group Name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('Enter group name') as string}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('Description')} ({t('optional')})</Label>
            <Textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder={t('Enter group description') as string}
              rows={3}
            />
          </div>
        <div className="space-y-2">
          <Label>{t('Cover Image')} ({t('optional')})</Label>
          <Tabs defaultValue="upload" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="url">URL</TabsTrigger>
                <TabsTrigger value="upload">{t('Upload')}</TabsTrigger>
              </TabsList>
            <TabsContent value="url" className="space-y-2">
              <Input
                value={picture}
                onChange={(e) => setPicture(e.target.value)}
                placeholder="https://..."
              />
            </TabsContent>
            <TabsContent value="upload" className="space-y-2">
              <Uploader
                accept="image/*"
                onUploadSuccess={({ url }) => setPicture(url)}
              >
                <div className="relative w-full h-40 border-2 border-dashed rounded-lg overflow-hidden cursor-pointer hover:bg-accent/50 transition-colors flex items-center justify-center">
                  {!picture && (
                    <div className="text-center p-6">
                      <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm text-muted-foreground">
                        {t('Click to upload an image')}
                      </p>
                    </div>
                  )}
                  {picture && (
                    <>
                      <img src={picture} alt="Preview" className="w-full h-full object-cover" />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 right-2"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPicture('')
                        }}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                </div>
              </Uploader>
            </TabsContent>
          </Tabs>
        </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('Public Group')}</Label>
              <div className="text-xs text-muted-foreground">
                {t('Anyone can discover this group')}
              </div>
            </div>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('Open Membership')}</Label>
              <div className="text-xs text-muted-foreground">
                {t('Anyone can join and invite others')}
              </div>
            </div>
            <Switch checked={isOpen} onCheckedChange={setIsOpen} />
          </div>
          <div className="space-y-2">
            <Label>{t('Gateway Route')} ({t('optional')})</Label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={gatewaySelection}
              onChange={(event) => setGatewaySelection(event.target.value as 'default' | 'custom' | 'none')}
            >
              <option value="default">
                {defaultGatewayOrigin
                  ? `${t('Default gateway')}: ${defaultGatewayOrigin}`
                  : t('Default gateway (none configured)')}
              </option>
              <option value="custom">{t('Custom gateway origin')}</option>
              <option value="none">{t('None (direct-only relay)')}</option>
            </select>
            {gatewaySelection === 'custom' && (
              <>
                <Input
                  value={gatewayOriginInput}
                  onChange={(event) => setGatewayOriginInput(event.target.value)}
                  placeholder="https://gateway.example.com"
                  list="group-gateway-origin-options"
                />
                <datalist id="group-gateway-origin-options">
                  {gatewayOriginOptions.map((origin) => (
                    <option key={origin} value={origin} />
                  ))}
                </datalist>
              </>
            )}
            {gatewaySelection === 'none' && (
              <div className="text-xs text-muted-foreground">
                {t('Gateway-assisted routing is disabled for this relay.')}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? t('Creating...') : t('Create Group')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
