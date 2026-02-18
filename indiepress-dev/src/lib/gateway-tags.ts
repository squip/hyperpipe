import { TGatewayDescriptor } from '@/types/groups'
import {
  normalizeGatewayOrigin,
  normalizeGatewayPolicy,
  normalizeGatewayPubkey
} from '@/lib/hypertuna-group-events'

export function dedupeGatewayDescriptors(
  gateways: Array<TGatewayDescriptor | null | undefined>
): TGatewayDescriptor[] {
  const deduped: TGatewayDescriptor[] = []
  const seen = new Set<string>()
  for (const entry of gateways) {
    const origin = normalizeGatewayOrigin(entry?.origin)
    const operatorPubkey = normalizeGatewayPubkey(entry?.operatorPubkey)
    if (!origin || !operatorPubkey || seen.has(origin)) continue
    seen.add(origin)
    deduped.push({
      origin,
      operatorPubkey,
      policy: normalizeGatewayPolicy(entry?.policy)
    })
  }
  return deduped
}

export function parseGatewayDescriptorLine(line: string): TGatewayDescriptor | null {
  const [originRaw, operatorRaw, policyRaw] = String(line || '')
    .split(',')
    .map((entry) => entry?.trim() || '')
  const origin = normalizeGatewayOrigin(originRaw)
  const operatorPubkey = normalizeGatewayPubkey(operatorRaw)
  if (!origin || !operatorPubkey) return null
  return {
    origin,
    operatorPubkey,
    policy: normalizeGatewayPolicy(policyRaw)
  }
}

export function parseGatewayDescriptorInput(input: string): TGatewayDescriptor[] {
  const parsed = String(input || '')
    .split('\n')
    .map((line) => parseGatewayDescriptorLine(line))
  return dedupeGatewayDescriptors(parsed)
}

export function serializeGatewayDescriptorInput(gateways: TGatewayDescriptor[] | null | undefined): string {
  return dedupeGatewayDescriptors(Array.isArray(gateways) ? gateways : [])
    .map((entry) => `${entry.origin},${entry.operatorPubkey},${entry.policy}`)
    .join('\n')
}
