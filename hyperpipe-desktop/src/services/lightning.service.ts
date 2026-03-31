import { APP_DISPLAY_NAME, BIG_RELAY_URLS } from '@/constants'
import { getZapInfoFromEvent } from '@/lib/event-metadata'
import { init, launchPaymentModal } from '@getalby/bitcoin-connect-react'
import { bech32 } from '@scure/base'
import { WebLNProvider } from '@webbtc/webln-types'
import dayjs from 'dayjs'
import { NostrEvent } from '@jsr/nostr__tools/wasm'
import { Filter } from '@jsr/nostr__tools/filter'
import * as kinds from '@jsr/nostr__tools/kinds'
import { SubCloser } from '@jsr/nostr__tools/abstract-pool'
import { makeZapRequest } from '@jsr/nostr__tools/nip57'
import { utf8Decoder } from '@jsr/nostr__tools/utils'
import client from './client.service'
import { NostrUser } from '@nostr/gadgets/metadata'
import { getLightningAddressFromProfile } from '@/lib/lightning'
import { pool } from '@nostr/gadgets/global'

class LightningService {
  static instance: LightningService
  provider: WebLNProvider | null = null

  constructor() {
    if (!LightningService.instance) {
      LightningService.instance = this
      init({
        appName: APP_DISPLAY_NAME,
        showBalance: false
      })
    }
    return LightningService.instance
  }

  async zap(
    sender: string,
    recipientOrEvent: string | NostrEvent,
    sats: number,
    comment: string,
    closeOuterModel?: () => void
  ): Promise<{ preimage: string; invoice: string } | null> {
    if (!client.signer) {
      throw new Error('You need to be logged in to zap')
    }
    const { recipient, event } =
      typeof recipientOrEvent === 'string'
        ? { recipient: recipientOrEvent }
        : { recipient: recipientOrEvent.pubkey, event: recipientOrEvent }

    const [profile, receiptRelayList, senderRelayList] = await Promise.all([
      client.fetchProfile(recipient, true),
      client.fetchRelayList(recipient),
      sender
        ? client.fetchRelayList(sender)
        : Promise.resolve({ read: BIG_RELAY_URLS, write: BIG_RELAY_URLS })
    ])
    if (!profile) {
      throw new Error('Recipient not found')
    }
    const zapEndpoint = await this.getZapEndpoint(profile)
    if (!zapEndpoint) {
      throw new Error("Recipient's lightning address is invalid")
    }
    const { callback, lnurl } = zapEndpoint
    const amount = sats * 1000
    const zapRequestDraft = makeZapRequest({
      ...(event ? { event } : { pubkey: recipient }),
      amount,
      relays: receiptRelayList.read
        .slice(0, 4)
        .concat(senderRelayList.write.slice(0, 3))
        .concat(BIG_RELAY_URLS),
      comment
    })
    const zapRequest = await client.signer.signEvent(zapRequestDraft)
    const separator = callback.includes('?') ? '&' : '?'
    const zapRequestRes = await fetch(
      `${callback}${separator}amount=${amount}&nostr=${encodeURI(JSON.stringify(zapRequest))}&lnurl=${lnurl}`
    )
    const zapRequestResBody = await zapRequestRes.json()
    if (zapRequestResBody.error) {
      throw new Error(zapRequestResBody.message)
    }
    const { pr, reason } = zapRequestResBody
    if (!pr) {
      throw new Error(reason ?? 'Failed to create invoice')
    }

    if (this.provider) {
      const { preimage } = await this.provider.sendPayment(pr)
      closeOuterModel?.()
      return { preimage, invoice: pr }
    }

    let subCloser: SubCloser | undefined
    return new Promise((resolve) => {
      closeOuterModel?.()
      let checkPaymentInterval: ReturnType<typeof setInterval> | undefined
      const { setPaid } = launchPaymentModal({
        invoice: pr,
        onPaid: (response) => {
          clearInterval(checkPaymentInterval)
          subCloser?.close?.()
          resolve({ preimage: response.preimage, invoice: pr })
        },
        onCancelled: () => {
          clearInterval(checkPaymentInterval)
          subCloser?.close?.()
          resolve(null)
        }
      })

      const filter: Filter = {
        kinds: [kinds.Zap],
        '#p': [recipient],
        since: dayjs().subtract(1, 'minute').unix()
      }
      if (event) {
        filter['#e'] = [event.id]
      }
      subCloser = pool.subscribe(senderRelayList.write.concat(BIG_RELAY_URLS).slice(0, 4), filter, {
        label: 'f-zap',
        onevent: (evt) => {
          const info = getZapInfoFromEvent(evt)
          if (!info) return

          if (info.invoice === pr) {
            setPaid({ preimage: info.preimage ?? '' })
          }
        }
      })
    })
  }

  async payInvoice(
    invoice: string,
    closeOuterModel?: () => void
  ): Promise<{ preimage: string; invoice: string } | null> {
    if (this.provider) {
      const { preimage } = await this.provider.sendPayment(invoice)
      closeOuterModel?.()
      return { preimage, invoice: invoice }
    }

    return new Promise((resolve) => {
      closeOuterModel?.()
      launchPaymentModal({
        invoice: invoice,
        onPaid: (response) => {
          resolve({ preimage: response.preimage, invoice: invoice })
        },
        onCancelled: () => {
          resolve(null)
        }
      })
    })
  }

  private async getZapEndpoint(profile: NostrUser): Promise<null | {
    callback: string
    lnurl: string
  }> {
    try {
      let lnurl: string = ''

      const address = getLightningAddressFromProfile(profile)
      if (!address) return null

      if (address.includes('@')) {
        const [name, domain] = address.split('@')
        lnurl = new URL(`/.well-known/lnurlp/${name}`, `https://${domain}`).toString()
      } else {
        const { words } = bech32.decode(address as any, 1000)
        const data = bech32.fromWords(words)
        lnurl = utf8Decoder.decode(data)
      }

      const res = await fetch(lnurl)
      const body = await res.json()

      if (body.allowsNostr !== false && body.callback) {
        return {
          callback: body.callback,
          lnurl
        }
      }
    } catch (err) {
      console.error(err)
    }

    return null
  }
}

const instance = new LightningService()
export default instance
