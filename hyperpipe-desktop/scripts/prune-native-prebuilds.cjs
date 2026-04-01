const { readdirSync, rmSync, statSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const nodeModulesRoot = path.join(projectRoot, 'node_modules')

const platformPrefixes = [
  'android',
  'darwin',
  'freebsd',
  'ios',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
]

function resolveAllowedTargets() {
  const targets = new Set()

  if (process.platform === 'darwin') {
    targets.add(`darwin-${process.arch}`)
    targets.add('darwin-universal')
    targets.add('universal')
    return targets
  }

  targets.add(`${process.platform}-${process.arch}`)
  return targets
}

function isPlatformDirectory(name) {
  return platformPrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))
}

function* walkDirectories(rootDir) {
  const queue = [rootDir]

  while (queue.length > 0) {
    const currentDir = queue.pop()
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const childPath = path.join(currentDir, entry.name)
      yield childPath
      queue.push(childPath)
    }
  }
}

function prunePrebuilds(rootDir) {
  if (!statExists(rootDir)) {
    process.stdout.write(`${JSON.stringify({ success: true, skipped: true, reason: 'node_modules missing' }, null, 2)}\n`)
    return
  }

  const allowedTargets = resolveAllowedTargets()
  let scannedDirs = 0
  let removedDirs = 0

  for (const dirPath of walkDirectories(rootDir)) {
    if (path.basename(dirPath) !== 'prebuilds') continue
    scannedDirs += 1

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!isPlatformDirectory(entry.name)) continue
      if (allowedTargets.has(entry.name)) continue

      rmSync(path.join(dirPath, entry.name), { recursive: true, force: true })
      removedDirs += 1
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        nodeModulesRoot: rootDir,
        scannedDirs,
        removedDirs,
        allowedTargets: Array.from(allowedTargets).sort()
      },
      null,
      2
    )}\n`
  )
}

function statExists(targetPath) {
  try {
    return statSync(targetPath).isDirectory()
  } catch (_) {
    return false
  }
}

prunePrebuilds(nodeModulesRoot)
