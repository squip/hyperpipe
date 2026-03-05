import { useMemo, useState } from 'react'
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
  const { createHypertunaRelayGroup } = useGroups()
  const { publicGatewayStatus } = useWorkerBridge()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [gatewaySelection, setGatewaySelection] = useState<string>('direct')
  const [manualGatewayOrigin, setManualGatewayOrigin] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const discoveredGateways = useMemo(() => {
    const rows = Array.isArray((publicGatewayStatus as any)?.discoveredGateways)
      ? ((publicGatewayStatus as any).discoveredGateways as Array<Record<string, unknown>>)
      : []
    return rows
      .map((row) => {
        const gatewayId = typeof row.gatewayId === 'string' ? row.gatewayId.trim().toLowerCase() : ''
        const publicUrl = typeof row.publicUrl === 'string' ? row.publicUrl.trim() : ''
        const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : ''
        const region = typeof row.region === 'string' ? row.region.trim() : ''
        const isExpired = row.isExpired === true
        if (!gatewayId || !publicUrl || isExpired) return null
        return {
          gatewayId,
          publicUrl,
          displayName,
          region
        }
      })
      .filter((row): row is { gatewayId: string; publicUrl: string; displayName: string; region: string } => !!row)
  }, [publicGatewayStatus])

  const normalizeHttpOrigin = (value: string): string | null => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return null
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.origin
    } catch {
      return null
    }
  }

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    setIsSaving(true)
    try {
      let gatewayOrigin: string | null = null
      let gatewayId: string | null = null
      let directJoinOnly = false

      if (gatewaySelection === 'direct') {
        directJoinOnly = true
      } else if (gatewaySelection === 'manual') {
        gatewayOrigin = normalizeHttpOrigin(manualGatewayOrigin)
        if (!gatewayOrigin) {
          toast.error(t('Enter a valid gateway URL'))
          setIsSaving(false)
          return
        }
      } else if (gatewaySelection.startsWith('gateway:')) {
        const selected = discoveredGateways.find(
          (gateway) => `gateway:${gateway.gatewayId}` === gatewaySelection
        )
        if (!selected) {
          toast.error(t('Selected gateway is unavailable'))
          setIsSaving(false)
          return
        }
        gatewayId = selected.gatewayId
        gatewayOrigin = normalizeHttpOrigin(selected.publicUrl)
      }

      await createHypertunaRelayGroup({
        name: name.trim(),
        about: about.trim(),
        isPublic,
        isOpen,
        picture: picture.trim() || undefined,
        fileSharing: true,
        gatewayOrigin,
        gatewayId,
        directJoinOnly
      })
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
      setName('')
      setAbout('')
      setPicture('')
      setGatewaySelection('direct')
      setManualGatewayOrigin('')
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
            <Label>{t('Public Gateway')}</Label>
            <select
              value={gatewaySelection}
              onChange={(event) => setGatewaySelection(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="direct">{t('Direct-join only (no gateway)')}</option>
              {discoveredGateways.map((gateway) => (
                <option key={gateway.gatewayId} value={`gateway:${gateway.gatewayId}`}>
                  {gateway.displayName || gateway.gatewayId}
                  {gateway.region ? ` (${gateway.region})` : ''} - {gateway.publicUrl}
                </option>
              ))}
              <option value="manual">{t('Manual gateway URL')}</option>
            </select>
            {gatewaySelection === 'manual' && (
              <Input
                value={manualGatewayOrigin}
                onChange={(event) => setManualGatewayOrigin(event.target.value)}
                placeholder="https://gateway.example.com"
              />
            )}
            <div className="text-xs text-muted-foreground">
              {t('This gateway assignment is stored on group metadata and used for relay-specific join/mirror routing.')}
            </div>
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
