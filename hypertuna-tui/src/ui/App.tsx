import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { TuiController, type ControllerState, type RuntimeOptions } from '../domain/controller.js'
import type { GroupJoinRequest } from '../domain/types.js'
import { copy as copyToClipboard } from '../runtime/clipboard.js'
import {
  FILE_FAMILY_ORDER,
  FILE_FAMILY_LABELS,
  type FileFamily,
  fileFamilyFromNodeId,
  isFileTypeNodeId,
  isParentNavId,
  ROOT_NAV_LABELS,
  ROOT_NAV_ORDER,
  type NavNodeId,
  type ParentNavId
} from '../lib/constants.js'
import { shortId } from '../lib/format.js'
import {
  buildCommandSnippet,
  executeCommand,
  type CommandContext,
  type CommandController
} from './commandRouter.js'
import {
  parseKeyValueLine,
  formatTableRows,
  shouldUseKeyValueTable,
  type TableColumn,
  type TableRowView
} from './tableFormatter.js'
import {
  CreateFormAdapter,
  chatCreateRows,
  chatRelayPickerOptions,
  csvToUniqueList,
  gatewayPickerOptions,
  groupCreateRows,
  type CreateBranchKey,
  type CreateBrowseRow,
  type CreateChatRelayPickerOption,
  type CreateEditableField,
  type CreateEditState,
  type CreateGatewayPickerOption,
  type ChatCreateDraft,
  type GroupCreateDraft
} from './createFormAdapter.js'

type AppProps = {
  options: RuntimeOptions
  controllerFactory?: (options: RuntimeOptions) => AppController
  scriptedCommands?: ScriptedCommand[]
  autoExitOnScriptComplete?: boolean
}

export interface AppController extends CommandController {
  initialize(): Promise<void>
  subscribe(listener: (state: ControllerState) => void): () => void
  getState(): ControllerState
  shutdown(): Promise<void>
  setPaneViewport(sectionKey: string, cursor: number, offset: number): Promise<void>
  setDetailPaneOffset(sectionKey: string, offset: number): Promise<void>
  setSelectedNode(nodeId: NavNodeId): Promise<void>
  setFocusPane(focusPane: 'left-tree' | 'right-top' | 'right-bottom'): Promise<void>
  setTreeExpanded(nextExpanded: {
    groups: boolean
    chats: boolean
    invites: boolean
    files: boolean
  }): Promise<void>
  setRightTopSelection(nodeId: string, index: number): Promise<void>
}

export type ScriptedCommand = {
  command?: string
  resolveCommand?: (controller: AppController) => string | null | Promise<string | null>
  delayMs?: number
  pauseAfterMs?: number
  timeoutMs?: number
}

type FocusPane = 'left-tree' | 'right-top' | 'right-bottom'
type TreeExpanded = { groups: boolean; chats: boolean; invites: boolean; files: boolean }
type ViewportMap = Record<string, { cursor: number; offset: number }>
type OffsetMap = Record<string, number>
type IndexMap = Record<string, number>

type NavRow = {
  id: NavNodeId
  label: string
  depth: number
  parent: ParentNavId | null
  isParent: boolean
  expanded: boolean
}

type CenterRow = {
  key: string
  label: string
  kind:
    | 'summary'
    | 'relay'
    | 'group'
    | 'group-invite'
    | 'chat-invite'
    | 'chat-conversation'
    | 'form-field'
    | 'form-option'
    | 'file'
    | 'account'
    | 'log'
  data: unknown
}

type CreateNodeId = 'groups:create' | 'chats:create'
type CreateCursorMap = Record<CreateNodeId, number>
type CreateExpandedBranchMap = Record<CreateNodeId, CreateBranchKey | ''>

type InviteComposeTarget = {
  kind: 'group' | 'chat'
  id: string
  relay: string | null
  name: string
  isPublic?: boolean
  isOpen?: boolean
}

type InviteComposeState = {
  target: InviteComposeTarget
  query: string
  suggestions: ProfileSuggestion[]
  suggestionIndex: number
  busy: boolean
  status: string
}

type JoinRequestReviewState = {
  groupId: string
  groupName: string
  relay: string | null
  request: GroupJoinRequest
  selectedAction: 'approve' | 'dismiss'
  busy: boolean
  status: string
}

type RightTopRow = {
  key: string
  label: string
  centerRow: CenterRow
  depth: number
  kind: 'parent' | 'action'
  action?: string
  expandable: boolean
  expanded: boolean
}

type DetailSegment = {
  text: string
  color?: 'blue' | 'yellow' | 'cyan' | 'white' | 'green' | 'gray'
  dimColor?: boolean
}

type DetailRenderRow =
  | {
      key: string
      kind: 'plain'
      text: string
    }
  | {
      key: string
      kind: 'kv-rule'
      left: string
      fieldRule: string
      middle: string
      valueRule: string
      right: string
    }
  | {
      key: string
      kind: 'kv-header' | 'kv-data'
      field: string
      value: string
    }
  | {
      key: string
      kind: 'segments'
      segments: DetailSegment[]
    }

type ActionBlockPosition = 'single' | 'top' | 'middle' | 'bottom'

function sanitizeDisplayCell(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateDisplayCell(value: string, width: number): string {
  const safeWidth = Math.max(1, width)
  if (value.length <= safeWidth) return value
  if (safeWidth === 1) return '…'
  return `${value.slice(0, safeWidth - 1)}…`
}

function padDisplayCell(value: string, width: number): string {
  if (value.length >= width) return value
  return value.padEnd(width, ' ')
}

function centerDisplayCell(value: string, width: number): string {
  if (value.length >= width) return value
  const total = width - value.length
  const left = Math.floor(total / 2)
  const right = total - left
  return `${' '.repeat(left)}${value}${' '.repeat(right)}`
}

function buildCenteredHeaderLine(columns: TableColumn[], widths: number[], gap = 2): string {
  if (!columns.length || !widths.length) return ''
  const separator = ' '.repeat(Math.max(1, gap))
  return columns.map((column, index) => {
    const width = widths[index] || 1
    const label = truncateDisplayCell(sanitizeDisplayCell(column.label), width)
    return index === 0
      ? padDisplayCell(label, width)
      : centerDisplayCell(label, width)
  }).join(separator)
}

function coerceDetailLinesToKeyValue(lines: string[]): string[] {
  const normalized: string[] = []
  let detailIndex = 0
  for (const line of lines) {
    const text = sanitizeDisplayCell(line)
    if (!text) continue
    const parsed = parseKeyValueLine(text)
    if (parsed) {
      normalized.push(`${parsed.field}: ${parsed.value}`)
      continue
    }
    detailIndex += 1
    const field = detailIndex === 1 ? 'detail' : `detail${detailIndex}`
    normalized.push(`${field}: ${text.replace(/^>\s*/, '')}`)
  }
  return normalized
}

function isCreateNodeId(node: NavNodeId): node is CreateNodeId {
  return node === 'groups:create' || node === 'chats:create'
}

function actionBlockPosition(rows: RightTopRow[], index: number): ActionBlockPosition | null {
  const row = rows[index]
  if (!row || row.kind !== 'action') return null
  const previousAction = index > 0 && rows[index - 1]?.kind === 'action'
  const nextAction = index < rows.length - 1 && rows[index + 1]?.kind === 'action'
  if (!previousAction && !nextAction) return 'single'
  if (!previousAction) return 'top'
  if (!nextAction) return 'bottom'
  return 'middle'
}

function buildActionDropdownLine(label: string, width: number, position: ActionBlockPosition): string {
  const safeWidth = Math.max(14, width)
  const contentWidth = Math.max(6, safeWidth - 4)
  const text = padDisplayCell(truncateDisplayCell(sanitizeDisplayCell(label), contentWidth), contentWidth)

  if (position === 'single' || position === 'top') {
    return `┌ ${text} ┐`
  }
  if (position === 'middle') {
    return `│ ${text} │`
  }
  return `└ ${text} ┘`
}

function buildKeyValueDetailRows(lines: string[], width: number, forceTable = false): DetailRenderRow[] {
  const parsed = lines
    .map((line) => parseKeyValueLine(line))
    .filter((row): row is { field: string; value: string } => Boolean(row))

  const minimumRows = forceTable ? 1 : 2
  if (parsed.length < minimumRows) {
    return lines.flatMap((line, index) =>
      wrapText(line, width).map((segment, segmentIndex) => ({
        key: `plain:${index}:${segmentIndex}`,
        kind: 'plain' as const,
        text: segment
      }))
    )
  }

  const minFieldWidth = 8
  const minValueWidth = 10
  const innerTotal = Math.max(20, width - 7)
  const maxFieldLen = Math.max(
    5,
    'Field'.length,
    ...parsed.map((entry) => sanitizeDisplayCell(entry.field).length)
  )
  let fieldWidth = clamp(maxFieldLen, minFieldWidth, Math.max(minFieldWidth, innerTotal - minValueWidth))
  let valueWidth = innerTotal - fieldWidth
  if (valueWidth < minValueWidth) {
    valueWidth = minValueWidth
    fieldWidth = Math.max(minFieldWidth, innerTotal - minValueWidth)
  }

  const rows: DetailRenderRow[] = []
  const pushRule = (left: string, middle: string, right: string, key: string): void => {
    rows.push({
      key,
      kind: 'kv-rule',
      left,
      fieldRule: '─'.repeat(fieldWidth + 2),
      middle,
      valueRule: '─'.repeat(valueWidth + 2),
      right
    })
  }

  pushRule('┌', '┬', '┐', 'rule:top')
  rows.push({
    key: 'header',
    kind: 'kv-header',
    field: padDisplayCell('Field', fieldWidth),
    value: padDisplayCell('Value', valueWidth)
  })
  pushRule('├', '┼', '┤', 'rule:header')

  parsed.forEach((entry, index) => {
    rows.push({
      key: `data:${index}`,
      kind: 'kv-data',
      field: padDisplayCell(truncateDisplayCell(sanitizeDisplayCell(entry.field), fieldWidth), fieldWidth),
      value: padDisplayCell(truncateDisplayCell(sanitizeDisplayCell(entry.value), valueWidth), valueWidth)
    })
    if (index < parsed.length - 1) {
      pushRule('├', '┼', '┤', `rule:between:${index}`)
    }
  })
  pushRule('└', '┴', '┘', 'rule:bottom')

  const narrative = lines
    .map((line) => sanitizeDisplayCell(line))
    .filter((line) => !parseKeyValueLine(line) && line.length > 0)

  if (narrative.length) {
    rows.push({
      key: 'narrative:spacer',
      kind: 'plain',
      text: ''
    })
    narrative.forEach((line, index) => {
      const wrapped = wrapText(line, width)
      wrapped.forEach((segment, segmentIndex) => {
        rows.push({
          key: `narrative:${index}:${segmentIndex}`,
          kind: 'plain',
          text: segment
        })
      })
    })
  }

  return rows
}

type DetailTableColumn = {
  key: string
  label: string
  minWidth: number
  priority: number
  align?: 'left' | 'right' | 'center'
  headerColor?: DetailSegment['color']
  cellColor?: DetailSegment['color']
}

function formatDetailCell(value: unknown, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const sanitized = truncateDisplayCell(sanitizeDisplayCell(value === null || value === undefined ? '' : String(value)), width)
  if (align === 'right') {
    return sanitized.padStart(width, ' ')
  }
  if (align === 'center') {
    return centerDisplayCell(sanitized, width)
  }
  return padDisplayCell(sanitized, width)
}

function gridTableLineLength(widths: number[]): number {
  if (widths.length === 0) return 0
  return widths.reduce((total, width) => total + width, 0) + (widths.length * 3) + 1
}

function formatGridDetailTable(input: {
  width: number
  columns: DetailTableColumn[]
  rows: TableRowView[]
}): ReturnType<typeof formatTableRows> {
  const targetWidth = Math.max(18, input.width)
  // Reserve space for grid borders and per-column padding/separators.
  let formatWidth = Math.max(8, targetWidth - ((input.columns.length * 2) + 2))
  let table = formatTableRows({
    columns: input.columns.map((column) => ({
      key: column.key,
      label: column.label,
      minWidth: column.minWidth,
      priority: column.priority,
      align: column.align || 'left'
    })),
    rows: input.rows,
    width: formatWidth,
    gap: 1
  })

  // In narrow terminals, iterate a few times to guarantee final grid lines fit the pane.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const overflow = gridTableLineLength(table.widths) - targetWidth
    if (overflow <= 0) break
    const nextFormatWidth = Math.max(8, formatWidth - overflow)
    if (nextFormatWidth === formatWidth) break
    formatWidth = nextFormatWidth
    table = formatTableRows({
      columns: input.columns.map((column) => ({
        key: column.key,
        label: column.label,
        minWidth: column.minWidth,
        priority: column.priority,
        align: column.align || 'left'
      })),
      rows: input.rows,
      width: formatWidth,
      gap: 1
    })
  }

  return table
}

function buildSegmentedTableRows(input: {
  width: number
  title?: string
  columns: DetailTableColumn[]
  rows: TableRowView[]
  showHeader?: boolean
  noItemsLabel?: string
}): DetailRenderRow[] {
  const showHeader = input.showHeader !== false
  const table = formatGridDetailTable({
    width: input.width,
    columns: input.columns,
    rows: input.rows
  })
  if (!table.columns.length) {
    return [{
      key: 'table:empty',
      kind: 'plain',
      text: input.noItemsLabel || 'No items'
    }]
  }

  const rows: DetailRenderRow[] = []
  if (input.title) {
    rows.push({
      key: 'table:title',
      kind: 'segments',
      segments: [{ text: input.title, color: 'yellow' }]
    })
  }

  const topRule = `┌${table.widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`
  rows.push({
    key: 'table:rule:top',
    kind: 'segments',
    segments: [{ text: topRule, color: 'blue' }]
  })

  const renderRow = (
    keyPrefix: string,
    values: Record<string, string>,
    rowIndex: number,
    header: boolean
  ): DetailRenderRow => {
    const segments: DetailSegment[] = [{ text: '│ ', color: 'blue' }]
    table.columns.forEach((column, columnIndex) => {
      const color = header
        ? (input.columns[columnIndex]?.headerColor || 'yellow')
        : (input.columns[columnIndex]?.cellColor || 'white')
      const align = (input.columns[columnIndex]?.align || 'left') as 'left' | 'right' | 'center'
      const value = formatDetailCell(values[column.key] || '', table.widths[columnIndex] || 1, align)
      segments.push({ text: value, color })
      segments.push({
        text: columnIndex === table.columns.length - 1 ? ' │' : ' │ ',
        color: 'blue'
      })
    })
    return {
      key: `${keyPrefix}:${rowIndex}`,
      kind: 'segments',
      segments
    }
  }

  if (showHeader) {
    const headerValues = Object.fromEntries(table.columns.map((column) => [column.key, column.label]))
    rows.push(renderRow('table:header', headerValues, 0, true))
    const headerRule = `├${table.widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`
    rows.push({
      key: 'table:rule:header',
      kind: 'segments',
      segments: [{ text: headerRule, color: 'blue' }]
    })
  }

  if (input.rows.length === 0) {
    const firstColumn = table.columns[0]
    const valueMap: Record<string, string> = Object.fromEntries(table.columns.map((column) => [column.key, '']))
    valueMap[firstColumn.key] = input.noItemsLabel || 'No items'
    rows.push(renderRow('table:data', valueMap, 0, false))
  } else {
    input.rows.forEach((entry, rowIndex) => {
      const valueMap = Object.fromEntries(
        table.columns.map((column) => [column.key, sanitizeDisplayCell(String(entry[column.key] || ''))])
      )
      rows.push(renderRow('table:data', valueMap, rowIndex, false))
      if (rowIndex < input.rows.length - 1) {
        rows.push({
          key: `table:rule:between:${rowIndex}`,
          kind: 'segments',
          segments: [{ text: `├${table.widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`, color: 'blue' }]
        })
      }
    })
  }

  const bottomRule = `└${table.widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`
  rows.push({
    key: 'table:rule:bottom',
    kind: 'segments',
    segments: [{ text: bottomRule, color: 'blue' }]
  })

  return rows
}

function keyValueTableRows(lines: string[]): TableRowView[] {
  return lines
    .map((line) => parseKeyValueLine(line))
    .filter((entry): entry is { field: string; value: string } => Boolean(entry))
    .map((entry) => ({
      field: entry.field,
      value: entry.value
    }))
}

