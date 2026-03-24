import { Button } from '@/components/ui/button'
import { APP_DISPLAY_NAME, SUPPORT_PUBKEY } from '@/constants'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ZapDialog from '../ZapDialog'
import RecentSupporters from './RecentSupporters'

export default function Donation({ className }: { className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [donationAmount, setDonationAmount] = useState<number | undefined>(undefined)

  return (
    <div className={cn('p-4 border rounded-lg space-y-4', className)}>
      <div className="text-center font-semibold">
        {t('Enjoying {{appName}}?', {
          appName: APP_DISPLAY_NAME,
          defaultValue: `Enjoying ${APP_DISPLAY_NAME}?`
        })}
      </div>
      <div className="text-center text-muted-foreground">
        {t('Your donation helps me maintain {{appName}} and make it better! 😊', {
          appName: APP_DISPLAY_NAME,
          defaultValue: `Your donation helps me maintain ${APP_DISPLAY_NAME} and make it better! 😊`
        })}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { amount: 1000, text: '☕️ 1k' },
          { amount: 10000, text: '🍜 10k' },
          { amount: 100000, text: '🍣 100k' },
          { amount: 1000000, text: '✈️ 1M' }
        ].map(({ amount, text }) => {
          return (
            <Button
              variant="secondary"
              className=""
              key={amount}
              onClick={() => {
                setDonationAmount(amount)
                setOpen(true)
              }}
            >
              {text}
            </Button>
          )
        })}
      </div>
      <RecentSupporters />
      <ZapDialog
        open={open}
        setOpen={setOpen}
        pubkey={SUPPORT_PUBKEY}
        defaultAmount={donationAmount}
      />
    </div>
  )
}
