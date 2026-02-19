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
import { useNostr } from '@/providers/NostrProvider'
import { toast } from 'sonner'
import Uploader from '@/components/PostEditor/Uploader'
import { Upload, X } from 'lucide-react'
import GatewaySelector from '@/components/groups/GatewaySelector'

export default function GroupCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { createHypertunaRelayGroup, gatewayMetadata, gatewayDirectory } = useGroups()
  const { pubkey } = useNostr()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [selectedGateways, setSelectedGateways] = useState<
    { origin: string; operatorPubkey: string; policy: 'OPEN' | 'CLOSED' }[]
  >([])
  const [isSaving, setIsSaving] = useState(false)

  const gatewayMetadataByOrigin = useMemo(() => {
    const map = new Map<string, { policy: 'OPEN' | 'CLOSED'; allowList: Set<string> }>()
    for (const entry of gatewayMetadata) {
      const origin = String(entry?.origin || '').trim()
      if (!origin) continue
      map.set(origin, {
        policy: String(entry?.policy || '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        allowList: new Set(
          (Array.isArray(entry?.allowList) ? entry.allowList : [])
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean)
        )
      })
    }
    return map
  }, [gatewayMetadata])

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    setIsSaving(true)
    try {
      const currentPubkey = String(pubkey || '').trim().toLowerCase()
      const rawGateways = Array.isArray(selectedGateways) ? selectedGateways : []
      const deniedClosedGateways: string[] = []
      const gateways = rawGateways.filter((gateway) => {
        const metadata = gatewayMetadataByOrigin.get(gateway.origin)
        const policy = metadata?.policy || gateway.policy
        if (policy !== 'CLOSED') return true
        const allowList = metadata?.allowList
        if (allowList && currentPubkey && allowList.has(currentPubkey)) return true
        deniedClosedGateways.push(gateway.origin)
        return false
      })
      if (deniedClosedGateways.length) {
        toast.warning(
          t('Skipped CLOSED gateways without allow-list access') + `: ${deniedClosedGateways.join(', ')}`
        )
      }
      await createHypertunaRelayGroup({
        name: name.trim(),
        about: about.trim(),
        isPublic,
        isOpen,
        picture: picture.trim() || undefined,
        fileSharing: true,
        gateways
      })
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
      setName('')
      setAbout('')
      setPicture('')
      setSelectedGateways([])
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
            <Label>{t('Gateways')} ({t('optional')})</Label>
            <GatewaySelector
              value={selectedGateways}
              onChange={setSelectedGateways}
              directory={gatewayDirectory}
            />
            {gatewayMetadata.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                {t('CLOSED gateways are shown only when your pubkey is allow-listed in gateway metadata.')}
              </div>
            ) : null}
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
