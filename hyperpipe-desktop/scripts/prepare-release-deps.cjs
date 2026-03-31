const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const stageRoot = path.join(projectRoot, '.release-deps', 'node_modules', '@squip')

function resolvePackageRoot(packageName, fallbackRelativePath) {
  const searchPaths = [
    projectRoot,
    path.resolve(projectRoot, '..'),
    path.resolve(projectRoot, '../..'),
    process.cwd()
  ]

  for (const base of searchPaths) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [base] })
      return path.dirname(packageJsonPath)
    } catch (_) {
      // Continue searching.
    }
  }

  return path.resolve(projectRoot, fallbackRelativePath)
}

function shouldIncludeCore(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'data'
    || normalized.startsWith('data/')
    || normalized === 'test'
    || normalized.startsWith('test/')
    || normalized === 'release'
    || normalized.startsWith('release/')
    || normalized === 'package-lock.json'
  )
}

function shouldIncludeCoreHost(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'package-lock.json'
  )
}

function shouldIncludeBridge(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'package-lock.json'
    || normalized === 'plugins/reference'
    || normalized.startsWith('plugins/reference/')
  )
}

function stagePackage(packageName, fallbackRelativePath, filter) {
  const sourceRoot = resolvePackageRoot(packageName, fallbackRelativePath)
  if (!existsSync(sourceRoot)) {
    throw new Error(`Unable to resolve ${packageName} from ${projectRoot}`)
  }

  const targetRoot = path.join(stageRoot, packageName.split('/')[1])
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(path.dirname(targetRoot), { recursive: true })
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(sourceRoot, source)
      return filter(relativePath)
    }
  })
}

function main() {
  rmSync(path.join(projectRoot, '.release-deps'), { recursive: true, force: true })
  stagePackage('@squip/hyperpipe-core', '../hyperpipe-core', shouldIncludeCore)
  stagePackage('@squip/hyperpipe-core-host', '../hyperpipe-core-host', shouldIncludeCoreHost)
  stagePackage('@squip/hyperpipe-bridge', '../hyperpipe-bridge', shouldIncludeBridge)
  process.stdout.write(`${JSON.stringify({ success: true, stageRoot }, null, 2)}\n`)
}

main()
