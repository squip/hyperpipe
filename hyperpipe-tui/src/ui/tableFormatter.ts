export type TableAlign = 'left' | 'right' | 'center'

export type TableColumn = {
  key: string
  label: string
  minWidth: number
  priority: number
  align?: TableAlign
  grow?: number
}

export type TableRowView = Record<string, string | number | boolean | null | undefined>

export type FormattedTable = {
  columns: TableColumn[]
  widths: number[]
  headerLine: string
  separatorLine: string
  rowLines: string[]
}

type FormatTableInput = {
  columns: TableColumn[]
  rows: TableRowView[]
  width: number
  gap?: number
}

const DEFAULT_GAP = 2

function sanitizeCellValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function truncateCell(value: string, width: number): string {
  const safeWidth = Math.max(1, width)
  if (value.length <= safeWidth) return value
  if (safeWidth === 1) return '…'
  return `${value.slice(0, safeWidth - 1)}…`
}

function padCell(value: string, width: number, align: TableAlign): string {
  if (value.length >= width) return value
  if (align === 'right') {
    return value.padStart(width, ' ')
  }
  if (align === 'center') {
    const total = width - value.length
    const left = Math.floor(total / 2)
    const right = total - left
    return `${' '.repeat(left)}${value}${' '.repeat(right)}`
  }
  return value.padEnd(width, ' ')
}

function totalMinWidth(columns: TableColumn[], gap: number): number {
  if (!columns.length) return 0
  const minCols = columns.reduce((acc, col) => acc + Math.max(1, col.minWidth), 0)
  const gaps = (columns.length - 1) * gap
  return minCols + gaps
}

function pickColumns(columns: TableColumn[], width: number, gap: number): TableColumn[] {
  if (!columns.length) return []
  const selected = [...columns]
  while (selected.length > 1 && totalMinWidth(selected, gap) > width) {
    let candidateIndex = -1
    let candidatePriority = -Infinity
    for (let index = 0; index < selected.length; index += 1) {
      const col = selected[index]
      if (col.priority > candidatePriority) {
        candidatePriority = col.priority
        candidateIndex = index
      } else if (col.priority === candidatePriority && index > candidateIndex) {
        candidateIndex = index
      }
    }
    if (candidateIndex <= 0) {
      selected.pop()
    } else {
      selected.splice(candidateIndex, 1)
    }
  }
  return selected
}

function allocateWidths(columns: TableColumn[], rows: TableRowView[], width: number, gap: number): number[] {
  const safeWidth = Math.max(8, width)
  const baseWidths = columns.map((col) => Math.max(1, col.minWidth))
  const gaps = Math.max(0, (columns.length - 1) * gap)
  let remaining = Math.max(0, safeWidth - gaps - baseWidths.reduce((acc, value) => acc + value, 0))

  const desiredWidths = columns.map((col) => {
    const headerWidth = sanitizeCellValue(col.label).length
    const rowWidth = rows.reduce((max, row) => {
      const value = sanitizeCellValue(row[col.key])
      return Math.max(max, value.length)
    }, 0)
    return Math.max(Math.max(1, col.minWidth), headerWidth, rowWidth)
  })

  const widths = [...baseWidths]
  while (remaining > 0) {
    let targetIndex = -1
    let largestDeficit = 0
    for (let index = 0; index < widths.length; index += 1) {
      const deficit = desiredWidths[index] - widths[index]
      if (deficit > largestDeficit) {
        largestDeficit = deficit
        targetIndex = index
      }
    }
    if (targetIndex < 0) break
    widths[targetIndex] += 1
    remaining -= 1
  }

  if (remaining > 0 && widths.length > 0) {
    const weightedColumns = columns
      .map((column, index) => ({
        index,
        weight: Math.max(0, Number.isFinite(Number(column.grow)) ? Number(column.grow) : 1)
      }))
      .filter((entry) => entry.weight > 0)

    if (weightedColumns.length === 0) {
      // If all columns opt out of growth, keep current widths.
      remaining = 0
    } else {
      const totalWeight = weightedColumns.reduce((acc, entry) => acc + entry.weight, 0)
      const additions = widths.map(() => 0)
      let distributed = 0

      weightedColumns.forEach((entry) => {
        const share = Math.floor((remaining * entry.weight) / totalWeight)
        additions[entry.index] = share
        distributed += share
      })

      let leftover = remaining - distributed
      let cursor = 0
      while (leftover > 0) {
        const entry = weightedColumns[cursor % weightedColumns.length]
        additions[entry.index] += 1
        leftover -= 1
        cursor += 1
      }

      additions.forEach((value, index) => {
        widths[index] += value
      })
      remaining = 0
    }
  }

  return widths
}

