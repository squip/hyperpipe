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
          displayName: 'Hyperpipe'
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
    expect(model.cards[0]?.title).toBe('Hyperpipe')
    expect(model.cards[0]?.relays.map((relay) => relay.label)).toContain('npub:alpha')
    expect(model.cards.some((card) => card.title === 'Unknown gateway')).toBe(true)
  })

  it('dedupes alias relay rows and keeps them under the matched public gateway', () => {
    const model = buildPublicGatewayPanelModel({
      authorizedGateways: [
        {
          gatewayId: 'gw-1',
          publicUrl: 'https://hypertuna.com',
          displayName: 'hypertuna.com Public Gateway'
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
        relayCanonical: {
          status: 'registered',
          gatewayId: 'gw-1',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'npub1owner:alpha',
          name: 'Alpha'
        },
        relayAlias: {
          status: 'registered',
          gatewayId: 'gw-1',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'npub1owner:alpha'
        },
        'public-gateway:hyperbee': {
          status: 'registered',
          gatewayId: 'gw-1',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'public-gateway:hyperbee'
        }
      }
    })

    expect(model.cards).toHaveLength(1)
    expect(model.cards[0]?.title).toBe('hypertuna.com Public Gateway')
    expect(model.cards[0]?.relays).toHaveLength(1)
    expect(model.cards[0]?.relays[0]?.label).toBe('Alpha')
    expect(model.cards[0]?.relays[0]?.subtitle).toBe('npub1owner:alpha')
  })

  it('groups relays by shared gateway origin even when their gateway ids differ', () => {
    const model = buildPublicGatewayPanelModel({
      authorizedGateways: [
        {
          gatewayId: 'gw-canonical',
          publicUrl: 'https://hypertuna.com',
          displayName: 'hypertuna.com Public Gateway'
        }
      ],
      gatewayAccessCatalog: [
        {
          gatewayId: 'gw-canonical',
          gatewayOrigin: 'https://hypertuna.com',
          hostingState: 'approved',
          lastCheckedAt: 100
        }
      ],
      relays: {
        relayA: {
          status: 'registered',
          gatewayId: 'gw-relay-a',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'npub1owner:alpha'
        },
        relayB: {
          status: 'registered',
          gatewayId: 'gw-relay-b',
          gatewayOrigin: 'https://hypertuna.com',
          publicIdentifier: 'npub1owner:beta'
        }
      }
    })

    expect(model.cards).toHaveLength(1)
    expect(model.cards[0]?.title).toBe('hypertuna.com Public Gateway')
    expect(model.cards[0]?.relays).toHaveLength(2)
  })
})
