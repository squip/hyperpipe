#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import React from 'react'
import { render } from 'ink'
import { StartupApp } from './ui/StartupApp.js'
import type { LogLevel, } from './domain/types.js'
import { resolveDesktopParityStorageDir } from './storage/defaultStorageDir.js'
import {
  closeTuiStdioCapture,
  closeTuiFileLogger,
  initializeTuiStdioCapture,
  initializeTuiFileLogger,
  mirrorConsoleToTuiFileLogger,
  writeTuiFileLog
} from './runtime/tuiFileLogger.js'

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
    'hyperpipe-tui',
    '',
    'Usage:',
    '  hyperpipe-tui',
    '  hyperpipe-tui --storage-dir <path>',
    '  hyperpipe-tui --profile <pubkey>',
    '  hyperpipe-tui --no-animations',
    '  hyperpipe-tui --log-level <debug|info|warn|error>'
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(0)
}

const cwd = process.cwd()
const storageDir = parsed.values['storage-dir']
  ? path.resolve(cwd, parsed.values['storage-dir'])
  : resolveDesktopParityStorageDir(cwd)

const logFilePath = initializeTuiFileLogger()
if (logFilePath) {
  mirrorConsoleToTuiFileLogger()
  writeTuiFileLog('info', 'cli', 'Structured file logging enabled', { path: logFilePath })
}
const stdioCapturePath = initializeTuiStdioCapture()
if (stdioCapturePath) {
  writeTuiFileLog('info', 'cli', 'STDIO capture enabled', { path: stdioCapturePath })
}

const app = render(
  React.createElement(StartupApp, {
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
  writeTuiFileLog('info', 'cli', 'Shutdown requested', { exitCode })
  try {
    app.unmount()
  } catch {
    // best effort
  }
  setTimeout(() => {
    Promise.allSettled([closeTuiFileLogger(), closeTuiStdioCapture()])
      .catch(() => {})
      .finally(() => {
        process.exit(exitCode)
      })
  }, 400).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

process.on('unhandledRejection', (error) => {
  process.stderr.write(`Unhandled rejection: ${String(error)}\n`)
  writeTuiFileLog('error', 'process', 'Unhandled rejection', { error: String(error) })
  shutdown(1)
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${String(error)}\n`)
  writeTuiFileLog('error', 'process', 'Uncaught exception', { error: String(error) })
  shutdown(1)
})
