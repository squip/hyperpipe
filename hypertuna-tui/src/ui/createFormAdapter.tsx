import React from 'react'
import { Box, Text } from 'ink'
import type { DiscoveredGateway, RelayEntry } from '../domain/types.js'

export type GroupCreateDraft = {
  name: string
  about: string
  membership: 'open' | 'closed'
  visibility: 'public' | 'private'
  directJoinOnly: boolean
  gatewayOrigin: string
  gatewayId: string
}

export type ChatCreateDraft = {
  name: string
  description: string
  inviteMembers: string[]
  relayUrls: string[]
}

export type CreateChoiceOption = {
  label: string
  value: string
}

export type CreateEditableField =
  | 'name'
  | 'about'
  | 'membership'
  | 'visibility'
  | 'directJoinOnly'
  | 'gatewayOrigin'
  | 'gatewayId'
  | 'description'
  | 'inviteMembers'
  | 'relayUrls'

export type CreateBrowseRow =
  | {
      key: string
      kind: 'field'
      label: string
      value: string
      field: CreateEditableField
      editor: 'text' | 'choice'
      options?: CreateChoiceOption[]
      required?: boolean
    }
  | {
      key: string
      kind: 'gateway-refresh'
      label: string
    }
  | {
      key: string
      kind: 'gateway-option'
      label: string
      gatewayId: string
      gatewayOrigin: string
    }
  | {
      key: string
      kind: 'chat-relay'
      label: string
      relayUrl: string
    }
  | {
      key: string
      kind: 'submit'
      label: string
    }

export type CreateEditState =
  | {
      node: 'groups:create' | 'chats:create'
      field: CreateEditableField
      label: string
      editor: 'text'
      value: string
      required?: boolean
    }
  | {
      node: 'groups:create' | 'chats:create'
      field: CreateEditableField
      label: string
      editor: 'choice'
      options: CreateChoiceOption[]
      selectedIndex: number
    }

