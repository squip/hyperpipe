import { describe, expect, it } from 'vitest'
import {
  formatKeyValueTableLines,
  formatTableRows,
  parseKeyValueLine,
  shouldUseKeyValueTable
} from '../src/ui/tableFormatter.js'

describe('tableFormatter', () => {
  it('drops lower-priority columns when width is constrained', () => {
    const table = formatTableRows({
      columns: [
        { key: 'name', label: 'Name', minWidth: 12, priority: 0 },
        { key: 'status', label: 'Status', minWidth: 10, priority: 1 },
        { key: 'members', label: 'Members', minWidth: 10, priority: 3, align: 'right' }
      ],
      rows: [{ name: 'Relay A', status: 'ready', members: 12 }],
      width: 28
    })

    expect(table.columns.map((col) => col.key)).toEqual(['name', 'status'])
    expect(table.headerLine).toContain('Name')
    expect(table.headerLine).toContain('Status')
    expect(table.headerLine).not.toContain('Members')
  })

  it('truncates long values and right-aligns numeric columns', () => {
    const table = formatTableRows({
      columns: [
        { key: 'name', label: 'Name', minWidth: 10, priority: 0 },
        { key: 'size', label: 'Size', minWidth: 6, priority: 0, align: 'right' }
      ],
      rows: [{ name: 'Very Long Relay Name That Exceeds Width', size: '1024B' }],
      width: 24
    })

    expect(table.rowLines[0]).toContain('…')
    expect(table.rowLines[0]).toMatch(/\s1024B$/)
  })

  it('center-aligns members values and headers when configured', () => {
    const table = formatTableRows({
      columns: [{ key: 'members', label: 'Members', minWidth: 9, priority: 0, align: 'center' }],
      rows: [{ members: '12' }],
      width: 9
    })

    expect(table.headerLine).toBe(' Members ')
    expect(table.rowLines[0]).toBe('   12    ')
  })

  it('applies remaining width to columns with grow weight', () => {
    const table = formatTableRows({
      columns: [
        { key: 'date', label: 'Date', minWidth: 16, priority: 0, grow: 0 },
        { key: 'author', label: 'Author', minWidth: 15, priority: 1, grow: 0 },
        { key: 'note', label: 'Note', minWidth: 20, priority: 0, grow: 1 }
      ],
      rows: [
        {
          date: '2026-03-12 20:05',
          author: 'b0f4e20…34c5e5a',
          note: 'hello'
        }
      ],
      width: 80
    })

    expect(table.widths[0]).toBe(16)
    expect(table.widths[1]).toBe(15)
    expect(table.widths[2]).toBeGreaterThan(20)
  })

  it('detects key/value style rows and formats as a two-column table', () => {
    const lines = [
      'id: npub123',
      'name: Relay A',
      'writable: true',
      'readyForReq: false'
    ]

    expect(shouldUseKeyValueTable(lines)).toBe(true)
    const tableLines = formatKeyValueTableLines(lines, 60)
    expect(tableLines[0]).toContain('Field')
    expect(tableLines[0]).toContain('Value')
    expect(tableLines.join('\n')).toContain('readyForReq')
  })

  it('rejects mixed narrative blocks for key/value rendering', () => {
    const lines = [
      'Press Enter to join this relay',
      'relay: Demo',
      'This will publish a join request for admin review.'
    ]

    expect(parseKeyValueLine(lines[0])).toBeNull()
    expect(shouldUseKeyValueTable(lines)).toBe(false)
  })
})
