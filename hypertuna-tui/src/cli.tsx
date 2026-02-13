#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import type { LogLevel, } from './domain/types.js'

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = String(value || 'info').trim().toLowerCase()
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized
  }
  return 'info'
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    'storage-dir': {
      type: 'string'
    },
    profile: {
      type: 'string'
    },
    'no-animations': {
      type: 'boolean',
      default: false
    },
    'log-level': {
      type: 'string'
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false
    }
  },
  allowPositionals: false
})

if (parsed.values.help) {
  const lines = [
    'hypertuna-tui',
    '',
    'Usage:',
    '  hypertuna-tui',
    '  hypertuna-tui --storage-dir <path>',
    '  hypertuna-tui --profile <pubkey>',
    '  hypertuna-tui --no-animations',
    '  hypertuna-tui --log-level <debug|info|warn|error>'
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(0)
}

const cwd = process.cwd()
const storageDir = parsed.values['storage-dir']
  ? path.resolve(cwd, parsed.values['storage-dir'])
  : path.resolve(cwd, '.tui-data')

const app = render(
  React.createElement(App, {
    options: {
      cwd,
      storageDir,
      profile: parsed.values.profile,
      noAnimations: Boolean(parsed.values['no-animations']),
      logLevel: parseLogLevel(parsed.values['log-level'])
    }
  }),
  {
    patchConsole: true,
    exitOnCtrlC: false
  }
)

let shuttingDown = false

function shutdown(exitCode = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    app.unmount()
  } catch {
    // best effort
  }
  setTimeout(() => {
    process.exit(exitCode)
  }, 400).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

process.on('unhandledRejection', (error) => {
  process.stderr.write(`Unhandled rejection: ${String(error)}\n`)
  shutdown(1)
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${String(error)}\n`)
  shutdown(1)
})
