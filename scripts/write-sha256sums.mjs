#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

function usage() {
  return [
    'Usage:',
    '  node ./scripts/write-sha256sums.mjs [--out <file>] [--dir <dir>] [file ...]',
    '',
    'Examples:',
    '  node ./scripts/write-sha256sums.mjs --dir ./hyperpipe-desktop/release --out ./hyperpipe-desktop/release/SHA256SUMS.txt',
    '  node ./scripts/write-sha256sums.mjs ./release/app.dmg ./release/app.zip'
  ].join('\n')
}

function parseArgs(argv) {
  const files = []
  let outPath = ''
  let dirPath = ''

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (token === '--out') {
      outPath = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    if (token === '--dir') {
      dirPath = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    files.push(token)
  }

  return { outPath, dirPath, files }
}

async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

async function sha256ForFile(filePath) {
  const hash = createHash('sha256')
  const buffer = await fs.readFile(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

async function main() {
  const { outPath, dirPath, files } = parseArgs(process.argv.slice(2))
  const resolvedDir = dirPath ? path.resolve(dirPath) : ''
  const inputFiles = resolvedDir
    ? await listFiles(resolvedDir)
    : files.map((filePath) => path.resolve(filePath))

  if (!inputFiles.length) {
    throw new Error('No files provided for checksum generation')
  }

  const targetOutPath = outPath
    ? path.resolve(outPath)
    : path.join(resolvedDir || path.dirname(inputFiles[0]), 'SHA256SUMS.txt')

  const lines = []
  for (const filePath of inputFiles) {
    const hash = await sha256ForFile(filePath)
    lines.push(`${hash}  ${path.basename(filePath)}`)
  }

  await fs.mkdir(path.dirname(targetOutPath), { recursive: true })
  await fs.writeFile(targetOutPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ success: true, outPath: targetOutPath, count: lines.length }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`)
  process.exitCode = 1
})
