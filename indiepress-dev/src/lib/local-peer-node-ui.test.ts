import { describe, expect, it } from 'vitest'
import { buildPublicGatewayPanelModel, deriveLocalProxyHost } from '@/lib/local-peer-node-ui'

describe('local-peer-node-ui', () => {
  it('derives a local proxy host from websocket gateway status', () => {
    expect(
      deriveLocalProxyHost({
        running: true,
        urls: {
          hostname: 'ws://127.0.0.1:63144'
        }
      })
    ).toBe('http://127.0.0.1:63144')
  })

  it('groups registered relays under their public gateway and keeps an unknown bucket', () => {
    const model = buildPublicGatewayPanelModel({
      authorizedGateways: [
        {
          gatewayId: 'gw-1',
          publicUrl: 'https://hypertuna.com',
          displayName: 'Hypertuna'
        }
      ],
      gatewayAccessCatalog: [
        {
          gatewayId: 'gw-1',
          gatewayOrigin: 'https://hypertuna.com',
          hostingState: 'approved',
          lastCheckedAt: 100
        }
      ],
      relays: {
        relayA: {
          status: 'registered',
          gatewayId: 'gw-1',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'npub:alpha'
        },
        relayB: {
          status: 'offline',
          publicIdentifier: 'npub:beta'
        }
      }
    })

    expect(model.approvedCount).toBe(1)
    expect(model.cards[0]?.title).toBe('Hypertuna')
    expect(model.cards[0]?.relays.map((relay) => relay.label)).toContain('npub:alpha')
    expect(model.cards.some((card) => card.title === 'Unknown gateway')).toBe(true)
  })
})
