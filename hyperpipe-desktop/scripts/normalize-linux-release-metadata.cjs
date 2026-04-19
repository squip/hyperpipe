#!/usr/bin/env node

const fs = require('node:fs/promises')
const path = require('node:path')

function usage() {
  return [
    'Usage:',
    '  node ./scripts/normalize-linux-release-metadata.cjs --arch <x64|arm64> [--dir <release-dir>]',
    '',
    'Behavior:',
    '  - x64: keeps latest-linux.yml and also writes latest-linux-x64.yml',
    '  - arm64: verifies latest-linux-arm64.yml is present',
    '  - removes any per-job SHA256SUMS.txt so checksums can be generated once across the full release'
  ].join('\n')
}

function parseArgs(argv) {
  let arch = ''
  let dirPath = path.resolve(__dirname, '..', 'release')

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (token === '--arch') {
      arch = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }
    if (token === '--dir') {
      dirPath = path.resolve(String(argv[index + 1] || '').trim())
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error('Missing or invalid --arch value. Expected x64 or arm64.')
  }

  return { arch, dirPath }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { arch, dirPath } = parseArgs(process.argv.slice(2))
  const genericMetadataPath = path.join(dirPath, 'latest-linux.yml')
  const x64MetadataPath = path.join(dirPath, 'latest-linux-x64.yml')
  const arm64MetadataPath = path.join(dirPath, 'latest-linux-arm64.yml')
  const shaSumsPath = path.join(dirPath, 'SHA256SUMS.txt')

  if (arch === 'x64') {
    if (!(await pathExists(genericMetadataPath))) {
      throw new Error(`Expected Linux updater metadata at ${genericMetadataPath}`)
    }
    const genericMetadataContents = await fs.readFile(genericMetadataPath, 'utf8')
    await fs.writeFile(x64MetadataPath, genericMetadataContents, 'utf8')
  } else if (!(await pathExists(arm64MetadataPath))) {
    throw new Error(`Expected Linux arm64 updater metadata at ${arm64MetadataPath}`)
  }

  await fs.rm(shaSumsPath, { force: true })

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        arch,
        releaseDir: dirPath,
        outputs:
          arch === 'x64' ? ['latest-linux.yml', 'latest-linux-x64.yml'] : ['latest-linux-arm64.yml']
      },
      null,
      2
    )}\n`
  )
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`)
  process.exitCode = 1
})