function clean(value: unknown): string {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function csvToUniqueList(value: string): string[] {
  return Array.from(new Set(
    String(value || '')
      .split(/[,\s]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
  ))
}

export function groupCreateRows(
  draft: GroupCreateDraft,
  gateways: DiscoveredGateway[]
): CreateBrowseRow[] {
  const rows: CreateBrowseRow[] = [
    {
      key: 'group:name',
      kind: 'field',
      field: 'name',
      label: 'Relay Name',
      value: clean(draft.name) || '-',
      editor: 'text',
      required: true
    },
    {
      key: 'group:about',
      kind: 'field',
      field: 'about',
      label: 'Relay Description',
      value: clean(draft.about) || '-',
      editor: 'text'
    },
    {
      key: 'group:membership',
      kind: 'field',
      field: 'membership',
      label: 'Membership Policy',
      value: draft.membership,
      editor: 'choice',
      options: [
        { label: 'Open', value: 'open' },
        { label: 'Closed', value: 'closed' }
      ]
    },
    {
      key: 'group:visibility',
      kind: 'field',
      field: 'visibility',
      label: 'Visibility',
      value: draft.visibility,
      editor: 'choice',
      options: [
        { label: 'Public', value: 'public' },
        { label: 'Private', value: 'private' }
      ]
    },
    {
      key: 'group:directJoinOnly',
      kind: 'field',
      field: 'directJoinOnly',
      label: 'Direct Join Only',
      value: draft.directJoinOnly ? 'true' : 'false',
      editor: 'choice',
      options: [
        { label: 'true', value: 'true' },
        { label: 'false', value: 'false' }
      ]
    },
    {
      key: 'group:gatewayOrigin',
      kind: 'field',
      field: 'gatewayOrigin',
      label: 'Gateway Origin',
      value: clean(draft.gatewayOrigin) || '-',
      editor: 'text'
    },
    {
      key: 'group:gatewayId',
      kind: 'field',
      field: 'gatewayId',
      label: 'Gateway ID',
      value: clean(draft.gatewayId) || '-',
      editor: 'text'
    }
  ]

  if (!draft.directJoinOnly) {
    rows.push({
      key: 'group:gateway-refresh',
      kind: 'gateway-refresh',
      label: 'Refresh discovered gateways'
    })

    if (!gateways.length) {
      rows.push({
        key: 'group:gateway:none',
        kind: 'gateway-option',
        label: '[ ] no gateways discovered',
        gatewayId: '',
        gatewayOrigin: ''
      })
    } else {
      const selectedId = clean(draft.gatewayId).toLowerCase()
      const selectedOrigin = clean(draft.gatewayOrigin)
      for (const gateway of gateways) {
        const selected = (
          (selectedId && gateway.gatewayId === selectedId)
          || (!selectedId && selectedOrigin && selectedOrigin === gateway.publicUrl)
        )
        const title = clean(gateway.displayName) || gateway.gatewayId
        rows.push({
          key: `group:gateway:${gateway.gatewayId}`,
          kind: 'gateway-option',
          label: `${selected ? '[x]' : '[ ]'} ${title} - ${gateway.publicUrl}`,
          gatewayId: gateway.gatewayId,
          gatewayOrigin: gateway.publicUrl
        })
      }
    }
  }

  rows.push({
    key: 'group:submit',
    kind: 'submit',
    label: 'Create Relay'
  })

  return rows
}

export function chatCreateRows(
  draft: ChatCreateDraft,
  relays: RelayEntry[]
): CreateBrowseRow[] {
  const rows: CreateBrowseRow[] = [
    {
      key: 'chat:name',
      kind: 'field',
      field: 'name',
      label: 'Chat Name',
      value: clean(draft.name) || '-',
      editor: 'text',
      required: true
    },
    {
      key: 'chat:description',
      kind: 'field',
      field: 'description',
      label: 'Chat Description',
      value: clean(draft.description) || '-',
      editor: 'text'
    },
    {
      key: 'chat:inviteMembers',
      kind: 'field',
      field: 'inviteMembers',
      label: 'Invite Members',
      value: draft.inviteMembers.length ? draft.inviteMembers.join(',') : '-',
      editor: 'text'
    },
    {
      key: 'chat:relayUrls',
      kind: 'field',
      field: 'relayUrls',
      label: 'Chat Relays',
      value: draft.relayUrls.length ? String(draft.relayUrls.length) : '0',
      editor: 'text'
    }
  ]

  const writableRelays = relays
    .filter((entry) => entry.writable === true && entry.connectionUrl)
    .map((entry) => ({
      relayKey: entry.relayKey,
      relayUrl: String(entry.connectionUrl || '').trim(),
      name: clean(entry.publicIdentifier) || entry.relayKey
    }))
    .filter((entry) => entry.relayUrl.length > 0)

  for (const entry of writableRelays) {
    rows.push({
      key: `chat:relay:${entry.relayKey}`,
      kind: 'chat-relay',
      relayUrl: entry.relayUrl,
      label: `${draft.relayUrls.includes(entry.relayUrl) ? '[x]' : '[ ]'} ${entry.name} - ${entry.relayUrl}`
    })
  }

  rows.push({
    key: 'chat:submit',
    kind: 'submit',
    label: 'Create Chat'
  })

  return rows
}

type CreateFormAdapterProps = {
  node: 'groups:create' | 'chats:create'
  isFocused: boolean
  rows: CreateBrowseRow[]
  selectedIndex: number
  editState: CreateEditState | null
}

export function CreateFormAdapter(props: CreateFormAdapterProps): React.JSX.Element {
  const title = props.node === 'groups:create' ? 'Create Relay' : 'Create Chat'
  const selected = (index: number): boolean => props.isFocused && !props.editState && index === props.selectedIndex
  const rowEntries = props.rows.map((row, index) => ({ row, index }))
  const fieldRows = rowEntries.filter((entry) => entry.row.kind === 'field')
  const gatewayRows = rowEntries.filter((entry) => (
    entry.row.kind === 'gateway-refresh' || entry.row.kind === 'gateway-option'
  ))
  const relayRows = rowEntries.filter((entry) => entry.row.kind === 'chat-relay')
  const submitRow = rowEntries.find((entry) => entry.row.kind === 'submit') || null

  if (props.editState) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{`Editing ${props.editState.label}`}</Text>
        <Text dimColor>Press ESC to cancel, or Enter to complete field</Text>
        <Box marginTop={1} flexDirection="column">
          {props.editState.editor === 'text' ? (
            <>
              <Text color="cyan">
                {props.editState.label}
                {props.editState.required ? '*' : ''}: 
              </Text>
              <Box borderStyle="round" borderColor="white" paddingX={1}>
                <Text>{props.editState.value.length ? props.editState.value : ' '}</Text>
              </Box>
            </>
          ) : (
            <Box flexDirection="column">
              {props.editState.options.map((option, index) => {
                const isActive = index === props.editState.selectedIndex
                return (
                  <Text key={`${option.value}-${index}`} color={isActive ? 'green' : undefined}>
                    {isActive ? '>' : ' '} {option.label}
                  </Text>
                )
              })}
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="yellow">{title}</Text>
      <Box flexDirection="column">
        {fieldRows.map((entry) => {
          const row = entry.row
          const isSelected = selected(entry.index)
          return (
            <Text key={row.key} color={isSelected ? 'green' : undefined}>
              {(isSelected ? '>' : ' ')} {row.label}: {row.value}
            </Text>
          )
        })}
      </Box>

      {gatewayRows.length > 0 ? (
        <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text color="cyan">Gateway Picker</Text>
          {gatewayRows.map((entry) => {
            const row = entry.row
            return (
              <Text key={row.key} color={selected(entry.index) ? 'green' : undefined}>
                {selected(entry.index) ? '>' : ' '} {row.label}
              </Text>
            )
          })}
        </Box>
      ) : null}

      {relayRows.length > 0 ? (
        <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text color="cyan">Relay Picker</Text>
          {relayRows.map((entry) => {
            const row = entry.row
            return (
              <Text key={row.key} color={selected(entry.index) ? 'green' : undefined}>
                {selected(entry.index) ? '>' : ' '} {row.label}
              </Text>
            )
          })}
        </Box>
      ) : null}

      {submitRow ? (
        <Box>
          <Text color={selected(submitRow.index) ? 'green' : 'yellow'}>
            {selected(submitRow.index) ? '>' : ' '} {`┏━ ${submitRow.row.label} ━┓`}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