function buildJoinRequestTableRows(input: {
  width: number
  title: string
  requests: GroupJoinRequest[]
  selectedIndex: number
}): DetailRenderRow[] {
  const columns: DetailTableColumn[] = [
    { key: 'review', label: '', minWidth: 6, priority: 0, align: 'left', headerColor: 'yellow', cellColor: 'cyan' },
    { key: 'date', label: 'Date', minWidth: 18, priority: 1, align: 'left', headerColor: 'yellow', cellColor: 'white' },
    { key: 'from', label: 'From', minWidth: 14, priority: 1, align: 'left', headerColor: 'yellow', cellColor: 'cyan' }
  ]
  const rows = input.requests.map((request) => ({
    review: 'Review',
    date: new Date(request.createdAt * 1000).toLocaleString(),
    from: shortId(request.pubkey, 12)
  }))
  const table = formatGridDetailTable({
    width: input.width,
    columns,
    rows
  })
  if (!table.columns.length) {
    return [{ key: 'join:empty', kind: 'plain', text: 'No pending join requests' }]
  }
  const result: DetailRenderRow[] = [
    {
      key: 'join:title',
      kind: 'segments',
      segments: [{ text: input.title, color: 'yellow' }]
    },
    {
      key: 'join:top',
      kind: 'segments',
      segments: [{ text: `┌${table.widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`, color: 'blue' }]
    }
  ]
  const headerSegments: DetailSegment[] = [{ text: '│ ', color: 'blue' }]
  table.columns.forEach((column, index) => {
    const value = formatDetailCell(column.label, table.widths[index] || 1, (columns[index]?.align || 'left'))
    headerSegments.push({ text: value, color: columns[index]?.headerColor || 'yellow' })
    headerSegments.push({ text: index === table.columns.length - 1 ? ' │' : ' │ ', color: 'blue' })
  })
  result.push({
    key: 'join:header',
    kind: 'segments',
    segments: headerSegments
  })
  result.push({
    key: 'join:header:rule',
    kind: 'segments',
    segments: [{ text: `├${table.widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`, color: 'blue' }]
  })

  if (rows.length === 0) {
    const emptySegments: DetailSegment[] = [{ text: '│ ', color: 'blue' }]
    table.columns.forEach((column, index) => {
      const value = formatDetailCell(index === 1 ? 'No pending join requests' : '', table.widths[index] || 1, index === 1 ? 'left' : (columns[index]?.align || 'left'))
      emptySegments.push({ text: value, color: index === 1 ? 'gray' : (columns[index]?.cellColor || 'white'), dimColor: index === 1 })
      emptySegments.push({ text: index === table.columns.length - 1 ? ' │' : ' │ ', color: 'blue' })
    })
    result.push({
      key: 'join:empty:row',
      kind: 'segments',
      segments: emptySegments
    })
  } else {
    rows.forEach((row, rowIndex) => {
      const rowSegments: DetailSegment[] = [{ text: '│ ', color: 'blue' }]
      table.columns.forEach((column, columnIndex) => {
        const align = (columns[columnIndex]?.align || 'left') as 'left' | 'right' | 'center'
        const value = formatDetailCell(String(row[column.key] || ''), table.widths[columnIndex] || 1, align)
        const isReviewCell = column.key === 'review'
        const selected = isReviewCell && rowIndex === input.selectedIndex
        rowSegments.push({
          text: value,
          color: selected ? 'green' : (columns[columnIndex]?.cellColor || 'white')
        })
        rowSegments.push({ text: columnIndex === table.columns.length - 1 ? ' │' : ' │ ', color: 'blue' })
      })
      result.push({
        key: `join:row:${rowIndex}`,
        kind: 'segments',
        segments: rowSegments
      })
      if (rowIndex < rows.length - 1) {
        result.push({
          key: `join:rule:${rowIndex}`,
          kind: 'segments',
          segments: [{ text: `├${table.widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`, color: 'blue' }]
        })
      }
    })
  }

  result.push({
    key: 'join:bottom',
    kind: 'segments',
    segments: [{ text: `└${table.widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`, color: 'blue' }]
  })
  return result
}

function rightTopTableColumnsForNode(node: NavNodeId): TableColumn[] | null {
  if (node === 'groups:browse' || node === 'groups:my') {
    return [
      { key: 'name', label: 'Name', minWidth: 16, priority: 0 },
      { key: 'visibility', label: 'Vis', minWidth: 7, priority: 1, align: 'center' },
      { key: 'membership', label: 'Join', minWidth: 7, priority: 1, align: 'center' },
      { key: 'members', label: 'Members', minWidth: 7, priority: 2, align: 'center' },
      { key: 'status', label: 'Status', minWidth: 10, priority: 3, align: 'center' }
    ]
  }
  if (node === 'invites:group') {
    return [
      { key: 'relay', label: 'Relay', minWidth: 16, priority: 0 },
      { key: 'members', label: 'Members', minWidth: 7, priority: 1, align: 'center' },
      { key: 'from', label: 'By', minWidth: 10, priority: 1, align: 'center' }
    ]
  }
  if (node === 'invites:chat') {
    return [
      { key: 'chat', label: 'Chat', minWidth: 16, priority: 0 },
      { key: 'status', label: 'Status', minWidth: 8, priority: 1, align: 'center' },
      { key: 'from', label: 'By', minWidth: 10, priority: 1, align: 'center' }
    ]
  }
  if (node === 'files' || isFileTypeNodeId(node)) {
    return [
      { key: 'name', label: 'Name', minWidth: 16, priority: 0 },
      { key: 'mime', label: 'Type', minWidth: 8, priority: 1, align: 'center' },
      { key: 'size', label: 'Size', minWidth: 7, priority: 1, align: 'center' },
      { key: 'relay', label: 'Relay', minWidth: 10, priority: 2, align: 'center' },
      { key: 'by', label: 'By', minWidth: 10, priority: 3, align: 'center' }
    ]
  }
  if (node === 'chats') {
    return [
      { key: 'chat', label: 'Chat', minWidth: 18, priority: 0 },
      { key: 'unread', label: 'Unread', minWidth: 6, priority: 1, align: 'center' }
    ]
  }
  if (node === 'accounts') {
    return [
      { key: 'account', label: 'Account', minWidth: 20, priority: 0 },
      { key: 'signer', label: 'Signer', minWidth: 8, priority: 1, align: 'center' }
    ]
  }
  if (node === 'logs') {
    return [
      { key: 'time', label: 'Time', minWidth: 8, priority: 0 },
      { key: 'level', label: 'Lvl', minWidth: 5, priority: 1, align: 'center' },
      { key: 'message', label: 'Message', minWidth: 16, priority: 2, align: 'center' }
    ]
  }
  return null
}

function rowLead(row: RightTopRow): string {
  if (row.kind === 'action') return '  ↳'
  if (row.expandable) return row.expanded ? '▾' : '▸'
  return '•'
}

function projectRightTopTableRow(
  state: ControllerState,
  node: NavNodeId,
  row: RightTopRow
): TableRowView {
  const lead = rowLead(row)
  if (row.kind === 'action') {
    if (node === 'invites:group') {
      return { relay: `${lead} ${row.label}`, members: '', from: '' }
    }
    if (node === 'invites:chat') {
      return { chat: `${lead} ${row.label}`, status: '', from: '' }
    }
    if (node === 'files' || isFileTypeNodeId(node)) {
      return { name: `${lead} ${row.label}`, mime: '', size: '', relay: '', by: '' }
    }
    if (node === 'groups:browse' || node === 'groups:my') {
      return { name: `${lead} ${row.label}`, visibility: '', membership: '', members: '', status: '' }
    }
    return { name: `${lead} ${row.label}` }
  }

  if ((node === 'groups:browse' || node === 'groups:my') && row.centerRow.kind === 'group') {
    const group = row.centerRow.data as any
    const relay = relayForGroup(state, group)
    const members = Number(group.membersCount || group.members?.length || 0)
    const visibility = group.isPublic === false ? 'private' : 'public'
    const membership = group.isOpen === false ? 'closed' : 'open'
    let status = '-'
    if (node === 'groups:my') {
      status = relay?.readyForReq ? 'ready' : 'read-only'
    } else if (group.isPublic !== false && group.isOpen !== false) {
      status = 'open'
    } else if (group.isPublic !== false) {
      status = 'request'
    } else {
      status = 'private'
    }
    return {
      name: `${lead} ${group.name || group.id || '-'}`,
      visibility,
      membership,
      members: `${members}`,
      status
    }
  }

  if (node === 'invites:group' && row.centerRow.kind === 'group-invite') {
    const invite = row.centerRow.data as any
    const members = invite.event?.tags?.filter((tag: string[]) => tag[0] === 'p').length || 0
    return {
      relay: `${lead} ${invite.groupName || invite.groupId || '-'}`,
      members: `${members}`,
      from: shortId(invite.event?.pubkey || '-', 8)
    }
  }

  if (node === 'invites:chat' && row.centerRow.kind === 'chat-invite') {
    const invite = row.centerRow.data as any
    return {
      chat: `${lead} ${invite.title || invite.id || '-'}`,
      status: invite.status || '-',
      from: shortId(invite.senderPubkey || '-', 8)
    }
  }

  if ((node === 'files' || isFileTypeNodeId(node)) && row.centerRow.kind === 'file') {
    const file = row.centerRow.data as any
    return {
      name: `${lead} ${file.fileName || '-'}`,
      mime: file.mime || '-',
      size: `${Number(file.size || 0)}B`,
      relay: shortText(file.groupName || file.groupId, 18),
      by: shortId(file.uploadedBy || '-', 8)
    }
  }

  if (node === 'chats' && row.centerRow.kind === 'chat-conversation') {
    const conversation = row.centerRow.data as any
    return {
      chat: `${lead} ${conversation.title || conversation.id || '-'}`,
      unread: `${Number(conversation.unreadCount || 0)}`
    }
  }

  if (node === 'accounts' && row.centerRow.kind === 'account') {
    const account = row.centerRow.data as any
    const marker = state.currentAccountPubkey === account.pubkey ? '*' : ' '
    return {
      account: `${lead} ${marker} ${shortId(account.pubkey, 10)}`,
      signer: account.signerType || '-'
    }
  }

  if (node === 'logs' && row.centerRow.kind === 'log') {
    const entry = row.centerRow.data as any
    return {
      time: new Date(entry.ts).toLocaleTimeString(),
      level: String(entry.level || '').toUpperCase(),
      message: `${lead} ${shortText(entry.message, 90)}`
    }
  }

  return {
    name: `${lead} ${row.label}`
  }
}

type ProfileSuggestion = {
  pubkey: string
  name?: string | null
  about?: string | null
  nip05?: string | null
  source?: 'local' | 'remote' | 'cache'
}

