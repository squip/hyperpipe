import { describe, expect, it } from 'vitest'
import { executeCommand } from '../src/ui/commandRouter.js'
import { buildCommandHelpSummary, buildCommandReferenceLines } from '../src/ui/commandCatalog.js'
import type { RuntimeOptions } from '../src/domain/controller.js'
import { MockController } from './e2e/support/mockController.js'

const BASE_OPTIONS: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hypertuna-tui-command-catalog',
  noAnimations: true,
  logLevel: 'info'
}

describe('command catalog', () => {
  it('builds stable compact help summary', () => {
    const summary = buildCommandHelpSummary()
    expect(summary.startsWith('Commands: ')).toBe(true)
    expect(summary).toContain('relay tab/refresh')
    expect(summary).toContain('chat tab/init/refresh')
    expect(summary).toContain('perf overlay/snapshot')
  })

  it('builds full reference lines for dashboard read-only command docs', () => {
    const lines = buildCommandReferenceLines()
    expect(lines[0]).toBe('Supported CLI commands')
    expect(lines.some((line) => line.includes('General'))).toBe(true)
    expect(lines.some((line) => line.includes('relay refresh'))).toBe(true)
    expect(lines.some((line) => line.includes('chat create'))).toBe(true)
    expect(lines.some((line) => line.includes('perf snapshot'))).toBe(true)
  })

  it('uses shared command summary for :help command output', async () => {
    const controller = MockController.withSeedData(BASE_OPTIONS)
    const result = await executeCommand(controller, 'help')
    expect(result.message).toBe(buildCommandHelpSummary())
  })
})
