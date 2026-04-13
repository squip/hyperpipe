const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const [sourceArg, targetArg] = process.argv.slice(2)

if (!sourceArg || !targetArg) {
  throw new Error('Usage: node ./scripts/stage-standalone-workspace.cjs <source-dir> <target-dir>')
}

const sourceRoot = path.resolve(process.cwd(), sourceArg)
const targetRoot = path.resolve(process.cwd(), targetArg)
const workspaceRoot = process.cwd()

const LOCAL_PACKAGES = [
  {
    name: '@squip/hyperpipe-core',
    dir: 'hyperpipe-core'
  },
  {
    name: '@squip/hyperpipe-bridge',
    dir: 'hyperpipe-bridge'
  },
  {
    name: '@squip/hyperpipe-core-host',
    dir: 'hyperpipe-core-host'
  }
]

function shouldInclude(relativePath) {
  if (!relativePath) return true
  const normalized = relativePath.replace(/\\/g, '/')
  return !(
    normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'dist'
    || normalized.startsWith('dist/')
    || normalized === 'release'
    || normalized.startsWith('release/')
    || normalized === '.release-deps'
    || normalized.startsWith('.release-deps/')
    || normalized === '.release-runtime'
    || normalized.startsWith('.release-runtime/')
  )
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function rewriteLocalPackageRefs(packageRoot, packageConfig, relativeBasePath) {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']

  for (const section of sections) {
    const deps = packageConfig[section]
    if (!deps || typeof deps !== 'object') continue

    for (const localPackage of LOCAL_PACKAGES) {
      if (!Object.prototype.hasOwnProperty.call(deps, localPackage.name)) continue
      const targetPath = path.join(relativeBasePath, localPackage.dir).replace(/\\/g, '/')
      deps[localPackage.name] = `file:${targetPath}`
    }
  }

  writeJson(path.join(packageRoot, 'package.json'), packageConfig)
}

rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(path.dirname(targetRoot), { recursive: true })
cpSync(sourceRoot, targetRoot, {
  recursive: true,
  filter: (source) => shouldInclude(path.relative(sourceRoot, source))
})

const localPackagesRoot = path.join(targetRoot, '.local-packages')
mkdirSync(localPackagesRoot, { recursive: true })

for (const localPackage of LOCAL_PACKAGES) {
  const packageSourceRoot = path.join(workspaceRoot, localPackage.dir)
  const packageTargetRoot = path.join(localPackagesRoot, localPackage.dir)

  cpSync(packageSourceRoot, packageTargetRoot, {
    recursive: true,
    filter: (source) => shouldInclude(path.relative(packageSourceRoot, source))
  })

  const packageConfig = readJson(path.join(packageTargetRoot, 'package.json'))
  rewriteLocalPackageRefs(packageTargetRoot, packageConfig, '..')
}

const targetPackageJsonPath = path.join(targetRoot, 'package.json')
const targetPackageJson = readJson(targetPackageJsonPath)

for (const localPackage of LOCAL_PACKAGES) {
  if (targetPackageJson.dependencies?.[localPackage.name]) {
    targetPackageJson.dependencies[localPackage.name] = `file:.local-packages/${localPackage.dir}`
  }
}

writeJson(targetPackageJsonPath, targetPackageJson)

process.stdout.write(`${JSON.stringify({ success: true, sourceRoot, targetRoot }, null, 2)}\n`)