const DEFAULT_TREE_EXPANDED: TreeExpanded = {
  groups: true,
  chats: true,
  invites: true,
  files: true
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isHex64(value: string | null | undefined): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function normalizeHttpOrigin(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

function normalizeGatewayId(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim().toLowerCase()
  return trimmed || null
}

function shortText(value: string | null | undefined, max = 80): string {
  if (!value) return ''
  const sanitized = String(value)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (sanitized.length <= max) return sanitized
  return `${sanitized.slice(0, max - 1)}…`
}

function wrapText(input: string, width: number): string[] {
  const text = String(input || '')
  if (!text) return ['']
  const max = Math.max(12, width)
  const words = text.split(/\s+/g)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!word) continue
    const next = current ? `${current} ${word}` : word
    if (next.length <= max) {
      current = next
      continue
    }
    if (current) {
      lines.push(current)
      current = ''
    }
    if (word.length <= max) {
      current = word
      continue
    }
    for (let index = 0; index < word.length; index += max) {
      lines.push(word.slice(index, index + max))
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function normalizeViewport(
  selectedIndex: number,
  offset: number,
  totalRows: number,
  visibleRows: number
): { selectedIndex: number; offset: number } {
  const rows = Math.max(1, visibleRows)
  const total = Math.max(0, totalRows)
  const selected = total <= 0 ? 0 : clamp(selectedIndex, 0, total - 1)
  if (total <= rows) {
    return {
      selectedIndex: selected,
      offset: 0
    }
  }

  const maxOffset = Math.max(0, total - rows)
  let nextOffset = clamp(offset, 0, maxOffset)
  if (selected < nextOffset) {
    nextOffset = selected
  } else if (selected >= nextOffset + rows) {
    nextOffset = selected - rows + 1
  }

  return {
    selectedIndex: selected,
    offset: clamp(nextOffset, 0, maxOffset)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForControllerIdle(controller: AppController, timeoutMs = 45_000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = controller.getState()
    if (!snapshot.busyTask) return true
    await sleep(120)
  }
  return false
}

async function withStepTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Math.max(1_000, Math.min(Math.trunc(timeoutMs || 0), 300_000))
  let timeoutId: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeout}ms`))
        }, timeout)
      })
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function TruncText(props: React.ComponentProps<typeof Text>): React.JSX.Element {
  return <Text {...props} wrap="truncate-end" />
}

function useTerminalDimensions(): [number, number] {
  const { stdout } = useStdout()
  const [dimensions, setDimensions] = useState(() => ({
    width: Number(stdout?.columns || 120),
    height: Number(stdout?.rows || 40)
  }))

  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return

    const update = (): void => {
      const nextWidth = Number(stdout.columns || 120)
      const nextHeight = Number(stdout.rows || 40)
      setDimensions((previous) => {
        if (previous.width === nextWidth && previous.height === nextHeight) {
          return previous
        }
        return {
          width: nextWidth,
          height: nextHeight
        }
      })
    }

    update()
    stdout.on('resize', update)
    return () => {
      if (typeof stdout.off === 'function') {
        stdout.off('resize', update)
      } else {
        stdout.removeListener('resize', update)
      }
    }
  }, [stdout])

  return [dimensions.width, dimensions.height]
}

function frameSegments(totalRows: number): {
  mainRows: number
  commandRows: number
  keysRows: number
  statusRows: number
} {
  const commandRows = 3
  const keysRows = 1
  const statusRows = 1
  const reserved = commandRows + keysRows + statusRows
  const mainRows = Math.max(10, totalRows - reserved)
  return {
    mainRows,
    commandRows,
    keysRows,
    statusRows
  }
}

function fileFamilyForMime(mime?: string | null): FileFamily {
  const normalized = String(mime || '').toLowerCase()
  if (normalized.startsWith('image/')) return 'images'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  if (
    normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('pdf')
    || normalized.includes('markdown')
    || normalized.includes('msword')
    || normalized.includes('officedocument')
  ) {
    return 'docs'
  }
  return 'other'
}

function navRowsFromState(state: ControllerState, expanded: TreeExpanded): NavRow[] {
  const rows: NavRow[] = []
  for (const root of ROOT_NAV_ORDER) {
    if (root === 'relays' || root === 'logs') continue
    let rootLabel = ROOT_NAV_LABELS[root]
    if (root === 'groups') rootLabel = 'P2P Relays'
    if (root === 'invites') rootLabel = `Invites (${state.invitesCount})`
    if (root === 'files') rootLabel = `Files (${state.filesCount})`
    if (root === 'chats') rootLabel = `Chats (${state.chatUnreadTotal + state.chatPendingInviteCount})`

    const isParent = root === 'groups' || root === 'chats' || root === 'invites' || root === 'files'
    const parent = isParent ? (root as ParentNavId) : null
    const isExpanded = isParent ? expanded[root as ParentNavId] : false
    rows.push({
      id: root,
      label: rootLabel,
      depth: 0,
      parent: null,
      isParent,
      expanded: isExpanded
    })

    if (root === 'groups' && expanded.groups) {
      rows.push({
        id: 'groups:browse',
        label: 'Browse Relays',
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'groups:my',
        label: `My Relays (${state.myGroups.length})`,
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'groups:create',
        label: 'Create Relay',
        depth: 1,
        parent: 'groups',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'chats' && expanded.chats) {
      rows.push({
        id: 'chats:create',
        label: 'Create Chat',
        depth: 1,
        parent: 'chats',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'invites' && expanded.invites) {
      rows.push({
        id: 'invites:group',
        label: `Relay Invites (${state.groupInvites.length})`,
        depth: 1,
        parent: 'invites',
        isParent: false,
        expanded: false
      })
      rows.push({
        id: 'invites:chat',
        label: `Chat Invites (${state.chatInvites.length})`,
        depth: 1,
        parent: 'invites',
        isParent: false,
        expanded: false
      })
    }

    if (root === 'files' && expanded.files) {
      for (const family of FILE_FAMILY_ORDER as readonly FileFamily[]) {
        const count = state.fileFamilyCounts[family] || 0
        rows.push({
          id: `files:type:${family}` as NavNodeId,
          label: `${FILE_FAMILY_LABELS[family]} (${count})`,
          depth: 1,
          parent: 'files',
          isParent: false,
          expanded: false
        })
      }
    }
  }
  return rows
}

function centerRowsForNode(state: ControllerState, node: NavNodeId): CenterRow[] {
  if (node === 'dashboard') {
    return [
      {
        key: 'summary',
        label:
          `Worker:${state.lifecycle} p2pRelays:${state.groupDiscover.length} ` +
          `MyRelays:${state.myGroups.length} Invites:${state.invitesCount} Files:${state.filesCount} Chats:${state.conversations.length}`,
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'groups') {
    return [
      {
        key: 'groups:browse',
        label: `Browse Relays (${state.groupDiscover.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'groups:my',
        label: `My Relays (${state.myGroups.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'groups:create',
        label: 'Create Relay',
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'groups:browse') {
    return state.groupDiscover.map((group, idx) => {
      const mode = `${group.isPublic === false ? 'private' : 'public'} | ${group.isOpen === false ? 'closed' : 'open'}`
      const members = group.membersCount || group.members?.length || 0
      return {
        key: `${group.id}-${group.event?.id || idx}`,
        label: `${shortText(group.name, 24)} · ${mode} · members:${members}`,
        kind: 'group',
        data: group
      }
    })
  }

  if (node === 'groups:my') {
    return state.myGroups.map((group, idx) => {
      const mode = `${group.isPublic === false ? 'private' : 'public'} | ${group.isOpen === false ? 'closed' : 'open'}`
      const members = group.membersCount || group.members?.length || 0
      const relay = relayForGroup(state, group)
      const readiness = relay?.readyForReq ? 'ready' : 'read-only'
      return {
        key: `${group.id}-${group.event?.id || idx}`,
        label: `${shortText(group.name, 24)} · ${mode} · members:${members} · ${readiness}`,
        kind: 'group',
        data: group
      }
    })
  }

  if (node === 'groups:create') {
    return [
      {
        key: 'groups:create:name',
        label: 'relay name',
        kind: 'form-field',
        data: { form: 'group-create', field: 'name' }
      },
      {
        key: 'groups:create:about',
        label: 'relay description',
        kind: 'form-field',
        data: { form: 'group-create', field: 'about' }
      },
      {
        key: 'groups:create:membership',
        label: 'membership policy',
        kind: 'form-field',
        data: { form: 'group-create', field: 'membership' }
      },
      {
        key: 'groups:create:membership:open',
        label: '  open',
        kind: 'form-option',
        data: { form: 'group-create', field: 'membership', value: 'open' }
      },
      {
        key: 'groups:create:membership:closed',
        label: '  closed',
        kind: 'form-option',
        data: { form: 'group-create', field: 'membership', value: 'closed' }
      },
      {
        key: 'groups:create:visibility',
        label: 'visibility',
        kind: 'form-field',
        data: { form: 'group-create', field: 'visibility' }
      },
      {
        key: 'groups:create:visibility:public',
        label: '  public',
        kind: 'form-option',
        data: { form: 'group-create', field: 'visibility', value: 'public' }
      },
      {
        key: 'groups:create:visibility:private',
        label: '  private',
        kind: 'form-option',
        data: { form: 'group-create', field: 'visibility', value: 'private' }
      },
      {
        key: 'groups:create:direct-join-only',
        label: 'direct-join-only',
        kind: 'form-field',
        data: { form: 'group-create', field: 'direct-join-only' }
      },
      {
        key: 'groups:create:gateway-picker',
        label: 'gateway picker',
        kind: 'form-field',
        data: { form: 'group-create', field: 'gateway-picker' }
      },
      {
        key: 'groups:create:gateway-refresh',
        label: 'refresh discovered gateways',
        kind: 'form-field',
        data: { form: 'group-create', field: 'gateway-refresh' }
      },
      {
        key: 'groups:create:gateway-origin',
        label: 'gateway origin',
        kind: 'form-field',
        data: { form: 'group-create', field: 'gateway-origin' }
      },
      {
        key: 'groups:create:gateway-id',
        label: 'gateway id (optional)',
        kind: 'form-field',
        data: { form: 'group-create', field: 'gateway-id' }
      },
      {
        key: 'groups:create:submit',
        label: 'create',
        kind: 'form-field',
        data: { form: 'group-create', field: 'submit' }
      }
    ]
  }

  if (node === 'chats') {
    return state.conversations.map((conversation, idx) => ({
      key: `${conversation.id}-${idx}`,
      label: `${shortText(conversation.title, 30)} · unread:${conversation.unreadCount}`,
      kind: 'chat-conversation',
      data: conversation
    }))
  }

  if (node === 'chats:create') {
    const writableRelays = state.relays
      .filter((entry) => entry.writable === true && entry.connectionUrl)
      .map((entry) => ({
        relayKey: entry.relayKey,
        relayUrl: String(entry.connectionUrl || ''),
        name: entry.publicIdentifier || shortId(entry.relayKey, 10)
      }))
    return [
      {
        key: 'chats:create:name',
        label: 'chat name',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'name' }
      },
      {
        key: 'chats:create:about',
        label: 'chat description',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'description' }
      },
      {
        key: 'chats:create:members',
        label: 'invite members',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'members' }
      },
      {
        key: 'chats:create:relays',
        label: 'chat relays',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'relays' }
      },
      ...writableRelays.map((entry) => ({
        key: `chats:create:relay:${entry.relayKey}`,
        label: `  ${entry.name}`,
        kind: 'form-option' as const,
        data: {
          form: 'chat-create',
          field: 'relay',
          value: entry.relayUrl,
          relayKey: entry.relayKey
        }
      })),
      {
        key: 'chats:create:submit',
        label: 'create',
        kind: 'form-field',
        data: { form: 'chat-create', field: 'submit' }
      }
    ]
  }

  if (node === 'invites') {
    return [
      {
        key: 'invites:group',
        label: `Relay Invites (${state.groupInvites.length})`,
        kind: 'summary',
        data: null
      },
      {
        key: 'invites:chat',
        label: `Chat Invites (${state.chatInvites.length})`,
        kind: 'summary',
        data: null
      }
    ]
  }

  if (node === 'invites:group') {
    return state.groupInvites.map((invite) => ({
      key: invite.id,
      label: `${shortText(invite.groupName || invite.groupId, 24)} · members:${invite.event?.tags?.filter((tag) => tag[0] === 'p').length || 0} · by:${shortId(invite.event.pubkey, 8)}`,
      kind: 'group-invite',
      data: invite
    }))
  }

  if (node === 'invites:chat') {
    return state.chatInvites.map((invite) => ({
      key: invite.id,
      label: `${shortText(invite.title || invite.id, 24)} · ${invite.status} · by:${shortId(invite.senderPubkey, 8)}`,
      kind: 'chat-invite',
      data: invite
    }))
  }

  if (node === 'files' || isFileTypeNodeId(node)) {
    const family = fileFamilyFromNodeId(node)
    const filtered = family
      ? state.files.filter((file) => fileFamilyForMime(file.mime) === family)
      : state.files
    return filtered.map((file, idx) => ({
      key: `${file.eventId}-${idx}`,
      label:
        `${shortText(file.fileName, 24)} · ${file.mime || '-'} · ${Number(file.size || 0)}B · ${shortText(file.groupName || file.groupId, 16)} · by:${shortId(file.uploadedBy, 8)}`,
      kind: 'file',
      data: file
    }))
  }

  if (node === 'accounts') {
    return state.accounts.map((account, idx) => ({
      key: `${account.pubkey}-${idx}`,
      label: `${state.currentAccountPubkey === account.pubkey ? '*' : ' '} ${shortId(account.pubkey, 10)} · ${account.signerType}`,
      kind: 'account',
      data: account
    }))
  }

  if (node === 'logs') {
    return state.logs.map((entry, idx) => ({
      key: `${entry.ts}-${idx}`,
      label: `${new Date(entry.ts).toLocaleTimeString()} [${entry.level}] ${shortText(entry.message, 90)}`,
      kind: 'log',
      data: entry
    }))
  }

  return []
}

function splitNode(node: NavNodeId): boolean {
  return (
    node === 'groups:browse'
    || node === 'groups:my'
    || node === 'groups:create'
    || node === 'chats:create'
    || node === 'invites:group'
    || node === 'invites:chat'
    || node === 'files'
    || isFileTypeNodeId(node)
  )
}

function supportsActionTree(node: NavNodeId): boolean {
  return (
    node === 'groups:browse'
    || node === 'groups:my'
    || node === 'chats'
    || node === 'invites:group'
    || node === 'invites:chat'
    || node === 'files'
    || isFileTypeNodeId(node)
  )
}

function defaultDetailsAction(node: NavNodeId): string {
  if (node === 'groups:browse' || node === 'groups:my' || node === 'invites:group') {
    return 'Relay Details'
  }
  if (node === 'invites:chat') {
    return 'Chat details'
  }
  return ''
}

function groupKey(groupId: string, relay?: string | null): string {
  const normalizedGroupId = String(groupId || '').trim()
  const normalizedRelay = relay ? relay.trim() : ''
  return `${normalizedRelay}|${normalizedGroupId}`
}

function displayNodeId(node: NavNodeId): string {
  if (node === 'groups') return 'P2P Relays'
  if (node === 'groups:browse') return 'relays:browse'
  if (node === 'groups:my') return 'relays:my'
  if (node === 'groups:create') return 'relays:create'
  if (node === 'invites:group') return 'invites:relay'
  return node
}

function relayForGroup(state: ControllerState, group: any): any | null {
  if (!group) return null
  const groupId = String(group.id || '').trim()
  const groupRelay = String(group.relay || '').trim()
  return state.relays.find((relay) => String(relay.publicIdentifier || '').trim() === groupId)
    || state.relays.find((relay) => String(relay.connectionUrl || '').trim() === groupRelay)
    || null
}

function groupDisplayName(group: any): string {
  return String(group?.name || group?.id || '-')
}

function joinRequestsForGroup(state: ControllerState, group: any): GroupJoinRequest[] {
  if (!group?.id) return []
  const relay = String(group.relay || '').trim()
  const byRelayKey = relay ? `${relay}|${group.id}` : group.id
  return state.groupJoinRequests[byRelayKey] || state.groupJoinRequests[group.id] || []
}

function groupDetailsRows(group: any): string[] {
  if (!group) return ['No relay selected']
  const members = Number(group.membersCount || group.members?.length || 0)
  return [
    `id: ${group.id}`,
    `name: ${group.name || '-'}`,
    `about: ${group.about || '-'}`,
    `createdAt: ${group.createdAt ? new Date(group.createdAt * 1000).toLocaleString() : '-'}`,
    `visibility: ${group.isPublic === false ? 'private' : 'public'}`,
    `membership: ${group.isOpen === false ? 'closed' : 'open'}`,
    `admin: ${group.adminName || group.adminPubkey || '-'}`,
    `members: ${members}`,
    `peers online: ${group.peersOnline || 0}`
  ]
}

function fileRowsForGroup(state: ControllerState, group: any): any[] {
  if (!group) return []
  const directKey = groupKey(group.id, group.relay || null)
  const fallbackKey = groupKey(group.id, null)
  return state.groupFilesByGroupKey[directKey] || state.groupFilesByGroupKey[fallbackKey] || []
}

function noteRowsForGroup(state: ControllerState, group: any): any[] {
  if (!group) return []
  const directKey = groupKey(group.id, group.relay || null)
  const fallbackKey = groupKey(group.id, null)
  return state.groupNotesByGroupKey[directKey] || state.groupNotesByGroupKey[fallbackKey] || []
}

function rightTopActions(state: ControllerState, node: NavNodeId, selectedRow: CenterRow | null): string[] {
  if (node === 'groups:browse') {
    const group = selectedRow?.data as any
    const actions = ['Relay Details', 'Admin details', 'Members']
    if (!group) return actions
    const isPublic = group.isPublic !== false
    const isOpen = group.isOpen !== false
    if (isPublic && isOpen) {
      actions.push('Join Relay')
    } else if (isPublic && !isOpen) {
      actions.push('Request Invite')
    } else if (!isPublic) {
      actions.push('Invite-only (private)')
    }
    return actions
  }
  if (node === 'groups:my') {
    const group = selectedRow?.data as any
    const members = Number(group?.membersCount || group?.members?.length || 0)
    const files = fileRowsForGroup(state, group).length
    const joinReq = Object.values(state.groupJoinRequests).reduce((acc, rows) => acc + rows.length, 0)
    return [
      'Relay Details',
      `Members (${members})`,
      'Notes',
      `Files (${files})`,
      `Join Requests (${joinReq})`,
      'Send Invite'
    ]
  }
  if (node === 'groups:create') {
    return [
      'name: -',
      'description: -',
      'membership: open',
      'visibility: public',
      'direct-join-only: yes',
      'gateway picker: collapsed',
      'gateway origin: -',
      'gateway id: -'
    ]
  }
  if (node === 'chats:create') {
    return ['name: -', 'description: -', 'members: 0', 'relays: 0']
  }
  if (node === 'invites:group') {
    const invite = selectedRow?.data as any
    const group = state.groupDiscover.find((entry) => entry.id === invite?.groupId)
    const members = Number(group?.membersCount || group?.members?.length || 0)
    return [
      'Relay Details',
      'Admin details',
      `Members (${members})`,
      'Accept invite',
      'Dismiss invite'
    ]
  }
  if (node === 'invites:chat') {
    return [
      'Chat details',
      'Invited by',
      'Members',
      'Accept invite',
      'Dismiss invite'
    ]
  }
  if (node === 'chats') {
    if (!selectedRow) return []
    return ['Send Invite']
  }
  if (node === 'files' || isFileTypeNodeId(node)) {
    return ['Download', 'Delete']
  }
  return []
}

function singleRightRows(state: ControllerState, node: NavNodeId, selectedRow: CenterRow | null): string[] {
  if (node === 'dashboard') {
    return [
      `Current account: ${state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 10) : 'none'}`,
      `Session: ${state.session ? shortId(state.session.pubkey, 10) : 'locked'}`,
      `Worker: ${state.lifecycle}`,
      `Status: ${shortText(state.readinessMessage, 120)}`,
      `Relays: ${state.relays.length}`,
      `Browse relays: ${state.groupDiscover.length}`,
      `My relays: ${state.myGroups.length}`,
      `Invites: ${state.invitesCount}`,
      `Files: ${state.filesCount}`,
      `Chats: ${state.conversations.length} / pending ${state.chatPendingInviteCount}`,
      `Perf avg ${state.perfMetrics.avgLatencyMs.toFixed(1)}ms p95 ${state.perfMetrics.p95LatencyMs.toFixed(1)}ms`
    ]
  }

  if (node === 'chats') {
    const row = selectedRow?.data as any
    if (!row) return ['No conversation selected']
    return [
      `id: ${row.id}`,
      `title: ${row.title || '-'}`,
      `participants: ${Array.isArray(row.participants) ? row.participants.length : 0}`,
      `admins: ${Array.isArray(row.adminPubkeys) ? row.adminPubkeys.length : 0}`,
      `unread: ${row.unreadCount || 0}`,
      `last message: ${row.lastMessagePreview || '-'}`
    ]
  }

  if (node === 'accounts') {
    const account = selectedRow?.data as any
    if (!account) return ['No account selected']
    return [
      `pubkey: ${account.pubkey}`,
      `signer: ${account.signerType}`,
      `label: ${account.label || '-'}`,
      `created: ${new Date(account.createdAt).toLocaleString()}`,
      `updated: ${new Date(account.updatedAt).toLocaleString()}`
    ]
  }

  if (node === 'logs') {
    return [
      `stdout lines: ${state.workerStdout.length}`,
      `stderr lines: ${state.workerStderr.length}`,
      `entries: ${state.logs.length}`,
      'Use right-top selection to inspect individual log lines.'
    ]
  }

  return ['No details']
}

function splitBottomRows(
  state: ControllerState,
  node: NavNodeId,
  selectedRow: CenterRow | null,
  selectedAction: string,
  paneActionMessage: string | null
): string[] {
  if (node === 'groups:browse') {
    const group = selectedRow?.data as any
    if (!group) return ['No relay selected']
    if (selectedAction.startsWith('Relay Details')) {
      return groupDetailsRows(group)
    }
    if (selectedAction.startsWith('Admin details')) {
      const profile = state.adminProfileByPubkey[group.adminPubkey || group.event?.pubkey || '']
      return [
        `name: ${profile?.name || group.adminName || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${group.adminPubkey || group.event?.pubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Join Relay')) {
      return [
        paneActionMessage || 'Press Enter to join this relay',
        `relay: ${group.name || group.id}`,
        `visibility: ${group.isPublic === false ? 'private' : 'public'}`,
        `membership: ${group.isOpen === false ? 'closed' : 'open'}`
      ]
    }
    if (selectedAction.startsWith('Request Invite')) {
      return [
        paneActionMessage || 'Press Enter to submit join request for admin review'
      ]
    }
    if (selectedAction.startsWith('Invite-only (private)')) {
      return ['Private relay (invite-only). Join action unavailable without an invite.']
    }
    const members = Array.isArray(group.members) ? group.members : []
    return members.length ? members.map((member: unknown) => `${member}`) : ['No member list available']
  }

  if (node === 'groups:my') {
    const group = selectedRow?.data as any
    if (!group) return ['No relay selected']
    if (selectedAction.startsWith('Relay Details')) {
      const relay = relayForGroup(state, group)
      return [
        ...groupDetailsRows(group),
        `url: ${relay?.connectionUrl || group.relay || '-'}`,
        `writable: ${String(Boolean(relay?.writable))}`,
        `requiresAuth: ${String(Boolean(relay?.requiresAuth))}`,
        `readyForReq: ${String(Boolean(relay?.readyForReq))}`
      ]
    }
    if (selectedAction.startsWith('Members')) {
      const members = Array.isArray(group.members) ? group.members : []
      return members.length ? members.map((member: unknown) => `${member}`) : ['No member list available']
    }
    if (selectedAction.startsWith('Notes')) {
      const notes = noteRowsForGroup(state, group)
      if (!notes.length) return ['No relay notes loaded']
      return notes.map((note) => `${new Date(note.createdAt * 1000).toLocaleString()} · ${shortId(note.authorPubkey, 8)} · ${shortText(note.content, 120)}`)
    }
    if (selectedAction.startsWith('Files')) {
      const files = fileRowsForGroup(state, group)
      if (!files.length) return ['No relay files loaded']
      return files.map((file) => `${shortText(file.fileName, 42)} · ${file.mime || '-'} · ${Number(file.size || 0)}B · by:${shortId(file.uploadedBy, 8)}`)
    }
    if (selectedAction.startsWith('Join Requests')) {
      const byRelayKey = group.relay ? `${group.relay}|${group.id}` : group.id
      const requests = state.groupJoinRequests[byRelayKey] || state.groupJoinRequests[group.id] || []
      if (!requests.length) return ['No pending join requests']
      return requests.map((request) => `${shortId(request.pubkey, 10)} · ${new Date(request.createdAt * 1000).toLocaleString()}`)
    }
    return ['No details']
  }

  if (node === 'groups:create') {
    return [
      paneActionMessage || 'Use right-top to edit fields and run create.',
      'Create workflow status will appear here.'
    ]
  }

  if (node === 'chats:create') {
    return [
      paneActionMessage || 'Use right-top to edit fields and run create.',
      'Chat creation workflow status will appear here.'
    ]
  }

  if (node === 'invites:group') {
    const invite = selectedRow?.data as any
    if (!invite) return ['No invite selected']
    const group = state.groupDiscover.find((entry) => entry.id === invite.groupId)
    if (selectedAction.startsWith('Relay Details')) {
      if (group) return groupDetailsRows(group)
      return [
        `id: ${invite.groupId}`,
        `name: ${invite.groupName || invite.groupId}`,
        `about: -`,
        `createdAt: ${invite.event?.created_at ? new Date(invite.event.created_at * 1000).toLocaleString() : '-'}`,
        `visibility: ${invite.isPublic === false ? 'private' : 'public'}`,
        `membership: ${invite.fileSharing === false ? 'closed' : 'open'}`,
        `admin: ${invite.event?.pubkey || '-'}`,
        `members: -`
      ]
    }
    if (selectedAction.startsWith('Admin details')) {
      const profile = state.adminProfileByPubkey[invite.event?.pubkey || '']
      return [
        `name: ${profile?.name || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${invite.event?.pubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Members')) {
      const members = Array.isArray(group?.members) ? group.members : []
      return members.length ? members : ['No member list available']
    }
    if (selectedAction.startsWith('Accept invite') || selectedAction.startsWith('Dismiss invite')) {
      return [paneActionMessage || 'Press Enter to execute this action']
    }
  }

  if (node === 'invites:chat') {
    const invite = selectedRow?.data as any
    if (!invite) return ['No invite selected']
    if (selectedAction.startsWith('Chat details')) {
      return [
        `id: ${invite.id}`,
        `title: ${invite.title || '-'}`,
        `conversationId: ${invite.conversationId || '-'}`,
        `status: ${invite.status || '-'}`,
        `createdAt: ${invite.createdAt ? new Date(invite.createdAt * 1000).toLocaleString() : '-'}`
      ]
    }
    if (selectedAction.startsWith('Invited by')) {
      const profile = state.adminProfileByPubkey[invite.senderPubkey || '']
      return [
        `name: ${profile?.name || '-'}`,
        `bio: ${profile?.bio || '-'}`,
        `pubkey: ${invite.senderPubkey || '-'}`,
        `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
      ]
    }
    if (selectedAction.startsWith('Members')) {
      return ['Members are available after invite acceptance.']
    }
    if (selectedAction.startsWith('Accept invite') || selectedAction.startsWith('Dismiss invite')) {
      return [paneActionMessage || 'Press Enter to execute this action']
    }
  }

  if (node === 'files' || isFileTypeNodeId(node)) {
    const file = selectedRow?.data as any
    if (!file) return ['No file selected']
    if (selectedAction.startsWith('Download') || selectedAction.startsWith('Delete')) {
      const status = state.fileActionStatus
      const lines = [
        `action: ${status.action || '-'}`,
        `state: ${status.state}`,
        `message: ${status.message || '-'}`
      ]
      if (status.path) lines.push(`path: ${status.path}`)
      lines.push(`selected file: ${file.fileName || '-'} (${file.sha256 || '-'})`)
      return lines
    }
    return [
      `relay: ${file.groupId}`,
      `groupName: ${file.groupName || '-'}`,
      `name: ${file.fileName}`,
      `mime: ${file.mime || '-'}`,
      `size: ${file.size || 0}`,
      `uploadedAt: ${new Date(file.uploadedAt * 1000).toLocaleString()}`,
      `uploadedBy: ${file.uploadedBy}`,
      `sha256: ${file.sha256 || '-'}`,
      `url: ${file.url || '-'}`
    ]
  }

  return ['No details']
}

async function refreshNode(controller: AppController, node: NavNodeId, selectedRow: CenterRow | null): Promise<void> {
  switch (node) {
    case 'dashboard':
      await Promise.all([
        controller.refreshRelays(),
        controller.refreshGroups(),
        controller.refreshInvites(),
        controller.refreshGroupFiles(),
        controller.refreshChats()
      ])
      break
    case 'relays':
      await Promise.all([controller.refreshRelays(), controller.refreshGroups()])
      break
    case 'groups':
    case 'groups:browse':
      await controller.refreshGroups()
      break
    case 'groups:my': {
      await controller.refreshGroups()
      const group = selectedRow?.data as any
      if (group?.id) {
        await Promise.all([
          controller.refreshGroupNotes(group.id, group.relay || undefined),
          controller.refreshGroupFiles(group.id)
        ])
      }
      break
    }
    case 'chats':
      await controller.refreshChats()
      break
    case 'invites':
    case 'invites:group':
    case 'invites:chat':
      await Promise.all([controller.refreshInvites(), controller.refreshChats()])
      break
    case 'files':
      await controller.refreshGroupFiles()
      break
    default:
      if (isFileTypeNodeId(node)) {
        await controller.refreshGroupFiles()
      }
      break
  }
}

export function App({
  options,
  controllerFactory,
  scriptedCommands,
  autoExitOnScriptComplete = false
}: AppProps): React.JSX.Element {
  const { exit } = useApp()
  const [stdoutWidth, stdoutHeight] = useTerminalDimensions()
  const controllerRef = useRef<AppController | null>(null)
  const scriptStartedRef = useRef(false)
  const exitRef = useRef(exit)

  const [state, setState] = useState<ControllerState | null>(null)
  const [selectedNode, setSelectedNode] = useState<NavNodeId>('dashboard')
  const [focusPane, setFocusPane] = useState<FocusPane>('left-tree')
  const [treeExpanded, setTreeExpanded] = useState<TreeExpanded>(DEFAULT_TREE_EXPANDED)
  const [nodeViewport, setNodeViewport] = useState<ViewportMap>({})
  const [expandedActionParentByNode, setExpandedActionParentByNode] = useState<Record<string, string>>({})
  const [rightBottomOffsetByNode, setRightBottomOffsetByNode] = useState<OffsetMap>({})
  const [paneActionMessage, setPaneActionMessage] = useState<string>('')
  const [commandInputOpen, setCommandInputOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [groupCreateDraft, setGroupCreateDraft] = useState<GroupCreateDraft>({
    name: '',
    about: '',
    membership: 'open',
    visibility: 'public',
    directJoinOnly: true,
    gatewayOrigin: '',
    gatewayId: ''
  })
  const [createCursorByNode, setCreateCursorByNode] = useState<CreateCursorMap>({
    'groups:create': 0,
    'chats:create': 0
  })
  const [createExpandedBranchByNode, setCreateExpandedBranchByNode] = useState<CreateExpandedBranchMap>({
    'groups:create': '',
    'chats:create': ''
  })
  const [createEditState, setCreateEditState] = useState<CreateEditState | null>(null)
  const [chatCreateDraft, setChatCreateDraft] = useState<ChatCreateDraft>({
    name: '',
    description: '',
    inviteMembers: [],
    relayUrls: []
  })
  const [inviteComposeState, setInviteComposeState] = useState<InviteComposeState | null>(null)
  const [joinRequestCursorByGroupKey, setJoinRequestCursorByGroupKey] = useState<Record<string, number>>({})
  const [joinRequestReviewState, setJoinRequestReviewState] = useState<JoinRequestReviewState | null>(null)
  const inviteSearchRequestRef = useRef(0)
  const [commandMessage, setCommandMessage] = useState('Type :help for commands')
  const [hydratedScopeKey, setHydratedScopeKey] = useState<string>('')
  const initialized = state?.initialized || false

  const stateRef = useRef<ControllerState | null>(null)
  const selectedNodeRef = useRef<NavNodeId>('dashboard')
  const focusPaneRef = useRef<FocusPane>('left-tree')
  const nodeViewportRef = useRef<ViewportMap>({})
  const rightBottomOffsetRef = useRef<OffsetMap>({})
  const createCursorRef = useRef<CreateCursorMap>({
    'groups:create': 0,
    'chats:create': 0
  })
  const createEditStateRef = useRef<CreateEditState | null>(null)
  const inviteComposeStateRef = useRef<InviteComposeState | null>(null)
  const selectedCenterRowRef = useRef<CenterRow | null>(null)
  const myGroupPaneLoadKeyRef = useRef<string>('')

  useEffect(() => {
    exitRef.current = exit
  }, [exit])

  useEffect(() => {
    const controller = controllerFactory
      ? controllerFactory(options)
      : new TuiController(options)
    controllerRef.current = controller

    let disposed = false

    const unsubscribe = controller.subscribe((nextState) => {
      if (disposed) return
      setState(nextState)
    })

    ;(async () => {
      try {
        await controller.initialize()

        const snapshot = controller.getState()
        const scriptedMode = Boolean(scriptedCommands?.length)
        if (snapshot.currentAccountPubkey && !scriptedMode) {
          try {
            await controller.unlockCurrentAccount()
            await controller.startWorker()
            await refreshNode(controller, 'dashboard', null)
            setCommandMessage('Auto-unlocked current nsec account')
          } catch (error) {
            setCommandMessage(
              `Account selected, unlock required: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        } else if (snapshot.currentAccountPubkey && scriptedMode) {
          setCommandMessage('Script mode active: skipping automatic unlock/start bootstrap')
        }
      } catch (error) {
        setCommandMessage(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
      controller.shutdown().catch(() => {})
    }
  }, [options, controllerFactory, scriptedCommands])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    selectedNodeRef.current = selectedNode
  }, [selectedNode])

  useEffect(() => {
    focusPaneRef.current = focusPane
  }, [focusPane])

  useEffect(() => {
    nodeViewportRef.current = nodeViewport
  }, [nodeViewport])

  useEffect(() => {
    rightBottomOffsetRef.current = rightBottomOffsetByNode
  }, [rightBottomOffsetByNode])

  useEffect(() => {
    createCursorRef.current = createCursorByNode
  }, [createCursorByNode])

  useEffect(() => {
    createEditStateRef.current = createEditState
  }, [createEditState])

  useEffect(() => {
    inviteComposeStateRef.current = inviteComposeState
  }, [inviteComposeState])

  useEffect(() => {
    if (!state) return
    const scopeKey = String(state.session?.userKey || state.currentAccountPubkey || '')
    if (!scopeKey) return
    if (scopeKey === hydratedScopeKey) return

    setHydratedScopeKey(scopeKey)
    let hydratedNode = state.selectedNode || 'dashboard'
    if (hydratedNode === 'relays' || hydratedNode === 'invites:send') {
      hydratedNode = 'groups:my'
    } else if (hydratedNode === 'logs') {
      hydratedNode = 'dashboard'
    }
    setSelectedNode(hydratedNode)
    if (state.selectedNode === 'relays' || state.selectedNode === 'invites:send' || state.selectedNode === 'logs') {
      controllerRef.current?.setSelectedNode(hydratedNode).catch(() => {})
    }
    const hydratedFocus = state.focusPane || 'left-tree'
    setFocusPane(hydratedFocus)
    setTreeExpanded({
      groups: state.treeExpanded?.groups ?? true,
      chats: state.treeExpanded?.chats ?? true,
      invites: state.treeExpanded?.invites ?? true,
      files: state.treeExpanded?.files ?? true
    })
    setNodeViewport(state.nodeViewport || {})
    setExpandedActionParentByNode({})
    setRightBottomOffsetByNode(state.rightBottomOffsetByNode || {})
    setPaneActionMessage('')
    setGroupCreateDraft({
      name: '',
      about: '',
      membership: 'open',
      visibility: 'public',
      directJoinOnly: true,
      gatewayOrigin: '',
      gatewayId: ''
    })
    setCreateCursorByNode({
      'groups:create': 0,
      'chats:create': 0
    })
    setCreateExpandedBranchByNode({
      'groups:create': '',
      'chats:create': ''
    })
    createEditStateRef.current = null
    setCreateEditState(null)
    setChatCreateDraft({
      name: '',
      description: '',
      inviteMembers: [],
      relayUrls: []
    })
    setInviteComposeState(null)
    setJoinRequestCursorByGroupKey({})
    setJoinRequestReviewState(null)
  }, [state, hydratedScopeKey])

  const navRows = useMemo(() => {
    if (!state) return []
    return navRowsFromState(state, treeExpanded)
  }, [state, treeExpanded])

  const navIndexById = useMemo(() => {
    const map = new Map<NavNodeId, number>()
    navRows.forEach((row, index) => {
      map.set(row.id, index)
    })
    return map
  }, [navRows])

  useEffect(() => {
    if (navRows.length === 0) return
    if (navIndexById.has(selectedNode)) return
    const fallback = navRows[0]
    if (!fallback) return
    setSelectedNode(fallback.id)
    controllerRef.current?.setSelectedNode(fallback.id).catch(() => {})
  }, [navRows, navIndexById, selectedNode])

  const frameHeight = Math.max(14, stdoutHeight)
  const frameRows = frameSegments(frameHeight)
  const narrowLayout = stdoutWidth < 136

  const navPaneWidth = narrowLayout ? Math.max(22, stdoutWidth - 2) : clamp(Math.floor(stdoutWidth * 0.28), 28, 40)
  const rightPaneWidth = narrowLayout ? Math.max(22, stdoutWidth - 2) : Math.max(48, stdoutWidth - navPaneWidth)

  const wideRightTopBoxRows = Math.max(6, Math.floor(frameRows.mainRows / 2))
  const wideRightBottomBoxRows = Math.max(6, frameRows.mainRows - wideRightTopBoxRows)
  const narrowNavBoxRows = Math.max(6, Math.floor(frameRows.mainRows * 0.34))
  const narrowRightStackRows = Math.max(8, frameRows.mainRows - narrowNavBoxRows)
  const narrowRightTopBoxRows = Math.max(4, Math.floor(narrowRightStackRows / 2))
  const narrowRightBottomBoxRows = Math.max(4, narrowRightStackRows - narrowRightTopBoxRows)

  const navBoxRows = narrowLayout ? narrowNavBoxRows : frameRows.mainRows
  const rightTopBoxRows = narrowLayout ? narrowRightTopBoxRows : wideRightTopBoxRows
  const rightBottomBoxRows = narrowLayout ? narrowRightBottomBoxRows : wideRightBottomBoxRows
  const rightTopContentWidth = Math.max(20, (narrowLayout ? stdoutWidth : rightPaneWidth) - 8)

  const centerRows = useMemo(() => {
    if (!state) return []
    return centerRowsForNode(state, selectedNode)
  }, [state, selectedNode])

  const rightTopRows = useMemo(() => {
    if (!state) return []
    if (isCreateNodeId(selectedNode)) return []
    const rows: RightTopRow[] = []
    const expandedParent = expandedActionParentByNode[selectedNode] || ''
    const actionTreeEnabled = supportsActionTree(selectedNode)

    for (const parentRow of centerRows) {
      const childRows: RightTopRow[] = []
      if (actionTreeEnabled) {
        const actions = rightTopActions(state, selectedNode, parentRow)
        for (const [index, action] of actions.entries()) {
          childRows.push({
            key: `${parentRow.key}:action:${index}`,
            label: action,
            centerRow: parentRow,
            depth: 1,
            kind: 'action',
            action,
            expandable: false,
            expanded: false
          })
        }
      }

      const expandable = childRows.length > 0
      const expanded = expandable && expandedParent === parentRow.key
      rows.push({
        key: parentRow.key,
        label: parentRow.label,
        centerRow: parentRow,
        depth: 0,
        kind: 'parent',
        expandable,
        expanded
      })
      if (expanded) {
        rows.push(...childRows)
      }
    }

    return rows
  }, [state, selectedNode, centerRows, expandedActionParentByNode])

  const createRows = useMemo<CreateBrowseRow[]>(() => {
    if (!state || !isCreateNodeId(selectedNode)) return []
    const expandedBranch = createExpandedBranchByNode[selectedNode] || ''
    if (selectedNode === 'groups:create') {
      return groupCreateRows(groupCreateDraft, expandedBranch, state.discoveredGateways || [])
    }
    return chatCreateRows(chatCreateDraft, expandedBranch, state.relays || [])
  }, [state, selectedNode, groupCreateDraft, chatCreateDraft, createExpandedBranchByNode])

  const createGatewayOptions = useMemo<CreateGatewayPickerOption[]>(
    () => gatewayPickerOptions(groupCreateDraft, state?.discoveredGateways || []),
    [groupCreateDraft, state]
  )

  const createChatRelayOptions = useMemo<CreateChatRelayPickerOption[]>(
    () => chatRelayPickerOptions(chatCreateDraft, state?.relays || []),
    [chatCreateDraft, state]
  )

  const selectedCreateCursor = isCreateNodeId(selectedNode)
    ? clamp(createCursorByNode[selectedNode] || 0, 0, Math.max(0, createRows.length - 1))
    : 0
  const selectedCreateRow = isCreateNodeId(selectedNode)
    ? (createRows[selectedCreateCursor] || null)
    : null

  useEffect(() => {
    if (!isCreateNodeId(selectedNode)) return
    const maxIndex = Math.max(0, createRows.length - 1)
    const current = createCursorByNode[selectedNode] || 0
    if (current <= maxIndex) return
    setCreateCursorByNode((previous) => ({
      ...previous,
      [selectedNode]: maxIndex
    }))
  }, [selectedNode, createRows.length, createCursorByNode])

  useEffect(() => {
    if (!createEditState) return
    if (createEditState.node === selectedNode) return
    createEditStateRef.current = null
    setCreateEditState(null)
  }, [selectedNode, createEditState])

  const rightTopTableColumns = useMemo(
    () => (isCreateNodeId(selectedNode) ? null : rightTopTableColumnsForNode(selectedNode)),
    [selectedNode]
  )
  const rightTopHasTable = Boolean(rightTopTableColumns && rightTopTableColumns.length > 0)
  const rightTopHeaderRows = rightTopHasTable ? 2 : 0
  const rightTopBodyRows = Math.max(1, rightTopBoxRows - 2 - rightTopHeaderRows)
  const rightTopVisibleRows = rightTopBodyRows

  const rightTopProjectedRows = useMemo<TableRowView[]>(() => {
    if (!state || !rightTopTableColumns?.length) return []
    return rightTopRows.map((row) => projectRightTopTableRow(state, selectedNode, row))
  }, [state, selectedNode, rightTopRows, rightTopTableColumns])

  const rightTopTable = useMemo(() => {
    if (!rightTopTableColumns?.length) return null
    return formatTableRows({
      columns: rightTopTableColumns,
      rows: rightTopProjectedRows,
      width: rightTopContentWidth
    })
  }, [rightTopProjectedRows, rightTopTableColumns, rightTopContentWidth])
  const rightTopCenteredHeaderLine = useMemo(() => {
    if (!rightTopTable) return ''
    return buildCenteredHeaderLine(rightTopTable.columns, rightTopTable.widths, 2)
  }, [rightTopTable])

  const selectedNodeViewport = useMemo(() => {
    const current = nodeViewport[selectedNode] || { cursor: 0, offset: 0 }
    return normalizeViewport(current.cursor, current.offset, rightTopRows.length, rightTopVisibleRows)
  }, [nodeViewport, selectedNode, rightTopRows.length, rightTopVisibleRows])

  useEffect(() => {
    const key = selectedNode
    const previous = nodeViewportRef.current[key]
    if (previous && previous.cursor === selectedNodeViewport.selectedIndex && previous.offset === selectedNodeViewport.offset) {
      return
    }
    const next = {
      ...nodeViewportRef.current,
      [key]: {
        cursor: selectedNodeViewport.selectedIndex,
        offset: selectedNodeViewport.offset
      }
    }
    setNodeViewport(next)
    controllerRef.current?.setPaneViewport(key, selectedNodeViewport.selectedIndex, selectedNodeViewport.offset).catch(() => {})
  }, [selectedNode, selectedNodeViewport])

  const selectedRightTopRow = rightTopRows[selectedNodeViewport.selectedIndex] || null
  const selectedCenterRow = selectedRightTopRow?.centerRow || null

  useEffect(() => {
    selectedCenterRowRef.current = selectedCenterRow
  }, [selectedCenterRow])

  const selectedRightTopAction = useMemo(() => {
    if (!selectedCenterRow) return ''
    if (selectedRightTopRow?.kind === 'action') {
      return selectedRightTopRow.action || ''
    }
    return defaultDetailsAction(selectedNode)
  }, [selectedNode, selectedCenterRow, selectedRightTopRow])

  const selectedInviteComposeTarget = useMemo<InviteComposeTarget | null>(() => {
    if (!state) return null
    if (!selectedCenterRow) return null
    if (!selectedRightTopAction.startsWith('Send Invite')) return null

    if (selectedNode === 'groups:my' && selectedCenterRow.kind === 'group') {
      const group = selectedCenterRow.data as any
      return {
        kind: 'group',
        id: group.id,
        relay: group.relay || null,
        name: groupDisplayName(group),
        isPublic: group.isPublic !== false,
        isOpen: group.isOpen !== false
      }
    }

    if (selectedNode === 'chats' && selectedCenterRow.kind === 'chat-conversation') {
      const conversation = selectedCenterRow.data as any
      const currentPubkey = String(state.session?.pubkey || '').trim().toLowerCase()
      const adminPubkeys = Array.isArray(conversation.adminPubkeys)
        ? conversation.adminPubkeys.map((entry: unknown) => String(entry || '').trim().toLowerCase())
        : []
      if (!currentPubkey || !adminPubkeys.includes(currentPubkey)) return null
      return {
        kind: 'chat',
        id: conversation.id,
        relay: null,
        name: String(conversation.title || conversation.id || 'Chat')
      }
    }

    return null
  }, [state, selectedNode, selectedCenterRow, selectedRightTopAction])

  useEffect(() => {
    if (!state || selectedNode !== 'groups:my') {
      myGroupPaneLoadKeyRef.current = ''
      return
    }
    if (!selectedCenterRow || selectedCenterRow.kind !== 'group') return
    const group = selectedCenterRow.data as any
    const controller = controllerRef.current
    if (!controller || !group?.id) return

    const actionName = selectedRightTopAction
    if (!actionName.startsWith('Notes') && !actionName.startsWith('Files') && !actionName.startsWith('Join Requests')) {
      return
    }
    const relay = String(group.relay || '').trim()
    const key = `${group.id}|${relay}|${actionName}`
    if (myGroupPaneLoadKeyRef.current === key) return
    myGroupPaneLoadKeyRef.current = key

    if (actionName.startsWith('Notes')) {
      controller.refreshGroupNotes(group.id, relay || undefined).catch(() => {})
    } else if (actionName.startsWith('Files')) {
      controller.refreshGroupFiles(group.id).catch(() => {})
    } else if (actionName.startsWith('Join Requests')) {
      controller.refreshJoinRequests(group.id, relay || undefined).catch(() => {})
    }
  }, [state, selectedNode, selectedCenterRow, selectedRightTopAction])

  useEffect(() => {
    if (!inviteComposeState) return
    const query = String(inviteComposeState.query || '').trim()
    if (!query) {
      setInviteComposeState((previous) => {
        if (!previous) return previous
        if (previous.suggestions.length === 0 && previous.suggestionIndex === 0) return previous
        return {
          ...previous,
          suggestions: [],
          suggestionIndex: 0
        }
      })
      return
    }
    const controller = controllerRef.current
    if (!controller) return
    const requestId = ++inviteSearchRequestRef.current
    let cancelled = false
    const timer = setTimeout(() => {
      controller.searchProfileSuggestions(query, 10)
        .then((results) => {
          if (cancelled) return
          if (requestId !== inviteSearchRequestRef.current) return
          setInviteComposeState((previous) => {
            if (!previous) return previous
            if (String(previous.query || '').trim() !== query) return previous
            return {
              ...previous,
              suggestions: results || [],
              suggestionIndex: 0
            }
          })
        })
        .catch(() => {
          if (cancelled) return
          if (requestId !== inviteSearchRequestRef.current) return
          setInviteComposeState((previous) => {
            if (!previous) return previous
            if (String(previous.query || '').trim() !== query) return previous
            return {
              ...previous,
              suggestions: [],
              suggestionIndex: 0
            }
          })
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [inviteComposeState])

  useEffect(() => {
    if (!inviteComposeState) return
    if (selectedNode === 'groups:my' || selectedNode === 'chats') return
    inviteComposeStateRef.current = null
    setInviteComposeState(null)
  }, [selectedNode, inviteComposeState])

  const selectedJoinRequestContext = useMemo(() => {
    if (!state) return null
    if (selectedNode !== 'groups:my') return null
    if (!selectedCenterRow || selectedCenterRow.kind !== 'group') return null
    if (!selectedRightTopAction.startsWith('Join Requests')) return null
    const group = selectedCenterRow.data as any
    const requests = joinRequestsForGroup(state, group)
    const key = `${group.id}|${String(group.relay || '').trim()}`
    return {
      group,
      key,
      requests
    }
  }, [state, selectedNode, selectedCenterRow, selectedRightTopAction])

  const selectedJoinRequestCursor = useMemo(() => {
    if (!selectedJoinRequestContext || selectedJoinRequestContext.requests.length === 0) return 0
    const raw = joinRequestCursorByGroupKey[selectedJoinRequestContext.key] || 0
    return clamp(raw, 0, selectedJoinRequestContext.requests.length - 1)
  }, [selectedJoinRequestContext, joinRequestCursorByGroupKey])

  useEffect(() => {
    if (!selectedJoinRequestContext || selectedJoinRequestContext.requests.length === 0) return
    const maxIndex = selectedJoinRequestContext.requests.length - 1
    setJoinRequestCursorByGroupKey((previous) => {
      const current = previous[selectedJoinRequestContext.key] || 0
      const next = clamp(current, 0, maxIndex)
      if (next === current) return previous
      return {
        ...previous,
        [selectedJoinRequestContext.key]: next
      }
    })
  }, [selectedJoinRequestContext])

  useEffect(() => {
    if (!joinRequestReviewState) return
    if (!selectedJoinRequestContext) {
      setJoinRequestReviewState(null)
      return
    }
    if (joinRequestReviewState.groupId !== selectedJoinRequestContext.group.id) {
      setJoinRequestReviewState(null)
    }
  }, [joinRequestReviewState, selectedJoinRequestContext])

  const rightBottomRawRows = useMemo(() => {
    if (!state) return ['No data']
    if (splitNode(selectedNode)) {
      return splitBottomRows(state, selectedNode, selectedCenterRow, selectedRightTopAction, paneActionMessage)
    }
    return singleRightRows(state, selectedNode, selectedCenterRow)
  }, [
    state,
    selectedNode,
    selectedCenterRow,
    selectedRightTopAction,
    paneActionMessage
  ])

  const rightBottomWrapWidth = Math.max(18, rightPaneWidth - 4)
  const rightBottomSpecialRows = useMemo<DetailRenderRow[] | null>(() => {
    if (!state) return null

    if (joinRequestReviewState) {
      const request = joinRequestReviewState.request
      const segments = [
        {
          key: 'join-review:title',
          kind: 'segments' as const,
          segments: [{ text: `Review join request for: ${joinRequestReviewState.groupName}`, color: 'yellow' as const }]
        },
        {
          key: 'join-review:from',
          kind: 'plain' as const,
          text: `From: ${request.pubkey}`
        },
        {
          key: 'join-review:date',
          kind: 'plain' as const,
          text: `Date: ${new Date(request.createdAt * 1000).toLocaleString()}`
        },
        {
          key: 'join-review:reason',
          kind: 'plain' as const,
          text: `Reason: ${request.reason || '-'}`
        },
        {
          key: 'join-review:spacer',
          kind: 'plain' as const,
          text: ''
        },
        {
          key: 'join-review:approve',
          kind: 'segments' as const,
          segments: [
            { text: joinRequestReviewState.selectedAction === 'approve' ? '> ' : '  ', color: joinRequestReviewState.selectedAction === 'approve' ? 'green' : 'gray' },
            { text: 'Approve', color: joinRequestReviewState.selectedAction === 'approve' ? 'green' : 'white' }
          ]
        },
        {
          key: 'join-review:dismiss',
          kind: 'segments' as const,
          segments: [
            { text: joinRequestReviewState.selectedAction === 'dismiss' ? '> ' : '  ', color: joinRequestReviewState.selectedAction === 'dismiss' ? 'green' : 'gray' },
            { text: 'Dismiss', color: joinRequestReviewState.selectedAction === 'dismiss' ? 'green' : 'white' }
          ]
        },
        {
          key: 'join-review:hint',
          kind: 'segments' as const,
          segments: [
            {
              text: joinRequestReviewState.busy
                ? 'Processing request…'
                : (joinRequestReviewState.status || 'Use ↑/↓ to choose, Enter to confirm, Esc to cancel.'),
              color: joinRequestReviewState.busy ? 'cyan' : 'gray',
              dimColor: !joinRequestReviewState.busy
            }
          ]
        }
      ]
      return segments
    }

    if (!selectedCenterRow || selectedCenterRow.kind !== 'group') return null
    const group = selectedCenterRow.data as any
    const groupName = groupDisplayName(group)

    if (selectedNode === 'groups:browse') {
      if (selectedRightTopAction.startsWith('Relay Details')) {
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Relay profile for: ${groupName}`,
          columns: [
            { key: 'field', label: 'Field', minWidth: 12, priority: 0, cellColor: 'cyan' },
            { key: 'value', label: 'Value', minWidth: 18, priority: 1, cellColor: 'white' }
          ],
          rows: keyValueTableRows(groupDetailsRows(group)),
          showHeader: false
        })
      }
      if (selectedRightTopAction.startsWith('Admin details')) {
        const profile = state.adminProfileByPubkey[group.adminPubkey || group.event?.pubkey || '']
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Admin profile for: ${groupName}`,
          columns: [
            { key: 'field', label: 'Field', minWidth: 12, priority: 0, cellColor: 'cyan' },
            { key: 'value', label: 'Value', minWidth: 18, priority: 1, cellColor: 'white' }
          ],
          rows: keyValueTableRows([
            `name: ${profile?.name || group.adminName || '-'}`,
            `bio: ${profile?.bio || '-'}`,
            `pubkey: ${group.adminPubkey || group.event?.pubkey || '-'}`,
            `followers: ${Number.isFinite(profile?.followersCount) ? profile.followersCount : '-'}`
          ]),
          showHeader: false
        })
      }
      if (selectedRightTopAction.startsWith('Members')) {
        const members = Array.isArray(group.members) ? group.members : []
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Members list for: ${groupName}`,
          columns: [
            { key: 'member', label: '', minWidth: 24, priority: 0, cellColor: 'white' }
          ],
          rows: members.map((member: unknown) => ({ member: String(member || '-') })),
          showHeader: false,
          noItemsLabel: 'No member list available'
        })
      }
      if (selectedRightTopAction.startsWith('Request Invite')) {
        return [{
          key: 'request:invite:hint',
          kind: 'plain',
          text: paneActionMessage || 'Press Enter to submit join request for admin review'
        }]
      }
      return null
    }

    if (selectedNode === 'groups:my') {
      if (selectedRightTopAction.startsWith('Relay Details')) {
        const relay = relayForGroup(state, group)
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Relay profile for: ${groupName}`,
          columns: [
            { key: 'field', label: 'Field', minWidth: 12, priority: 0, cellColor: 'cyan' },
            { key: 'value', label: 'Value', minWidth: 18, priority: 1, cellColor: 'white' }
          ],
          rows: keyValueTableRows([
            ...groupDetailsRows(group),
            `url: ${relay?.connectionUrl || group.relay || '-'}`,
            `writable: ${String(Boolean(relay?.writable))}`,
            `requiresAuth: ${String(Boolean(relay?.requiresAuth))}`,
            `readyForReq: ${String(Boolean(relay?.readyForReq))}`
          ]),
          showHeader: false
        })
      }
      if (selectedRightTopAction.startsWith('Members')) {
        const members = Array.isArray(group.members) ? group.members : []
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Members list for: ${groupName}`,
          columns: [
            { key: 'member', label: '', minWidth: 24, priority: 0, cellColor: 'white' }
          ],
          rows: members.map((member: unknown) => ({ member: String(member || '-') })),
          showHeader: false,
          noItemsLabel: 'No member list available'
        })
      }
      if (selectedRightTopAction.startsWith('Notes')) {
        const notes = noteRowsForGroup(state, group)
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Notes for: ${groupName}`,
          columns: [
            { key: 'publishedDate', label: 'Published date', minWidth: 20, priority: 0, cellColor: 'white' },
            { key: 'author', label: 'Author', minWidth: 10, priority: 1, cellColor: 'cyan' },
            { key: 'note', label: 'Note', minWidth: 20, priority: 2, cellColor: 'white' }
          ],
          rows: notes.map((note) => ({
            publishedDate: new Date(note.createdAt * 1000).toLocaleString(),
            author: shortId(note.authorPubkey, 10),
            note: shortText(note.content, 160)
          })),
          showHeader: true,
          noItemsLabel: 'No relay notes loaded'
        })
      }
      if (selectedRightTopAction.startsWith('Files')) {
        const files = fileRowsForGroup(state, group)
        return buildSegmentedTableRows({
          width: rightBottomWrapWidth,
          title: `Files for: ${groupName}`,
          columns: [
            { key: 'publishedDate', label: 'Published date', minWidth: 20, priority: 0, cellColor: 'white' },
            { key: 'author', label: 'Author', minWidth: 10, priority: 1, cellColor: 'cyan' },
            { key: 'file', label: 'File', minWidth: 16, priority: 2, cellColor: 'white' },
            { key: 'type', label: 'Type', minWidth: 8, priority: 3, cellColor: 'white' },
            { key: 'size', label: 'Size', minWidth: 8, priority: 4, align: 'right', cellColor: 'white' }
          ],
          rows: files.map((file) => ({
            publishedDate: new Date(Number(file.uploadedAt || 0) * 1000).toLocaleString(),
            author: shortId(file.uploadedBy || '-', 10),
            file: shortText(file.fileName || '-', 64),
            type: file.mime || '-',
            size: `${Number(file.size || 0)}B`
          })),
          showHeader: true,
          noItemsLabel: 'No relay files loaded'
        })
      }
      if (selectedRightTopAction.startsWith('Join Requests')) {
        const requests = joinRequestsForGroup(state, group)
        return buildJoinRequestTableRows({
          width: rightBottomWrapWidth,
          title: `Join requests for: ${groupName}`,
          requests,
          selectedIndex: selectedJoinRequestCursor
        })
      }
    }
    return null
  }, [
    state,
    selectedNode,
    selectedCenterRow,
    selectedRightTopAction,
    paneActionMessage,
    rightBottomWrapWidth,
    selectedJoinRequestCursor,
    joinRequestReviewState
  ])

  const rightBottomRenderRows = useMemo<DetailRenderRow[]>(() => {
    if (rightBottomSpecialRows) return rightBottomSpecialRows
    const forceActionTable = selectedRightTopRow?.kind === 'action'
    const candidateLines = forceActionTable
      ? coerceDetailLinesToKeyValue(rightBottomRawRows)
      : rightBottomRawRows
    if (forceActionTable || shouldUseKeyValueTable(candidateLines)) {
      return buildKeyValueDetailRows(candidateLines, rightBottomWrapWidth, forceActionTable)
    }
    return rightBottomRawRows.flatMap((row, index) =>
      wrapText(row, rightBottomWrapWidth).map((segment, segmentIndex) => ({
        key: `plain:${index}:${segmentIndex}`,
        kind: 'plain' as const,
        text: segment
      }))
    )
  }, [rightBottomRawRows, rightBottomWrapWidth, selectedRightTopRow, rightBottomSpecialRows])

  const rightBottomVisibleRows = Math.max(1, rightBottomBoxRows - 2)

  const rightBottomOffset = useMemo(() => {
    const raw = rightBottomOffsetByNode[selectedNode] || 0
    const maxOffset = Math.max(0, rightBottomRenderRows.length - rightBottomVisibleRows)
    return clamp(raw, 0, maxOffset)
  }, [rightBottomOffsetByNode, selectedNode, rightBottomRenderRows.length, rightBottomVisibleRows])

  useEffect(() => {
    const existing = rightBottomOffsetRef.current[selectedNode]
    if (existing === rightBottomOffset) return
    const next = {
      ...rightBottomOffsetRef.current,
      [selectedNode]: rightBottomOffset
    }
    setRightBottomOffsetByNode(next)
    controllerRef.current?.setDetailPaneOffset(selectedNode, rightBottomOffset).catch(() => {})
  }, [selectedNode, rightBottomOffset])

  useEffect(() => {
    if (!selectedJoinRequestContext || joinRequestReviewState) return
    if (selectedJoinRequestContext.requests.length === 0) return
    const rowLineIndex = 4 + (selectedJoinRequestCursor * 2)
    const currentOffset = rightBottomOffsetRef.current[selectedNode] || 0
    let nextOffset = currentOffset
    if (rowLineIndex < currentOffset) {
      nextOffset = rowLineIndex
    } else if (rowLineIndex >= currentOffset + rightBottomVisibleRows) {
      nextOffset = rowLineIndex - rightBottomVisibleRows + 1
    }
    const maxOffset = Math.max(0, rightBottomRenderRows.length - rightBottomVisibleRows)
    nextOffset = clamp(nextOffset, 0, maxOffset)
    if (nextOffset === currentOffset) return
    const next = {
      ...rightBottomOffsetRef.current,
      [selectedNode]: nextOffset
    }
    setRightBottomOffsetByNode(next)
    controllerRef.current?.setDetailPaneOffset(selectedNode, nextOffset).catch(() => {})
  }, [
    selectedNode,
    selectedJoinRequestContext,
    selectedJoinRequestCursor,
    joinRequestReviewState,
    rightBottomVisibleRows,
    rightBottomRenderRows.length
  ])

  const visibleRightRows = rightBottomRenderRows.slice(rightBottomOffset, rightBottomOffset + rightBottomVisibleRows)

  const buildCurrentCommandContext = (): CommandContext => {
    const snapshot = stateRef.current
    if (!snapshot) {
      return {}
    }
    const selectedRow = selectedCenterRowRef.current

    return {
      currentNode: selectedNodeRef.current,
      resolveSelectedGroup: () => {
        const row = selectedRow
        if (!row || row.kind !== 'group') return null
        const group = row.data as any
        return {
          id: group.id,
          relay: group.relay || null
        }
      },
      resolveSelectedInvite: () => {
        const row = selectedRow
        if (!row) return null
        if (row.kind === 'group-invite') {
          const invite = row.data as any
          return {
            kind: 'group',
            id: invite.id,
            groupId: invite.groupId,
            relay: invite.relay || null,
            token: invite.token || null
          }
        }
        if (row.kind === 'chat-invite') {
          const invite = row.data as any
          return {
            kind: 'chat',
            id: invite.id,
            conversationId: invite.conversationId || null
          }
        }
        return null
      },
      resolveSelectedRelay: () => {
        const row = selectedRow
        if (!row) return null
        let relay: any = null
        if (row.kind === 'relay') {
          relay = row.data as any
        } else if (row.kind === 'group') {
          relay = relayForGroup(snapshot, row.data as any)
        }
        if (!relay) return null
        return {
          relayKey: relay.relayKey,
          publicIdentifier: relay.publicIdentifier || null,
          connectionUrl: relay.connectionUrl || null
        }
      },
      resolveSelectedFile: () => {
        const row = selectedRow
        if (!row || row.kind !== 'file') return null
        const file = row.data as any
        return {
          eventId: file.eventId,
          groupId: file.groupId,
          fileName: file.fileName || null,
          relay: file.groupRelay || null,
          url: file.url || null,
          sha256: file.sha256 || null
        }
      },
      resolveSelectedConversation: () => {
        const row = selectedRow
        if (!row || row.kind !== 'chat-conversation') return null
        const conversation = row.data as any
        return {
          id: conversation.id
        }
      },
      resolveSelectedNote: () => {
        if (selectedNodeRef.current !== 'groups:my') return null
        const row = selectedRow
        if (!row || row.kind !== 'group') return null
        const group = row.data as any
        const notes = noteRowsForGroup(snapshot, group)
        const note = notes[0]
        if (!note) return null
        return {
          id: note.eventId,
          pubkey: note.authorPubkey,
          groupId: group.id
        }
      },
      copy: async (text: string) => {
        const result = await copyToClipboard(text)
        await controllerRef.current?.setLastCopied(text, result.method)
        return result
      },
      unsafeCopySecrets: process.env.HYPERTUNA_TUI_ALLOW_UNSAFE_COPY === '1'
    }
  }

  const toggleChatRelayDraft = (relayUrl: string): void => {
    const normalized = String(relayUrl || '').trim()
    if (!normalized) return
    setChatCreateDraft((previous) => {
      if (previous.relayUrls.includes(normalized)) {
        return {
          ...previous,
          relayUrls: previous.relayUrls.filter((entry) => entry !== normalized)
        }
      }
      return {
        ...previous,
        relayUrls: [...previous.relayUrls, normalized]
      }
    })
  }

  const runCreateGroup = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return
    const name = String(groupCreateDraft.name || '').trim()
    if (!name) {
      setPaneActionMessage('Relay name is required')
      return
    }
    const directJoinOnly = groupCreateDraft.directJoinOnly === true
    const rawGatewayOrigin = String(groupCreateDraft.gatewayOrigin || '').trim()
    const rawGatewayId = String(groupCreateDraft.gatewayId || '').trim()
    const normalizedGatewayOrigin = normalizeHttpOrigin(groupCreateDraft.gatewayOrigin)
    const normalizedGatewayId = normalizeGatewayId(groupCreateDraft.gatewayId)
    if (!directJoinOnly && !rawGatewayOrigin && !rawGatewayId) {
      setPaneActionMessage('Select a gateway from the picker or enable direct-join-only')
      return
    }
    if (!directJoinOnly && rawGatewayOrigin && !normalizedGatewayOrigin) {
      setPaneActionMessage('Gateway origin must be a valid http(s) URL')
      return
    }
    try {
      setPaneActionMessage('Creating relay…')
      const result = await controller.createRelay({
        name,
        description: String(groupCreateDraft.about || '').trim() || undefined,
        isOpen: groupCreateDraft.membership === 'open',
        isPublic: groupCreateDraft.visibility === 'public',
        fileSharing: true,
        gatewayOrigin: directJoinOnly ? null : normalizedGatewayOrigin,
        gatewayId: directJoinOnly ? null : normalizedGatewayId,
        directJoinOnly
      })
      await Promise.all([
        controller.refreshGroups(),
        controller.refreshRelays()
      ])
      const createdId = String(result.publicIdentifier || result.relayKey || name)
      setPaneActionMessage(`Relay created: ${createdId}`)
      setGroupCreateDraft({
        name: '',
        about: '',
        membership: 'open',
        visibility: 'public',
        directJoinOnly: true,
        gatewayOrigin: '',
        gatewayId: ''
      })
      setCreateCursorByNode((previous) => ({ ...previous, 'groups:create': 0 }))
      setCreateExpandedBranchByNode((previous) => ({ ...previous, 'groups:create': '' }))
      createEditStateRef.current = null
      setCreateEditState(null)
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const runCreateChat = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return
    const title = String(chatCreateDraft.name || '').trim()
    if (!title) {
      setPaneActionMessage('Chat name is required')
      return
    }
    try {
      setPaneActionMessage('Creating chat…')
      await controller.createConversation({
        title,
        description: String(chatCreateDraft.description || '').trim() || undefined,
        members: Array.from(new Set(chatCreateDraft.inviteMembers.map((entry) => entry.trim()).filter(Boolean))),
        relayUrls: chatCreateDraft.relayUrls.length ? Array.from(new Set(chatCreateDraft.relayUrls)) : undefined,
        relayMode: 'withFallback'
      })
      setPaneActionMessage(`Chat created: ${title}`)
      setChatCreateDraft({
        name: '',
        description: '',
        inviteMembers: [],
        relayUrls: []
      })
      setCreateCursorByNode((previous) => ({ ...previous, 'chats:create': 0 }))
      setCreateExpandedBranchByNode((previous) => ({ ...previous, 'chats:create': '' }))
      createEditStateRef.current = null
      setCreateEditState(null)
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const refreshCreateGatewayCatalog = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return
    try {
      setPaneActionMessage('Refreshing gateway catalog…')
      const gateways = await controller.refreshGatewayCatalog({ force: true })
      setPaneActionMessage(`Gateway catalog refreshed (${gateways.length} discovered)`)
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const currentCreateFieldValue = (
    node: CreateNodeId,
    field: CreateEditableField
  ): string => {
    if (node === 'groups:create') {
      if (field === 'name') return groupCreateDraft.name
      if (field === 'about') return groupCreateDraft.about
      if (field === 'membership') return groupCreateDraft.membership
      if (field === 'visibility') return groupCreateDraft.visibility
      if (field === 'directJoinOnly') return groupCreateDraft.directJoinOnly ? 'true' : 'false'
      if (field === 'gatewayOrigin') return groupCreateDraft.gatewayOrigin
      if (field === 'gatewayId') return groupCreateDraft.gatewayId
      return ''
    }
    if (field === 'name') return chatCreateDraft.name
    if (field === 'description') return chatCreateDraft.description
    if (field === 'inviteMembers') return chatCreateDraft.inviteMembers.join(',')
    if (field === 'relayUrls') return chatCreateDraft.relayUrls.join(',')
    return ''
  }

  const beginCreateFieldEdit = (row: CreateBrowseRow): void => {
    if (row.kind !== 'field' || !isCreateNodeId(selectedNode)) return
    if (row.editor === 'text') {
      const next: CreateEditState = {
        node: selectedNode,
        field: row.field,
        label: row.label,
        editor: 'text',
        value: currentCreateFieldValue(selectedNode, row.field),
        required: row.required
      }
      createEditStateRef.current = next
      setCreateEditState(next)
      return
    }
    const options = row.options || []
    const currentValue = currentCreateFieldValue(selectedNode, row.field)
    const selectedIndex = Math.max(0, options.findIndex((entry) => entry.value === currentValue))
    const next: CreateEditState = {
      node: selectedNode,
      field: row.field,
      label: row.label,
      editor: 'choice',
      options,
      selectedIndex
    }
    createEditStateRef.current = next
    setCreateEditState(next)
  }

  const openCreateGatewayPicker = (): void => {
    if (selectedNode !== 'groups:create') return
    const selectedOptionIndex = createGatewayOptions.findIndex((option) => option.selected)
    const next: CreateEditState = {
      node: 'groups:create',
      editor: 'gateway-picker',
      selectedIndex: selectedOptionIndex >= 0 ? selectedOptionIndex + 1 : 0
    }
    createEditStateRef.current = next
    setCreateEditState(next)
  }

  const openCreateGatewayManualEntry = (): void => {
    if (selectedNode !== 'groups:create') return
    const next: CreateEditState = {
      node: 'groups:create',
      editor: 'gateway-manual',
      selectedField: 'gatewayOrigin',
      gatewayOrigin: groupCreateDraft.gatewayOrigin,
      gatewayId: groupCreateDraft.gatewayId
    }
    createEditStateRef.current = next
    setCreateEditState(next)
  }

  const openCreateChatRelayPicker = (): void => {
    if (selectedNode !== 'chats:create') return
    const selectedOptionIndex = createChatRelayOptions.findIndex((option) => option.selected)
    const next: CreateEditState = {
      node: 'chats:create',
      editor: 'relay-picker',
      selectedIndex: selectedOptionIndex >= 0 ? selectedOptionIndex : 0
    }
    createEditStateRef.current = next
    setCreateEditState(next)
  }

  const openCreateChatRelayManualEntry = (): void => {
    if (selectedNode !== 'chats:create') return
    const next: CreateEditState = {
      node: 'chats:create',
      field: 'relayUrls',
      label: 'Relay URLs',
      editor: 'text',
      value: chatCreateDraft.relayUrls.join(',')
    }
    createEditStateRef.current = next
    setCreateEditState(next)
  }

  const applyCreateFieldEdit = (edit: CreateEditState, value: string): void => {
    if (edit.node === 'groups:create' && ('field' in edit)) {
      if (edit.field === 'name') {
        setGroupCreateDraft((previous) => ({ ...previous, name: value.trim() }))
        return
      }
      if (edit.field === 'about') {
        setGroupCreateDraft((previous) => ({ ...previous, about: value.trim() }))
        return
      }
      if (edit.field === 'membership') {
        setGroupCreateDraft((previous) => ({ ...previous, membership: value === 'closed' ? 'closed' : 'open' }))
        return
      }
      if (edit.field === 'visibility') {
        setGroupCreateDraft((previous) => ({ ...previous, visibility: value === 'private' ? 'private' : 'public' }))
        return
      }
      if (edit.field === 'directJoinOnly') {
        const directJoinOnly = value === 'true'
        setGroupCreateDraft((previous) => ({
          ...previous,
          directJoinOnly,
          ...(directJoinOnly
            ? {
                gatewayOrigin: '',
                gatewayId: ''
              }
            : {})
        }))
        if (directJoinOnly) {
          setCreateExpandedBranchByNode((previous) => ({ ...previous, 'groups:create': '' }))
        }
        return
      }
      if (edit.field === 'gatewayOrigin') {
        const next = value.trim()
        setGroupCreateDraft((previous) => ({
          ...previous,
          gatewayOrigin: next,
          directJoinOnly: next ? false : previous.directJoinOnly
        }))
        return
      }
      if (edit.field === 'gatewayId') {
        const next = value.trim().toLowerCase()
        setGroupCreateDraft((previous) => ({
          ...previous,
          gatewayId: next,
          directJoinOnly: next ? false : previous.directJoinOnly
        }))
      }
      return
    }

    if (!('field' in edit)) return

    if (edit.field === 'name') {
      setChatCreateDraft((previous) => ({ ...previous, name: value.trim() }))
      return
    }
    if (edit.field === 'description') {
      setChatCreateDraft((previous) => ({ ...previous, description: value.trim() }))
      return
    }
    if (edit.field === 'inviteMembers') {
      setChatCreateDraft((previous) => ({ ...previous, inviteMembers: csvToUniqueList(value) }))
      return
    }
    if (edit.field === 'relayUrls') {
      setChatCreateDraft((previous) => ({ ...previous, relayUrls: csvToUniqueList(value) }))
    }
  }

  const commitCreateEdit = (): void => {
    const edit = createEditStateRef.current
    if (!edit) return
    if (edit.editor === 'text') {
      applyCreateFieldEdit(edit, edit.value)
    } else if (edit.editor === 'choice') {
      const selected = edit.options[edit.selectedIndex]
      if (selected) {
        applyCreateFieldEdit(edit, selected.value)
      }
    } else if (edit.editor === 'gateway-manual') {
      const nextOrigin = String(edit.gatewayOrigin || '').trim()
      const nextGatewayId = String(edit.gatewayId || '').trim().toLowerCase()
      setGroupCreateDraft((previous) => ({
        ...previous,
        gatewayOrigin: nextOrigin,
        gatewayId: nextGatewayId,
        directJoinOnly: (nextOrigin || nextGatewayId) ? false : previous.directJoinOnly
      }))
    }
    createEditStateRef.current = null
    setCreateEditState(null)
  }

  const executeCreateBrowseRow = async (row: CreateBrowseRow): Promise<void> => {
    if (row.kind === 'field') {
      beginCreateFieldEdit(row)
      return
    }
    if (row.kind === 'branch-parent' && isCreateNodeId(selectedNode)) {
      setCreateExpandedBranchByNode((previous) => ({
        ...previous,
        [selectedNode]: previous[selectedNode] === row.branch ? '' : row.branch
      }))
      return
    }
    if (row.kind === 'branch-child') {
      if (row.action === 'gateway-picker') {
        openCreateGatewayPicker()
        return
      }
      if (row.action === 'gateway-manual') {
        openCreateGatewayManualEntry()
        return
      }
      if (row.action === 'relay-picker') {
        openCreateChatRelayPicker()
        return
      }
      if (row.action === 'relay-manual') {
        openCreateChatRelayManualEntry()
      }
      return
    }
    if (row.kind === 'submit') {
      if (selectedNode === 'groups:create') {
        await runCreateGroup()
      } else if (selectedNode === 'chats:create') {
        await runCreateChat()
      }
    }
  }

  const openInviteCompose = (target: InviteComposeTarget): void => {
    const next: InviteComposeState = {
      target,
      query: '',
      suggestions: [],
      suggestionIndex: 0,
      busy: false,
      status: ''
    }
    inviteComposeStateRef.current = next
    setInviteComposeState(next)
  }

  const sendInviteFromCompose = async (): Promise<void> => {
    const controller = controllerRef.current
    const compose = inviteComposeStateRef.current
    if (!controller || !state || !compose) return
    if (compose.busy) return

    const suggestion = compose.suggestions[compose.suggestionIndex] || null
    const typed = String(compose.query || '').trim()
    const inviteePubkey = suggestion?.pubkey || (isHex64(typed) ? typed.toLowerCase() : null)
    if (!inviteePubkey) {
      setInviteComposeState((previous) => (
        previous
          ? {
              ...previous,
              status: 'Select a suggestion or enter a valid 64-char pubkey'
            }
          : previous
      ))
      return
    }

    try {
      setInviteComposeState((previous) => previous ? { ...previous, busy: true, status: 'Sending invite…' } : previous)
      if (compose.target.kind === 'group') {
        const group = state.myGroups.find((entry) => entry.id === compose.target.id)
        const relayUrl = String(group?.relay || compose.target.relay || '').trim()
        if (!relayUrl) {
          throw new Error('Selected relay has no relay URL')
        }
        await controller.sendInvite({
          groupId: compose.target.id,
          relayUrl,
          inviteePubkey,
          payload: {
            groupName: group?.name || compose.target.name || compose.target.id,
            isPublic: group?.isPublic !== false,
            fileSharing: group?.isOpen !== false
          }
        })
      } else {
        const result = await controller.inviteChatMembers(compose.target.id, [inviteePubkey])
        if (result.failed?.length) {
          throw new Error(result.failed[0]?.error || 'Invite failed')
        }
      }
      const successMessage = `Invite sent: ${shortId(inviteePubkey, 16)}`
      setPaneActionMessage(successMessage)
      setInviteComposeState((previous) => (
        previous
          ? {
              ...previous,
              query: '',
              suggestions: [],
              suggestionIndex: 0,
              busy: false,
              status: successMessage
            }
          : previous
      ))
    } catch (error) {
      setInviteComposeState((previous) => (
        previous
          ? {
              ...previous,
              busy: false,
              status: error instanceof Error ? error.message : String(error)
            }
          : previous
      ))
    }
  }

  const executeJoinRequestReviewAction = async (): Promise<void> => {
    const controller = controllerRef.current
    const review = joinRequestReviewState
    if (!controller || !review || review.busy) return

    try {
      setJoinRequestReviewState((previous) => previous ? { ...previous, busy: true, status: 'Processing request…' } : previous)
      if (review.selectedAction === 'approve') {
        await controller.approveJoinRequest(review.groupId, review.request.pubkey, review.relay || undefined)
        setPaneActionMessage(`Approved join request ${shortId(review.request.pubkey, 12)}`)
      } else {
        await controller.rejectJoinRequest(review.groupId, review.request.pubkey, review.relay || undefined)
        setPaneActionMessage(`Dismissed join request ${shortId(review.request.pubkey, 12)}`)
      }
      await controller.refreshJoinRequests(review.groupId, review.relay || undefined)
      setJoinRequestReviewState(null)
    } catch (error) {
      setJoinRequestReviewState((previous) => (
        previous
          ? {
              ...previous,
              busy: false,
              status: error instanceof Error ? error.message : String(error)
            }
          : previous
      ))
    }
  }

  const executeRightTopAction = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller || !state) return
    if (!selectedCenterRow || !selectedRightTopAction) return

    try {
      if (selectedRightTopAction.startsWith('Send Invite')) {
        if (!selectedInviteComposeTarget) {
          setPaneActionMessage('Send Invite is available for admin-owned relays/chats only')
          return
        }
        openInviteCompose(selectedInviteComposeTarget)
        return
      }

      if (selectedNode === 'groups:browse' && selectedCenterRow.kind === 'group') {
        const group = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Join Relay')) {
          setPaneActionMessage('Joining relay…')
          await controller.startJoinFlow({
            publicIdentifier: group.id,
            relayUrl: group.relay || undefined,
            gatewayOrigin: group.gatewayOrigin || undefined,
            gatewayId: group.gatewayId || undefined,
            directJoinOnly: group.directJoinOnly === true,
            openJoin: group.isPublic !== false && group.isOpen !== false
          })
          await Promise.all([
            controller.refreshGroups(),
            controller.refreshRelays()
          ])
          setPaneActionMessage(`Joined relay: ${group.name || group.id}`)
          return
        }
        if (selectedRightTopAction.startsWith('Request Invite')) {
          setPaneActionMessage('Requesting invite…')
          await controller.requestGroupInvite({
            groupId: group.id,
            relay: group.relay || null
          })
          setPaneActionMessage(`Join request for ${group.name || group.id} submitted`)
          return
        }
      }

      if (selectedNode === 'invites:group' && selectedCenterRow.kind === 'group-invite') {
        const invite = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Accept invite')) {
          setPaneActionMessage('Accepting invite…')
          await controller.acceptGroupInvite(invite.id)
          setPaneActionMessage('Invite accepted')
          await controller.refreshInvites()
          return
        }
        if (selectedRightTopAction.startsWith('Dismiss invite')) {
          setPaneActionMessage('Dismissing invite…')
          await controller.dismissGroupInvite(invite.id)
          setPaneActionMessage('Invite dismissed')
          await controller.refreshInvites()
          return
        }
      }

      if (selectedNode === 'invites:chat' && selectedCenterRow.kind === 'chat-invite') {
        const invite = selectedCenterRow.data as any
        if (selectedRightTopAction.startsWith('Accept invite')) {
          setPaneActionMessage('Accepting chat invite…')
          await controller.acceptChatInvite(invite.id)
          setPaneActionMessage('Chat invite accepted')
          await controller.refreshChats()
          return
        }
        if (selectedRightTopAction.startsWith('Dismiss invite')) {
          setPaneActionMessage('Dismissing chat invite…')
          await controller.dismissChatInvite(invite.id)
          setPaneActionMessage('Chat invite dismissed')
          await controller.refreshChats()
          return
        }
      }

      if ((selectedNode === 'files' || isFileTypeNodeId(selectedNode)) && selectedCenterRow.kind === 'file') {
        const file = selectedCenterRow.data as any
        if (!file?.sha256) {
          setPaneActionMessage('Selected file has no sha256 hash')
          return
        }

        if (selectedRightTopAction.startsWith('Download')) {
          setPaneActionMessage('Downloading file…')
          const result = await controller.downloadGroupFile({
            relayKey: file.groupRelay && /^[a-f0-9]{64}$/i.test(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
            publicIdentifier: file.groupId,
            groupId: file.groupId,
            eventId: file.eventId,
            fileHash: file.sha256,
            fileName: file.fileName || null
          })
          setPaneActionMessage(`Download complete: ${result.savedPath}`)
          return
        }

        if (selectedRightTopAction.startsWith('Delete')) {
          setPaneActionMessage('Deleting local file…')
          const result = await controller.deleteLocalGroupFile({
            relayKey: file.groupRelay && /^[a-f0-9]{64}$/i.test(file.groupRelay) ? file.groupRelay.toLowerCase() : null,
            publicIdentifier: file.groupId,
            groupId: file.groupId,
            eventId: file.eventId,
            fileHash: file.sha256
          })
          setPaneActionMessage(result.deleted ? 'File deleted from local storage' : `Delete failed: ${result.reason || 'unknown'}`)
          return
        }
      }

      setPaneActionMessage(`${selectedRightTopAction} selected`)
    } catch (error) {
      setPaneActionMessage(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!initialized) return
    if (!scriptedCommands?.length) return
    if (scriptStartedRef.current) return

    const controller = controllerRef.current
    if (!controller) return

    scriptStartedRef.current = true
    let cancelled = false

    ;(async () => {
      for (const step of scriptedCommands) {
        if (cancelled) return
        const idle = await waitForControllerIdle(controller, 45_000)
        if (!idle) {
          setCommandMessage('$ [warn] timed out waiting for idle state; continuing')
        }
        await sleep(step.delayMs ?? 450)
        if (cancelled) return

        const command =
          step.resolveCommand
            ? await step.resolveCommand(controller)
            : step.command || null

        if (!command) {
          setCommandMessage('$ [skip] scripted step')
          await sleep(step.pauseAfterMs ?? 600)
          continue
        }

        try {
          const result = await withStepTimeout(
            executeCommand(controller, command, buildCurrentCommandContext()),
            step.timeoutMs ?? 20_000,
            `Script step "${command}"`
          )
          if (cancelled) return
          setCommandMessage(`$ ${command} -> ${result.message}`)
          if (result.gotoNode) {
            setSelectedNode(result.gotoNode)
          }
        } catch (error) {
          if (cancelled) return
          setCommandMessage(`$ ${command} -> ERROR: ${error instanceof Error ? error.message : String(error)}`)
        }

        await sleep(step.pauseAfterMs ?? 600)
      }

      if (autoExitOnScriptComplete) {
        await controller.shutdown().catch(() => {})
        if (!cancelled) {
          exitRef.current()
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [initialized, scriptedCommands, autoExitOnScriptComplete])

  useInput((input, key) => {
    const controller = controllerRef.current
    const snapshot = stateRef.current
    if (!controller || !snapshot) return

    if (commandInputOpen) {
      if (key.escape) {
        setCommandInputOpen(false)
        setCommandInput('')
      }
      return
    }

    if (key.ctrl && input === 'c') {
      controller.shutdown().finally(() => exit())
      return
    }

    const currentNode = selectedNodeRef.current
    const currentFocus = focusPaneRef.current
    const currentCreateEdit = createEditStateRef.current
    const createEditActive = Boolean(
      currentCreateEdit
      && currentFocus === 'right-top'
      && isCreateNodeId(currentNode)
      && currentCreateEdit.node === currentNode
    )

    if (createEditActive && currentCreateEdit) {
      if (key.escape) {
        createEditStateRef.current = null
        setCreateEditState(null)
        return
      }

      if (currentCreateEdit.editor === 'gateway-picker') {
        const totalRows = Math.max(1, createGatewayOptions.length) + 1 // refresh row + options/placeholder
        const maxIndex = Math.max(0, totalRows - 1)
        if (key.upArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-picker') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex - 1, 0, maxIndex)
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.downArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-picker') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex + 1, 0, maxIndex)
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.return) {
          const selectedIndex = currentCreateEdit.selectedIndex
          if (selectedIndex <= 0) {
            refreshCreateGatewayCatalog().catch((error) => {
              setPaneActionMessage(error instanceof Error ? error.message : String(error))
            })
            return
          }
          const selectedOption = createGatewayOptions[selectedIndex - 1]
          if (!selectedOption) return
          setGroupCreateDraft((previous) => ({
            ...previous,
            directJoinOnly: false,
            gatewayId: selectedOption.gatewayId.trim().toLowerCase(),
            gatewayOrigin: selectedOption.gatewayOrigin.trim()
          }))
          setPaneActionMessage(`Selected gateway ${selectedOption.gatewayId}`)
          createEditStateRef.current = null
          setCreateEditState(null)
          return
        }
        return
      }

      if (currentCreateEdit.editor === 'relay-picker') {
        const maxIndex = Math.max(0, createChatRelayOptions.length - 1)
        if (key.upArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'relay-picker') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex - 1, 0, maxIndex)
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.downArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'relay-picker') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex + 1, 0, maxIndex)
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.return) {
          const selectedOption = createChatRelayOptions[currentCreateEdit.selectedIndex]
          if (!selectedOption) return
          toggleChatRelayDraft(selectedOption.relayUrl)
          return
        }
        return
      }

      if (currentCreateEdit.editor === 'gateway-manual') {
        if (key.upArrow || key.downArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-manual') return previous
            const next = {
              ...previous,
              selectedField: previous.selectedField === 'gatewayOrigin' ? 'gatewayId' : 'gatewayOrigin'
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.return) {
          commitCreateEdit()
          return
        }
        if (key.backspace || key.delete) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-manual') return previous
            const field = previous.selectedField
            const next = {
              ...previous,
              [field]: previous[field].slice(0, -1)
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.ctrl && input === 'u') {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-manual') return previous
            const field = previous.selectedField
            const next = {
              ...previous,
              [field]: ''
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        const isPrintable = !key.ctrl && !(key as unknown as { meta?: boolean }).meta && input.length > 0
        if (isPrintable) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'gateway-manual') return previous
            const field = previous.selectedField
            const next = {
              ...previous,
              [field]: `${previous[field]}${input}`
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        return
      }

      if (currentCreateEdit.editor === 'choice') {
        if (key.upArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'choice') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex - 1, 0, Math.max(0, previous.options.length - 1))
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.downArrow) {
          setCreateEditState((previous) => {
            if (!previous || previous.editor !== 'choice') return previous
            const next = {
              ...previous,
              selectedIndex: clamp(previous.selectedIndex + 1, 0, Math.max(0, previous.options.length - 1))
            }
            createEditStateRef.current = next
            return next
          })
          return
        }
        if (key.return) {
          commitCreateEdit()
          return
        }
        return
      }

      if (key.return) {
        commitCreateEdit()
        return
      }

      if (key.backspace || key.delete) {
        setCreateEditState((previous) => {
          if (!previous || previous.editor !== 'text') return previous
          const next = {
            ...previous,
            value: previous.value.slice(0, -1)
          }
          createEditStateRef.current = next
          return next
        })
        return
      }

      if (key.ctrl && input === 'u') {
        setCreateEditState((previous) => {
          if (!previous || previous.editor !== 'text') return previous
          const next = {
            ...previous,
            value: ''
          }
          createEditStateRef.current = next
          return next
        })
        return
      }

      const isPrintable = !key.ctrl && !(key as unknown as { meta?: boolean }).meta && input.length > 0
      if (isPrintable) {
        setCreateEditState((previous) => {
          if (!previous || previous.editor !== 'text') return previous
          const next = {
            ...previous,
            value: `${previous.value}${input}`
          }
          createEditStateRef.current = next
          return next
        })
        return
      }
      return
    }

    const currentInviteCompose = inviteComposeStateRef.current
    const inviteComposeActive = Boolean(currentInviteCompose && currentFocus === 'right-top')
    if (inviteComposeActive && currentInviteCompose) {
      if (key.escape) {
        inviteComposeStateRef.current = null
        setInviteComposeState(null)
        return
      }
      if (key.return) {
        sendInviteFromCompose().catch((error) => {
          setInviteComposeState((previous) => (
            previous
              ? {
                  ...previous,
                  busy: false,
                  status: error instanceof Error ? error.message : String(error)
                }
              : previous
          ))
        })
        return
      }
      if (key.upArrow) {
        setInviteComposeState((previous) => {
          if (!previous) return previous
          const next = {
            ...previous,
            suggestionIndex: clamp(previous.suggestionIndex - 1, 0, Math.max(0, previous.suggestions.length - 1))
          }
          inviteComposeStateRef.current = next
          return next
        })
        return
      }
      if (key.downArrow) {
        setInviteComposeState((previous) => {
          if (!previous) return previous
          const next = {
            ...previous,
            suggestionIndex: clamp(previous.suggestionIndex + 1, 0, Math.max(0, previous.suggestions.length - 1))
          }
          inviteComposeStateRef.current = next
          return next
        })
        return
      }
      if (key.backspace || key.delete) {
        setInviteComposeState((previous) => {
          if (!previous) return previous
          const next = {
            ...previous,
            query: previous.query.slice(0, -1),
            status: ''
          }
          inviteComposeStateRef.current = next
          return next
        })
        return
      }
      if (key.ctrl && input === 'u') {
        setInviteComposeState((previous) => {
          if (!previous) return previous
          const next = {
            ...previous,
            query: '',
            status: ''
          }
          inviteComposeStateRef.current = next
          return next
        })
        return
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n\t]/g, '')
        if (!sanitized) return
        setInviteComposeState((previous) => {
          if (!previous) return previous
          const next = {
            ...previous,
            query: `${previous.query}${sanitized}`,
            status: ''
          }
          inviteComposeStateRef.current = next
          return next
        })
      }
      return
    }

    if (key.tab) {
      const order: FocusPane[] = ['left-tree', 'right-top', 'right-bottom']
      const current = focusPaneRef.current
      const index = order.indexOf(current)
      const delta = key.shift ? -1 : 1
      const next = order[(index + delta + order.length) % order.length]
      setFocusPane(next)
      controller.setFocusPane(next).catch(() => {})
      return
    }

    if (input === 'q') {
      controller.shutdown().finally(() => exit())
      return
    }

    if (input === ':') {
      setCommandInputOpen(true)
      setCommandInput('')
      return
    }

    if (input === 'y') {
      executeCommand(controller, 'copy selected', buildCurrentCommandContext())
        .then((result) => setCommandMessage(result.message))
        .catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
      return
    }

    if (input === 'Y') {
      executeCommand(controller, 'copy command', buildCurrentCommandContext())
        .then((result) => setCommandMessage(result.message))
        .catch((error) => {
          setCommandMessage(error instanceof Error ? error.message : String(error))
        })
      return
    }

    if (input === 'r') {
      refreshNode(controller, selectedNodeRef.current, selectedCenterRowRef.current)
        .then(() => setCommandMessage(`Refreshed ${displayNodeId(selectedNodeRef.current)}`))
        .catch((error) => setCommandMessage(error instanceof Error ? error.message : String(error)))
      return
    }

    if (currentFocus === 'left-tree') {
      const navIndex = navIndexById.get(currentNode) ?? 0
      if (key.upArrow) {
        const nextIndex = clamp(navIndex - 1, 0, Math.max(0, navRows.length - 1))
        const nextRow = navRows[nextIndex]
        if (!nextRow) return
        setSelectedNode(nextRow.id)
        controller.setSelectedNode(nextRow.id).catch(() => {})
        return
      }

      if (key.downArrow) {
        const nextIndex = clamp(navIndex + 1, 0, Math.max(0, navRows.length - 1))
        const nextRow = navRows[nextIndex]
        if (!nextRow) return
        setSelectedNode(nextRow.id)
        controller.setSelectedNode(nextRow.id).catch(() => {})
        return
      }

      if (key.rightArrow) {
        if (isParentNavId(currentNode)) {
          if (!treeExpanded[currentNode]) {
            const next = {
              ...treeExpanded,
              [currentNode]: true
            }
            setTreeExpanded(next)
            controller.setTreeExpanded(next).catch(() => {})
            return
          }

          const nextRow = navRows.find((row) => row.parent === currentNode)
          if (nextRow) {
            setSelectedNode(nextRow.id)
            controller.setSelectedNode(nextRow.id).catch(() => {})
          }
        }
        return
      }

      if (key.leftArrow) {
        const currentRow = navRows[navIndex]
        if (!currentRow) return
        if (currentRow.parent) {
          setSelectedNode(currentRow.parent)
          controller.setSelectedNode(currentRow.parent).catch(() => {})
          return
        }
        if (isParentNavId(currentNode) && treeExpanded[currentNode]) {
          const next = {
            ...treeExpanded,
            [currentNode]: false
          }
          setTreeExpanded(next)
          controller.setTreeExpanded(next).catch(() => {})
        }
        return
      }

      if (key.return) {
        if (isParentNavId(currentNode)) {
          const next = {
            ...treeExpanded,
            [currentNode]: !treeExpanded[currentNode]
          }
          setTreeExpanded(next)
          controller.setTreeExpanded(next).catch(() => {})
        } else {
          controller.setSelectedNode(currentNode).catch(() => {})
        }
        return
      }
      return
    }

    if (currentFocus === 'right-top') {
      if (isCreateNodeId(currentNode)) {
        const maxIndex = Math.max(0, createRows.length - 1)
        const currentIndex = clamp(createCursorRef.current[currentNode] || 0, 0, maxIndex)
        const moveCreateCursor = (next: number): void => {
          const clamped = clamp(next, 0, maxIndex)
          if (clamped === currentIndex) return
          setCreateCursorByNode((previous) => ({
            ...previous,
            [currentNode]: clamped
          }))
        }

        if (key.upArrow) {
          moveCreateCursor(currentIndex - 1)
          return
        }

        if (key.downArrow) {
          moveCreateCursor(currentIndex + 1)
          return
        }

        if (key.pageUp) {
          moveCreateCursor(currentIndex - Math.max(1, Math.floor(rightTopVisibleRows / 2)))
          return
        }

        if (key.pageDown) {
          moveCreateCursor(currentIndex + Math.max(1, Math.floor(rightTopVisibleRows / 2)))
          return
        }

        const maybeHome = (key as unknown as { home?: boolean }).home
        const maybeEnd = (key as unknown as { end?: boolean }).end

        if (maybeHome || (key.ctrl && input === 'a') || input === 'g') {
          moveCreateCursor(0)
          return
        }

        if (maybeEnd || (key.ctrl && input === 'e') || input === 'G') {
          moveCreateCursor(maxIndex)
          return
        }

        if (key.return) {
          const row = createRows[currentIndex] || null
          if (!row) return
          executeCreateBrowseRow(row).catch((error) => {
            setPaneActionMessage(error instanceof Error ? error.message : String(error))
          })
        }
        return
      }

      const viewport = nodeViewportRef.current[currentNode] || { cursor: 0, offset: 0 }
      const normalized = normalizeViewport(viewport.cursor, viewport.offset, rightTopRows.length, rightTopVisibleRows)

      const moveCursor = (nextCursor: number) => {
        const nextViewport = normalizeViewport(nextCursor, normalized.offset, rightTopRows.length, rightTopVisibleRows)
        const merged = {
          ...nodeViewportRef.current,
          [currentNode]: {
            cursor: nextViewport.selectedIndex,
            offset: nextViewport.offset
          }
        }
        setNodeViewport(merged)
        controller.setPaneViewport(currentNode, nextViewport.selectedIndex, nextViewport.offset).catch(() => {})
      }

      if (key.upArrow) {
        moveCursor(normalized.selectedIndex - 1)
        return
      }

      if (key.downArrow) {
        moveCursor(normalized.selectedIndex + 1)
        return
      }

      if (key.pageUp) {
        moveCursor(normalized.selectedIndex - rightTopVisibleRows)
        return
      }

      if (key.pageDown) {
        moveCursor(normalized.selectedIndex + rightTopVisibleRows)
        return
      }

      const maybeHome = (key as unknown as { home?: boolean }).home
      const maybeEnd = (key as unknown as { end?: boolean }).end

      if (maybeHome || (key.ctrl && input === 'a') || input === 'g') {
        moveCursor(0)
        return
      }

      if (maybeEnd || (key.ctrl && input === 'e') || input === 'G') {
        moveCursor(Math.max(0, rightTopRows.length - 1))
        return
      }

      if (key.return) {
        const selectedRow = rightTopRows[normalized.selectedIndex] || null
        if (!selectedRow) return

        if (selectedRow.kind === 'action') {
          executeRightTopAction().catch((error) => {
            setPaneActionMessage(error instanceof Error ? error.message : String(error))
          })
          return
        }

        if (selectedRow.expandable) {
          setExpandedActionParentByNode((previous) => {
            const existing = previous[currentNode] || ''
            return {
              ...previous,
              [currentNode]: existing === selectedRow.centerRow.key ? '' : selectedRow.centerRow.key
            }
          })
          return
        }

      }

      return
    }

    if (currentFocus === 'right-bottom') {
      if (joinRequestReviewState) {
        if (key.escape) {
          setJoinRequestReviewState(null)
          return
        }
        if (key.upArrow || key.downArrow) {
          setJoinRequestReviewState((previous) => {
            if (!previous || previous.busy) return previous
            return {
              ...previous,
              selectedAction: previous.selectedAction === 'approve' ? 'dismiss' : 'approve',
              status: ''
            }
          })
          return
        }
        if (key.return) {
          executeJoinRequestReviewAction().catch((error) => {
            setJoinRequestReviewState((previous) => (
              previous
                ? {
                    ...previous,
                    busy: false,
                    status: error instanceof Error ? error.message : String(error)
                  }
                : previous
            ))
          })
          return
        }
      }

      if (selectedJoinRequestContext && !joinRequestReviewState) {
        if (key.upArrow) {
          setJoinRequestCursorByGroupKey((previous) => ({
            ...previous,
            [selectedJoinRequestContext.key]: clamp(selectedJoinRequestCursor - 1, 0, Math.max(0, selectedJoinRequestContext.requests.length - 1))
          }))
          return
        }
        if (key.downArrow) {
          setJoinRequestCursorByGroupKey((previous) => ({
            ...previous,
            [selectedJoinRequestContext.key]: clamp(selectedJoinRequestCursor + 1, 0, Math.max(0, selectedJoinRequestContext.requests.length - 1))
          }))
          return
        }
        if (key.return) {
          const request = selectedJoinRequestContext.requests[selectedJoinRequestCursor] || null
          if (!request) return
          const next: JoinRequestReviewState = {
            groupId: selectedJoinRequestContext.group.id,
            groupName: groupDisplayName(selectedJoinRequestContext.group),
            relay: selectedJoinRequestContext.group.relay || null,
            request,
            selectedAction: 'approve',
            busy: false,
            status: ''
          }
          setJoinRequestReviewState(next)
          return
        }
      }

      const rows = rightBottomRenderRows.length
      const visible = rightBottomVisibleRows
      const maxOffset = Math.max(0, rows - visible)
      const currentOffset = rightBottomOffsetRef.current[currentNode] || 0

      const moveOffset = (delta: number) => {
        const nextOffset = clamp(currentOffset + delta, 0, maxOffset)
        if (nextOffset === currentOffset) return
        const next = {
          ...rightBottomOffsetRef.current,
          [currentNode]: nextOffset
        }
        setRightBottomOffsetByNode(next)
        controller.setDetailPaneOffset(currentNode, nextOffset).catch(() => {})
      }

      if (key.upArrow) {
        moveOffset(-1)
        return
      }

      if (key.downArrow) {
        moveOffset(1)
        return
      }

      if ((key.ctrl && input === 'u') || input === '{') {
        moveOffset(-Math.max(1, Math.floor(visible / 2)))
        return
      }

      if ((key.ctrl && input === 'd') || input === '}') {
        moveOffset(Math.max(1, Math.floor(visible / 2)))
      }
    }
  })

  const runCommand = async (): Promise<void> => {
    const controller = controllerRef.current
    if (!controller) return

    const value = commandInput.trim()
    if (!value) {
      setCommandInputOpen(false)
      return
    }

    setCommandInputOpen(false)
    setCommandInput('')

    try {
      const result = await executeCommand(controller, value, buildCurrentCommandContext())
      setCommandMessage(result.message)
      if (result.gotoNode) {
        setSelectedNode(result.gotoNode)
        controller.setSelectedNode(result.gotoNode).catch(() => {})
      }
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : String(error))
    }
  }

  if (!state) {
    return (
      <Box flexDirection="column">
        <TruncText color="cyan">Booting Hypertuna TUI…</TruncText>
      </Box>
    )
  }

  const navIndex = navIndexById.get(selectedNode) ?? 0
  const visibleRightTopRows = rightTopRows.slice(
    selectedNodeViewport.offset,
    selectedNodeViewport.offset + rightTopVisibleRows
  )
  const rightTopHeaderPrefix = '  '

  const renderRightTopRow = (row: RightTopRow, absolute: number): React.JSX.Element => {
    const selected = absolute === selectedNodeViewport.selectedIndex
    if (row.kind === 'action') {
      const position = actionBlockPosition(rightTopRows, absolute) || 'single'
      const actionLine = buildActionDropdownLine(row.label, rightTopContentWidth, position)
      const borderColor = selected ? 'green' : 'blue'
      const labelColor = selected ? 'green' : 'cyan'
      return (
        <Text key={`${row.key}-${absolute}`}>
          <Text color={selected ? 'green' : undefined}>{selected ? '>' : ' '}</Text>
          <Text> </Text>
          <Text color={borderColor}>{actionLine.slice(0, 2)}</Text>
          <Text color={labelColor}>{actionLine.slice(2, Math.max(2, actionLine.length - 2))}</Text>
          <Text color={borderColor}>{actionLine.slice(Math.max(2, actionLine.length - 2))}</Text>
        </Text>
      )
    }

    const indent = row.depth > 0 ? '  ' : ''
    const prefix = row.expandable
      ? row.expanded ? '▾' : '▸'
      : '•'
    const line = rightTopTable
      ? (rightTopTable.rowLines[absolute] || '')
      : `${indent}${prefix} ${row.label}`
    return (
      <Text key={`${row.key}-${absolute}`} color={selected ? 'green' : undefined}>
        {selected ? '>' : ' '} {line}
      </Text>
    )
  }

  const renderDetailRow = (row: DetailRenderRow): React.JSX.Element => {
    if (row.kind === 'plain') {
      return <Text key={row.key}>{row.text}</Text>
    }
    if (row.kind === 'segments') {
      return (
        <Text key={row.key}>
          {row.segments.map((segment, index) => (
            <Text
              key={`${row.key}:segment:${index}`}
              color={segment.color}
              dimColor={segment.dimColor}
            >
              {segment.text}
            </Text>
          ))}
        </Text>
      )
    }
    if (row.kind === 'kv-rule') {
      return (
        <Text key={row.key}>
          <Text color="blue">{row.left}</Text>
          <Text color="blue">{row.fieldRule}</Text>
          <Text color="blue">{row.middle}</Text>
          <Text color="blue">{row.valueRule}</Text>
          <Text color="blue">{row.right}</Text>
        </Text>
      )
    }
    if (row.kind === 'kv-header') {
      return (
        <Text key={row.key}>
          <Text color="blue">│ </Text>
          <Text color="yellow">{row.field}</Text>
          <Text color="blue"> │ </Text>
          <Text color="yellow">{row.value}</Text>
          <Text color="blue"> │</Text>
        </Text>
      )
    }
    return (
      <Text key={row.key}>
        <Text color="blue">│ </Text>
        <Text color="cyan">{row.field}</Text>
        <Text color="blue"> │ </Text>
        <Text color="white">{row.value}</Text>
        <Text color="blue"> │</Text>
      </Text>
    )
  }

  const renderRightTopHeader = (): React.JSX.Element | null => {
    if (!rightTopTable) return null
    return (
      <>
        <Text color="yellow">{`${rightTopHeaderPrefix}${rightTopCenteredHeaderLine}`}</Text>
        <Text color="blue">{`${rightTopHeaderPrefix}${rightTopTable.separatorLine}`}</Text>
      </>
    )
  }

  const renderRightTopPaneContent = (): React.JSX.Element => {
    if (inviteComposeState) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">Send Invite</Text>
          <Text dimColor>{`Target: ${inviteComposeState.target.name} (${inviteComposeState.target.kind})`}</Text>
          <Text dimColor>{'Enter a pubkey or select a suggestion, then press Enter to send.'}</Text>
          <Text>{''}</Text>
          <Text>
            <Text color="cyan">{'Invitee: '}</Text>
            <Text color="white">{inviteComposeState.query || '-'}</Text>
          </Text>
          <Text>
            <Text dimColor>{`Status: ${inviteComposeState.status || 'idle'}`}</Text>
          </Text>
          <Text>{''}</Text>
          {inviteComposeState.suggestions.length === 0
            ? <Text dimColor>{inviteComposeState.query ? 'No suggestions' : 'Suggestions appear as you type'}</Text>
            : inviteComposeState.suggestions.map((entry, index) => {
              const selected = index === inviteComposeState.suggestionIndex
              return (
                <Text key={`invite-suggestion:${entry.pubkey}:${index}`} color={selected ? 'green' : undefined}>
                  {selected ? '>' : ' '} {entry.name ? `${entry.name} ` : ''}{shortId(entry.pubkey, 16)}{entry.nip05 ? ` · ${entry.nip05}` : ''}
                </Text>
              )
            })}
        </Box>
      )
    }

    if (isCreateNodeId(selectedNode)) {
      return (
        <CreateFormAdapter
          node={selectedNode}
          isFocused={focusPane === 'right-top'}
          rows={createRows}
          selectedIndex={selectedCreateCursor}
          editState={createEditState && createEditState.node === selectedNode ? createEditState : null}
          groupGatewayOptions={createGatewayOptions}
          chatRelayOptions={createChatRelayOptions}
        />
      )
    }

    return (
      <>
        {renderRightTopHeader()}
        {rightTopRows.length === 0
          ? <Text dimColor>{rightTopTable ? `${rightTopHeaderPrefix}No items` : 'No items'}</Text>
          : null}
        {visibleRightTopRows.map((row, idx) => {
          const absolute = selectedNodeViewport.offset + idx
          return renderRightTopRow(row, absolute)
        })}
      </>
    )
  }

  const keysLabel =
    'Keys: `:` command, right-top `Enter` expand/execute, create/invite edit `Enter` save/send and `Esc` cancel, `y` copy value, `Y` copy command, `Tab/Shift+Tab` pane focus, tree `←/→`, list `↑/↓`, right-bottom join-requests `↑/↓` + `Enter` review, `Ctrl+U/Ctrl+D` scroll, `r` refresh, `q` quit'
  const selectedNodeDisplay = displayNodeId(selectedNode)

  const commandStatusLabel = state.lastError
    ? `Error: ${state.lastError}`
    : state.busyTask
      ? `Working: ${state.busyTask}`
      : `Ready · node:${selectedNodeDisplay} · focus:${focusPane}`

  return (
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      {narrowLayout ? (
        <Box flexDirection="column" height={frameRows.mainRows}>
          <Box borderStyle="round" borderColor={focusPane === 'left-tree' ? 'green' : 'cyan'} paddingX={1} height={navBoxRows} overflow="hidden">
            <Box flexDirection="column">
              <TruncText color="cyan">Hypertuna TUI</TruncText>
              <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
              <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'} · worker: {state.lifecycle}</TruncText>
              <Box marginTop={1} flexDirection="column">
                {navRows.map((row, index) => {
                  const isSelected = row.id === selectedNode
                  const indent = row.depth > 0 ? '  ' : ''
                  const prefix = row.isParent
                    ? row.expanded ? '▾' : '▸'
                    : '•'
                  return (
                    <TruncText key={`${row.id}-${index}`} color={isSelected ? 'green' : undefined}>
                      {isSelected ? '>' : ' '} {indent}{prefix} {row.label}
                    </TruncText>
                  )
                })}
              </Box>
            </Box>
          </Box>

          <Box borderStyle="round" borderColor={focusPane === 'right-top' ? 'green' : 'magenta'} paddingX={1} height={rightTopBoxRows} overflow="hidden">
            <Box flexDirection="column">
              {renderRightTopPaneContent()}
            </Box>
          </Box>

          <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={rightBottomBoxRows} overflow="hidden">
            <Box flexDirection="column">
              {visibleRightRows.map((row) => renderDetailRow(row))}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box height={frameRows.mainRows}>
          <Box width={navPaneWidth} flexDirection="column" borderStyle="round" borderColor={focusPane === 'left-tree' ? 'green' : 'cyan'} paddingX={1} overflow="hidden">
            <TruncText color="cyan">Hypertuna TUI</TruncText>
            <TruncText dimColor>account: {state.currentAccountPubkey ? shortId(state.currentAccountPubkey, 8) : 'none'}</TruncText>
            <TruncText dimColor>session: {state.session ? 'unlocked' : 'locked'} · worker: {state.lifecycle}</TruncText>
            <Box marginTop={1} flexDirection="column">
              {navRows.map((row, index) => {
                const isSelected = row.id === selectedNode
                const isCursor = index === navIndex
                const indent = row.depth > 0 ? '  ' : ''
                const prefix = row.isParent
                  ? row.expanded ? '▾' : '▸'
                  : '•'
                return (
                  <TruncText key={`${row.id}-${index}`} color={isSelected ? 'green' : isCursor ? 'yellow' : undefined}>
                    {isSelected ? '>' : ' '} {indent}{prefix} {row.label}
                  </TruncText>
                )
              })}
            </Box>
          </Box>

          <Box width={rightPaneWidth} overflow="hidden" flexDirection="column">
            <Box borderStyle="round" borderColor={focusPane === 'right-top' ? 'green' : 'magenta'} paddingX={1} height={rightTopBoxRows} overflow="hidden">
              <Box flexDirection="column">
                {renderRightTopPaneContent()}
              </Box>
            </Box>

            <Box borderStyle="round" borderColor={focusPane === 'right-bottom' ? 'green' : 'magenta'} paddingX={1} height={rightBottomBoxRows} overflow="hidden">
              <Box flexDirection="column">
                {visibleRightRows.map((row) => renderDetailRow(row))}
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      <Box borderStyle="round" borderColor="gray" paddingX={1} height={frameRows.commandRows} overflow="hidden">
        {commandInputOpen ? (
          <Box>
            <TruncText color="yellow">:</TruncText>
            <TextInput
              value={commandInput}
              onChange={setCommandInput}
              onSubmit={runCommand}
              placeholder="command"
            />
          </Box>
        ) : (
          <Box>
            <TruncText color="yellow">Command</TruncText>
            <TruncText>: {shortText(commandMessage, Math.max(30, stdoutWidth - 24))}</TruncText>
          </Box>
        )}
      </Box>

      <Box height={frameRows.keysRows} overflow="hidden">
        <TruncText dimColor>{shortText(keysLabel, Math.max(32, stdoutWidth - 2))}</TruncText>
      </Box>

      <Box height={frameRows.statusRows} overflow="hidden">
        {state.busyTask && !options.noAnimations ? <Spinner type="dots" /> : null}
        <TruncText color={state.lastError ? 'red' : state.busyTask ? 'cyan' : 'gray'}>
          {shortText(commandStatusLabel, Math.max(30, stdoutWidth - 2))}
        </TruncText>
      </Box>
    </Box>
  )
}
