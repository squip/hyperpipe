#!/usr/bin/env node

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  let runtimeRoot = path.join(projectRoot, '.release-runtime')

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--runtime-root') {
      runtimeRoot = path.resolve(projectRoot, String(argv[index + 1] || '').trim())
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  return { runtimeRoot }
}

function fail(message, details = '') {
  const suffix = details ? `\n${details}` : ''
  process.stderr.write(`${message}${suffix}\n`)
  process.exit(1)
}

async function main() {
  const { runtimeRoot } = parseArgs(process.argv.slice(2))
  const workerEntry = path.join(runtimeRoot, 'node_modules', '@squip', 'hyperpipe-core', 'bin', 'hyperpipe-core.mjs')

  if (!fs.existsSync(workerEntry)) {
    fail(`Worker runtime entry is missing: ${workerEntry}`)
  }

  const electronBinary = require('electron')
  const output = []

  const child = spawn(electronBinary, [workerEntry, '--help'], {
    cwd: path.dirname(workerEntry),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })

  const combinedOutput = output.join('')
  const fatalPatterns = [
    'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'Cannot find module',
    'spawn ENOTDIR',
    'Error [ERR_MODULE_NOT_FOUND]'
  ]

  for (const pattern of fatalPatterns) {
    if (combinedOutput.includes(pattern)) {
      fail(`Worker runtime smoke test failed with fatal output: ${pattern}`, combinedOutput)
    }
  }

  const expectedMarker = 'Missing required parent config (nostr keys). Worker cannot start.'
  if (!combinedOutput.includes(expectedMarker)) {
    fail(
      `Worker runtime smoke test never reached the expected boot marker (exit ${exitCode})`,
      combinedOutput
    )
  }

  process.stdout.write('Worker runtime smoke test passed.\n')
}

main().catch((error) => {
  fail(error?.message || String(error), error?.stack || '')
})