function joinCells(cells: string[], gap: number): string {
  return cells.join(' '.repeat(Math.max(1, gap)))
}

export function formatTableRows(input: FormatTableInput): FormattedTable {
  const gap = clamp(Number(input.gap || DEFAULT_GAP), 1, 6)
  const availableWidth = Math.max(8, Math.trunc(input.width || 0))
  const columns = pickColumns(input.columns || [], availableWidth, gap)
  if (!columns.length) {
    return {
      columns: [],
      widths: [],
      headerLine: '',
      separatorLine: '',
      rowLines: input.rows.map(() => '')
    }
  }

  const widths = allocateWidths(columns, input.rows || [], availableWidth, gap)
  const headerCells = columns.map((col, index) => {
    const width = widths[index] || 1
    const headerValue = truncateCell(sanitizeCellValue(col.label), width)
    return padCell(headerValue, width, col.align || 'left')
  })
  const separatorCells = widths.map((width) => '─'.repeat(Math.max(1, width)))
  const rowLines = (input.rows || []).map((row) => {
    const cells = columns.map((col, index) => {
      const width = widths[index] || 1
      const align = col.align || 'left'
      const value = truncateCell(sanitizeCellValue(row[col.key]), width)
      return padCell(value, width, align)
    })
    return joinCells(cells, gap)
  })

  return {
    columns,
    widths,
    headerLine: joinCells(headerCells, gap),
    separatorLine: joinCells(separatorCells, gap),
    rowLines
  }
}

export function parseKeyValueLine(line: string): { field: string; value: string } | null {
  const raw = sanitizeCellValue(line)
  if (!raw) return null
  const match = raw.match(/^([A-Za-z0-9][A-Za-z0-9 _./-]{0,40}):\s*(.*)$/)
  if (!match) return null
  const field = sanitizeCellValue(match[1])
  if (!field) return null
  return {
    field,
    value: sanitizeCellValue(match[2])
  }
}

export function shouldUseKeyValueTable(lines: string[]): boolean {
  if (!Array.isArray(lines) || lines.length < 2) return false
  const parsedCount = lines.reduce((acc, line) => acc + (parseKeyValueLine(line) ? 1 : 0), 0)
  if (parsedCount < 2) return false
  return parsedCount / lines.length >= 0.6
}

export function formatKeyValueTableLines(lines: string[], width: number): string[] {
  const parsed = lines.map((line) => parseKeyValueLine(line))
  const rows: TableRowView[] = parsed
    .filter((entry): entry is { field: string; value: string } => Boolean(entry))
    .map((entry) => ({
      field: entry.field,
      value: entry.value
    }))

  const table = formatTableRows({
    columns: [
      { key: 'field', label: 'Field', minWidth: 10, priority: 0 },
      { key: 'value', label: 'Value', minWidth: 16, priority: 1 }
    ],
    rows,
    width
  })

  const remainingLines = parsed
    .map((entry, index) => ({ entry, line: lines[index] }))
    .filter((row) => !row.entry)
    .map((row) => truncateCell(sanitizeCellValue(row.line), Math.max(8, width)))

  if (remainingLines.length === 0) {
    return [table.headerLine, table.separatorLine, ...table.rowLines]
  }

  return [table.headerLine, table.separatorLine, ...table.rowLines, '', ...remainingLines]
}
