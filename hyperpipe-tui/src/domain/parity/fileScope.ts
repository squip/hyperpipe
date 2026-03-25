import type { FileScope, GroupListEntry, GroupSummary } from '../types.js'
import { getBaseRelayUrl } from '../../lib/hyperpipe-group-events.js'

export type ArchivedGroupEntry = {
  groupId: string
  relay?: string | null
}

function isRelayUrl(value: string | null | undefined): boolean {
  if (!value) return false
  return /^wss?:\/\//.test(value)
}

export function dedupeScopedGroupEntries(
  entries: Array<{ groupId: string; relayUrl: string | null; archived: boolean }>
): Array<{ groupId: string; relayUrl: string | null; archived: boolean }> {
  const byKey = new Map<string, { groupId: string; relayUrl: string | null; archived: boolean }>()

  for (const entry of entries) {
    const groupId = String(entry.groupId || '').trim()
    if (!groupId) continue
    const relayUrl = entry.relayUrl ? getBaseRelayUrl(entry.relayUrl) : null
    const key = `${relayUrl || 'local'}|${groupId}`
    const existing = byKey.get(key)
    if (!existing || (existing.archived && !entry.archived)) {
      byKey.set(key, {
        groupId,
        relayUrl,
        archived: Boolean(entry.archived)
      })
    }
  }

  return Array.from(byKey.values())
}

export function buildScopedFileScope(args: {
  myGroupList: GroupListEntry[]
  archivedGroups: ArchivedGroupEntry[]
  discoveryGroups: GroupSummary[]
  resolveRelayUrl: (relay?: string) => string | undefined
}): FileScope {
  const allEntries: Array<{ groupId: string; relayUrl: string | null; archived: boolean }> = []

  for (const entry of args.myGroupList) {
    const groupId = String(entry.groupId || '').trim()
    if (!groupId) continue
    const discovery = args.discoveryGroups.find((group) => group.id === groupId)
    const candidates = [entry.relay, discovery?.relay, groupId]
      .map((relay) => args.resolveRelayUrl(relay || undefined) || relay || null)
      .map((relay) => (relay ? getBaseRelayUrl(relay) : null))
    const relayUrl = candidates.find((relay) => isRelayUrl(relay)) || null
    allEntries.push({ groupId, relayUrl, archived: false })
  }

  for (const entry of args.archivedGroups) {
    const groupId = String(entry.groupId || '').trim()
    if (!groupId) continue
    const relayUrl = entry.relay
      ? getBaseRelayUrl(args.resolveRelayUrl(entry.relay || undefined) || entry.relay)
      : null
    allEntries.push({ groupId, relayUrl, archived: true })
  }

  const deduped = dedupeScopedGroupEntries(allEntries)
  const localGroupIds = Array.from(new Set(deduped.map((entry) => entry.groupId))).sort()

  const relayGroupsMap = new Map<string, Set<string>>()
  for (const entry of deduped) {
    if (!entry.relayUrl || entry.archived) continue
    const set = relayGroupsMap.get(entry.relayUrl) || new Set<string>()
    set.add(entry.groupId)
    relayGroupsMap.set(entry.relayUrl, set)
  }

  const relayGroups = Array.from(relayGroupsMap.entries())
    .map(([relayUrl, groupIds]) => ({
      relayUrl,
      groupIds: Array.from(groupIds).sort()
    }))
    .sort((left, right) => left.relayUrl.localeCompare(right.relayUrl))

  const fallbackRelays = Array.from(
    new Set(
      [
        ...args.myGroupList.map((entry) => args.resolveRelayUrl(entry.relay || undefined) || entry.relay),
        ...args.archivedGroups.map((entry) => args.resolveRelayUrl(entry.relay || undefined) || entry.relay),
        ...args.discoveryGroups.map((group) => args.resolveRelayUrl(group.relay || undefined) || group.relay)
      ]
        .filter((relay): relay is string => typeof relay === 'string' && relay.trim().length > 0)
        .map((relay) => getBaseRelayUrl(relay))
        .filter((relay) => isRelayUrl(relay))
    )
  ).sort()

  return {
    localGroupIds,
    relayGroups,
    fallbackRelays
  }
}
