const { builtinModules } = require('node:module')
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const stageRoot = path.join(projectRoot, '.release-runtime')
const stageNodeModulesRoot = path.join(stageRoot, 'node_modules')

const ENTRY_PACKAGES = [
  '@squip/hyperpipe-core',
  '@squip/hyperpipe-bridge',
  '@squip/hyperpipe-core-host'
]

const copiedPackages = new Map()

function isBuiltinPackage(packageName) {
  if (!packageName) return false
  if (packageName.startsWith('node:')) return true
  return builtinModules.includes(packageName)
    || builtinModules.includes(packageName.replace(/^node:/, ''))
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function findPackageRootFromResolvedEntry(resolvedEntry, packageName) {
  let current = path.dirname(resolvedEntry)
  while (current && current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = readJson(packageJsonPath)
        if (packageJson?.name === packageName) {
          return current
        }
      } catch (_) {
        // Keep walking upward.
      }
    }
    current = path.dirname(current)
  }
  return null
}

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

function shouldCopyPath(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'package-lock.json'
  )
}

function copyPackageTree(sourceRoot, targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(path.dirname(targetRoot), { recursive: true })
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => shouldCopyPath(path.relative(sourceRoot, source))
  })
}

function resolveInstalledPackageRoot(packageName, parentRoot = projectRoot) {
  const searchPaths = [
    parentRoot,
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
      try {
        const entryPath = require.resolve(packageName, { paths: [base] })
        const packageRoot = findPackageRootFromResolvedEntry(entryPath, packageName)
        if (packageRoot) {
          return packageRoot
        }
      } catch (_) {
        // Continue searching.
      }
    }
  }

  if (packageName === '@squip/hyperpipe-core') {
    return resolvePackageRoot(packageName, '../hyperpipe-core')
  }
  if (packageName === '@squip/hyperpipe-core-host') {
    return resolvePackageRoot(packageName, '../hyperpipe-core-host')
  }
  if (packageName === '@squip/hyperpipe-bridge') {
    return resolvePackageRoot(packageName, '../hyperpipe-bridge')
  }

  throw new Error(`Unable to resolve installed package root for ${packageName}`)
}

function stagePackageTree(packageName, parentRoot = projectRoot) {
  if (isBuiltinPackage(packageName) || copiedPackages.has(packageName)) {
    return
  }

  const sourceRoot = resolveInstalledPackageRoot(packageName, parentRoot)
  if (!existsSync(sourceRoot)) {
    throw new Error(`Unable to resolve ${packageName} from ${projectRoot}`)
  }

  const targetRoot = path.join(stageNodeModulesRoot, ...packageName.split('/'))
  copyPackageTree(sourceRoot, targetRoot)
  copiedPackages.set(packageName, targetRoot)

  const packageJson = readJson(path.join(sourceRoot, 'package.json'))
  const dependencyMap = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.optionalDependencies || {})
  }

  for (const dependencyName of Object.keys(dependencyMap)) {
    stagePackageTree(dependencyName, sourceRoot)
  }
}

function main() {
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageNodeModulesRoot, { recursive: true })

  for (const packageName of ENTRY_PACKAGES) {
    stagePackageTree(packageName)
  }

  const manifestPath = path.join(stageRoot, 'manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        packages: Array.from(copiedPackages.keys()).sort()
      },
      null,
      2
    ),
    'utf8'
  )

  process.stdout.write(
    `${JSON.stringify({ success: true, stageRoot, packages: Array.from(copiedPackages.keys()).sort() }, null, 2)}\n`
  )
}

main()
