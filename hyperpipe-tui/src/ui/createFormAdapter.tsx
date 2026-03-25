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

export type CreateBranchKey = 'group:gateway-server' | 'chat:relays'
export type CreateBranchAction = 'gateway-picker' | 'gateway-manual' | 'relay-picker' | 'relay-manual'

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
      kind: 'branch-parent'
      branch: CreateBranchKey
      label: string
      value: string
      expanded: boolean
    }
  | {
      key: string
      kind: 'branch-child'
      branch: CreateBranchKey
      action: CreateBranchAction
      label: string
    }
  | {
      key: string
      kind: 'submit'
      label: string
    }

export type CreateGatewayPickerOption = {
  key: string
  gatewayId: string
  gatewayOrigin: string
  label: string
  selected: boolean
}

export type CreateChatRelayPickerOption = {
  key: string
  relayUrl: string
  selected: boolean
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
  | {
      node: 'groups:create'
      editor: 'gateway-picker'
      selectedIndex: number
    }
  | {
      node: 'groups:create'
      editor: 'gateway-manual'
      selectedField: 'gatewayOrigin' | 'gatewayId'
      gatewayOrigin: string
      gatewayId: string
    }
  | {
      node: 'chats:create'
      editor: 'relay-picker'
      selectedIndex: number
    }

function clean(value: unknown): string {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isHex64(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function shortPubkey(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!isHex64(normalized)) return clean(value)
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`
}

function gatewayOperatorSummary(
  gateway: DiscoveredGateway,
  adminProfileByPubkey: Record<string, { name: string | null }>
): string {
  const operatorPubkey = String(gateway.operatorIdentity?.pubkey || '').trim().toLowerCase()
  if (!isHex64(operatorPubkey)) return ''
  const operatorName = clean(adminProfileByPubkey[operatorPubkey]?.name)
  if (operatorName) {
    return `operator ${operatorName} (${shortPubkey(operatorPubkey)})`
  }
  return `operator ${shortPubkey(operatorPubkey)}`
}

function gatewayServerValue(
  draft: GroupCreateDraft,
  gateways: DiscoveredGateway[],
  adminProfileByPubkey: Record<string, { name: string | null }>
): string {
  const id = clean(draft.gatewayId)
  const origin = clean(draft.gatewayOrigin)
  const selectedGateway = gateways.find((gateway) => {
    if (id && gateway.gatewayId === id.toLowerCase()) return true
    return !id && origin && clean(gateway.publicUrl) === origin
  })
  if (selectedGateway) {
    const title = clean(selectedGateway.displayName) || selectedGateway.gatewayId
    const parts = [title]
    const operator = gatewayOperatorSummary(selectedGateway, adminProfileByPubkey)
    if (operator) parts.push(operator)
    if (selectedGateway.region) parts.push(clean(selectedGateway.region))
    parts.push(clean(selectedGateway.publicUrl))
    return parts.filter(Boolean).join(' | ')
  }
  if (id && origin) return `${id} @ ${origin}`
  if (origin) return origin
  if (id) return id
  return '-'
}

export function csvToUniqueList(value: string): string[] {
  return Array.from(new Set(
    String(value || '')
      .split(/[\s,]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
  ))
}

export function gatewayPickerOptions(
  draft: GroupCreateDraft,
  gateways: DiscoveredGateway[],
  adminProfileByPubkey: Record<string, { name: string | null }> = {}
): CreateGatewayPickerOption[] {
  const selectedId = clean(draft.gatewayId).toLowerCase()
  const selectedOrigin = clean(draft.gatewayOrigin)

  return gateways.map((gateway) => {
    const title = clean(gateway.displayName) || gateway.gatewayId
    const operator = gatewayOperatorSummary(gateway, adminProfileByPubkey)
    const selected = Boolean(
      (selectedId && gateway.gatewayId === selectedId)
      || (!selectedId && selectedOrigin && selectedOrigin === gateway.publicUrl)
    )
    const labelParts = [`${selected ? '[x]' : '[ ]'} ${title}`]
    if (operator) labelParts.push(operator)
    if (gateway.region) labelParts.push(clean(gateway.region))
    labelParts.push(clean(gateway.publicUrl))
    return {
      key: `group:gateway:${gateway.gatewayId}`,
      gatewayId: gateway.gatewayId,
      gatewayOrigin: gateway.publicUrl,
      label: labelParts.filter(Boolean).join(' | '),
      selected
    }
  })
}

export function chatRelayPickerOptions(
  draft: ChatCreateDraft,
  relays: RelayEntry[]
): CreateChatRelayPickerOption[] {
  return relays
    .filter((entry) => entry.writable === true && entry.connectionUrl)
    .map((entry) => String(entry.connectionUrl || '').trim())
    .filter((relayUrl) => relayUrl.length > 0)
    .map((relayUrl) => ({
      key: `chat:relay:${relayUrl}`,
      relayUrl,
      selected: draft.relayUrls.includes(relayUrl)
    }))
}

export function groupCreateRows(
  draft: GroupCreateDraft,
  expandedBranch: CreateBranchKey | '',
  gateways: DiscoveredGateway[],
  adminProfileByPubkey: Record<string, { name: string | null }> = {}
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
    }
  ]

  if (!draft.directJoinOnly) {
    const branch: CreateBranchKey = 'group:gateway-server'
    const expanded = expandedBranch === branch
    rows.push({
      key: 'group:gateway-server',
      kind: 'branch-parent',
      branch,
      label: 'Gateway Server',
      value: gatewayServerValue(draft, gateways, adminProfileByPubkey),
      expanded
    })
    if (expanded) {
      rows.push(
        {
          key: 'group:gateway-server:picker',
          kind: 'branch-child',
          branch,
          action: 'gateway-picker',
          label: 'Gateway Picker'
        },
        {
          key: 'group:gateway-server:manual',
          kind: 'branch-child',
          branch,
          action: 'gateway-manual',
          label: 'Manual entry'
        }
      )
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
  expandedBranch: CreateBranchKey | '',
  _relays: RelayEntry[]
): CreateBrowseRow[] {
  const branch: CreateBranchKey = 'chat:relays'
  const expanded = expandedBranch === branch

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
      key: 'chat:relays',
      kind: 'branch-parent',
      branch,
      label: 'Chat Relays',
      value: String(draft.relayUrls.length),
      expanded
    }
  ]

  if (expanded) {
    rows.push(
      {
        key: 'chat:relays:picker',
        kind: 'branch-child',
        branch,
        action: 'relay-picker',
        label: 'Relay Picker'
      },
      {
        key: 'chat:relays:manual',
        kind: 'branch-child',
        branch,
        action: 'relay-manual',
        label: 'Manual entry'
      }
    )
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
  groupGatewayOptions: CreateGatewayPickerOption[]
  chatRelayOptions: CreateChatRelayPickerOption[]
}

export function CreateFormAdapter(props: CreateFormAdapterProps): React.JSX.Element {
  const title = props.node === 'groups:create' ? 'Create Relay' : 'Create Chat'
  const selected = (index: number): boolean => props.isFocused && !props.editState && index === props.selectedIndex
  const rowEntries = props.rows.map((row, index) => ({ row, index }))

  if (props.editState) {
    if (props.editState.editor === 'text') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{`Editing ${props.editState.label}`}</Text>
          <Text dimColor>Press ESC to cancel, or Enter to complete field</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">
              {props.editState.label}
              {props.editState.required ? '*' : ''}: 
            </Text>
            <Box borderStyle="round" borderColor="white" paddingX={1}>
              <Text color="white">{props.editState.value.length ? props.editState.value : ' '}</Text>
            </Box>
          </Box>
        </Box>
      )
    }

    if (props.editState.editor === 'choice') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{`Editing ${props.editState.label}`}</Text>
          <Text dimColor>Use arrow keys to choose, then Enter to apply</Text>
          <Box marginTop={1} flexDirection="column">
            {props.editState.options.map((option, index) => {
              const isActive = index === props.editState.selectedIndex
              return (
                <Text key={`${option.value}-${index}`} color={isActive ? 'green' : undefined}>
                  {isActive ? '>' : ' '} {option.label}
                </Text>
              )
            })}
          </Box>
        </Box>
      )
    }

    if (props.editState.editor === 'gateway-picker') {
      return (
        <Box flexDirection="column">
          <Text dimColor>Editing Gateway Server: Gateway Picker</Text>
          <Text dimColor>Enter refreshes/selects. Esc closes this editor.</Text>
          <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
            <Text color="cyan">Gateway Picker</Text>
            <Text color={props.editState.selectedIndex === 0 ? 'green' : undefined}>
              {props.editState.selectedIndex === 0 ? '>' : ' '} Refresh discovered gateways
            </Text>
            {props.groupGatewayOptions.length === 0 ? (
              <Text color={props.editState.selectedIndex === 1 ? 'green' : 'gray'}>
                {props.editState.selectedIndex === 1 ? '>' : ' '} [ ] no gateways discovered
              </Text>
            ) : props.groupGatewayOptions.map((option, optionIndex) => {
              const isActive = props.editState.selectedIndex === optionIndex + 1
              return (
                <Text key={option.key} color={isActive ? 'green' : undefined}>
                  {isActive ? '>' : ' '} {option.label}
                </Text>
              )
            })}
          </Box>
        </Box>
      )
    }

    if (props.editState.editor === 'gateway-manual') {
      const editingOrigin = props.editState.selectedField === 'gatewayOrigin'
      return (
        <Box flexDirection="column">
          <Text dimColor>Editing Gateway Server: Manual entry</Text>
          <Text dimColor>Use ↑/↓ to switch field, Enter to save, Esc to cancel</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color={editingOrigin ? 'green' : 'gray'}>{editingOrigin ? '>' : ' '}</Text>
              <Text> </Text>
              <Text color="yellow">Gateway Origin</Text>
              <Text color="white">: {props.editState.gatewayOrigin || '-'}</Text>
            </Text>
            <Text>
              <Text color={!editingOrigin ? 'green' : 'gray'}>{!editingOrigin ? '>' : ' '}</Text>
              <Text> </Text>
              <Text color="yellow">Gateway ID</Text>
              <Text color="white">: {props.editState.gatewayId || '-'}</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>Editing Chat Relays: Relay Picker</Text>
        <Text dimColor>Use ↑/↓ then Enter to toggle relay URLs. Esc closes this editor.</Text>
        <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text color="cyan">Relay Picker</Text>
          {props.chatRelayOptions.length === 0 ? (
            <Text color="gray">  [ ] no writable relays discovered</Text>
          ) : props.chatRelayOptions.map((option, optionIndex) => {
            const isActive = props.editState.selectedIndex === optionIndex
            return (
              <Text key={option.key} color={isActive ? 'green' : undefined}>
                {isActive ? '>' : ' '} {option.selected ? '[x]' : '[ ]'} {option.relayUrl}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="yellow">{title}</Text>
      <Box flexDirection="column">
        {rowEntries.map((entry) => {
          const isSelected = selected(entry.index)
          const prefix = isSelected ? '>' : ' '

          if (entry.row.kind === 'field') {
            return (
              <Text key={entry.row.key}>
                <Text color={isSelected ? 'green' : 'gray'}>{prefix}</Text>
                <Text> </Text>
                <Text color="cyan">{entry.row.label}</Text>
                <Text color="white">: {entry.row.value}</Text>
              </Text>
            )
          }

          if (entry.row.kind === 'branch-parent') {
            return (
              <Text key={entry.row.key}>
                <Text color={isSelected ? 'green' : 'gray'}>{prefix}</Text>
                <Text> </Text>
                <Text color="blue">{entry.row.expanded ? '▾' : '▸'} </Text>
                <Text color="cyan">{entry.row.label}</Text>
                <Text color="white">: {entry.row.value}</Text>
              </Text>
            )
          }

          if (entry.row.kind === 'branch-child') {
            return (
              <Text key={entry.row.key}>
                <Text color={isSelected ? 'green' : 'gray'}>{prefix}</Text>
                <Text color="blue">   └─ </Text>
                <Text color={isSelected ? 'green' : 'white'}>{entry.row.label}</Text>
              </Text>
            )
          }

          return (
            <Text key={entry.row.key}>
              <Text color={isSelected ? 'green' : 'gray'}>{prefix}</Text>
              <Text color={isSelected ? 'green' : 'yellow'}>{` ┏━ ${entry.row.label} ━┓`}</Text>
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}
