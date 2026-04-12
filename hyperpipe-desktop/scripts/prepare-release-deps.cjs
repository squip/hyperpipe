const { spawnSync } = require('node:child_process')
const { builtinModules } = require('node:module')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const stageRoot = path.join(projectRoot, '.release-runtime')
const packedPackagesRoot = path.join(stageRoot, '.packages')
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function spawnNpm(args, options = {}) {
  return spawnSync(npmExecutable, args, {
    ...options,
    shell: process.platform === 'win32'
  })
}

const ENTRY_PACKAGES = [
  '@squip/hyperpipe-core',
  '@squip/hyperpipe-bridge',
  '@squip/hyperpipe-core-host'
]

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

function resolveInstalledPackageRoot(packageName, parentRoot = projectRoot) {
  if (isBuiltinPackage(packageName)) {
    return null
  }

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

  throw new Error(`Unable to resolve installed package root for ${packageName}`)
}

function packLocalPackage(sourceRoot) {
  const result = spawnNpm(
    ['pack', '--json', '--pack-destination', packedPackagesRoot],
    {
      cwd: sourceRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env
    }
  )

  if (result.status !== 0) {
    throw new Error(
      `npm pack failed for ${sourceRoot} (exit ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''})`
    )
  }

  let parsed
  try {
    parsed = JSON.parse(String(result.stdout || '[]'))
  } catch (error) {
    throw new Error(`Failed to parse npm pack output for ${sourceRoot}: ${String(result.stdout || '')}`)
  }

  const filename = parsed?.[0]?.filename
  if (!filename) {
    throw new Error(`npm pack did not produce a filename for ${sourceRoot}`)
  }

  return filename
}

function buildStageManifest() {
  const packages = ENTRY_PACKAGES.map((packageName) => {
    const sourceRoot = resolveInstalledPackageRoot(packageName)
    const packageJson = readJson(path.join(sourceRoot, 'package.json'))
    const tarballName = packLocalPackage(sourceRoot)
    return {
      name: packageName,
      version: packageJson.version,
      sourceRoot,
      tarballName,
      overrides: packageJson.overrides || {}
    }
  })

  const dependencies = {}
  const overrides = {}

  for (const pkg of packages) {
    dependencies[pkg.name] = `file:.packages/${pkg.tarballName}`
    Object.assign(overrides, pkg.overrides)
  }

  return {
    packages,
    packageJson: {
      name: 'hyperpipe-desktop-runtime',
      private: true,
      type: 'module',
      dependencies,
      ...(Object.keys(overrides).length ? { overrides } : {})
    }
  }
}

function installRuntimeTree() {
  const result = spawnNpm(
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false'],
    {
      cwd: stageRoot,
      stdio: 'inherit',
      env: process.env
    }
  )

  if (result.status !== 0) {
    throw new Error(
      `npm install failed while preparing desktop runtime (exit ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''})`
    )
  }
}

function main() {
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageRoot, { recursive: true })
  mkdirSync(packedPackagesRoot, { recursive: true })

  const manifest = buildStageManifest()
  writeFileSync(
    path.join(stageRoot, 'package.json'),
    `${JSON.stringify(manifest.packageJson, null, 2)}\n`,
    'utf8'
  )

  installRuntimeTree()

  writeFileSync(
    path.join(stageRoot, 'manifest.json'),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      packages: manifest.packages.map(({ name, version, sourceRoot }) => ({ name, version, sourceRoot }))
    }, null, 2)}\n`,
    'utf8'
  )

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      stageRoot,
      packages: manifest.packages.map(({ name, version }) => ({ name, version }))
    }, null, 2)}\n`
  )
}

main()
