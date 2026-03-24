import { Label } from '@/components/ui/label'
import {
  HOSTED_TRANSLATION_SERVICE_ID,
  HOSTED_TRANSLATION_SERVICE_LABEL
} from '@/constants'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useTranslationService } from '@/providers/TranslationServiceProvider'
import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import FevelaTranslate from './FevelaTranslate'
import LibreTranslate from './LibreTranslate'

const TranslationPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const { config, updateConfig } = useTranslationService()

  return (
    <SecondaryPageLayout ref={ref} index={index} title={t('Translation')}>
      <div className="px-4 pt-3 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="translation-service-select" className="text-base font-medium">
            {t('Service')}
          </Label>
          <Select
            defaultValue={config.service}
            value={config.service}
            onValueChange={(newService) => {
              updateConfig({
                service: newService as typeof HOSTED_TRANSLATION_SERVICE_ID | 'libre_translate'
              })
            }}
          >
            <SelectTrigger id="translation-service-select" className="w-[180px]">
              <SelectValue placeholder={t('Select Translation Service')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HOSTED_TRANSLATION_SERVICE_ID}>
                {HOSTED_TRANSLATION_SERVICE_LABEL}
              </SelectItem>
              <SelectItem value="libre_translate">LibreTranslate</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {config.service === HOSTED_TRANSLATION_SERVICE_ID ? <FevelaTranslate /> : <LibreTranslate />}
      </div>
    </SecondaryPageLayout>
  )
})
TranslationPage.displayName = 'TranslationPage'
export default TranslationPage
