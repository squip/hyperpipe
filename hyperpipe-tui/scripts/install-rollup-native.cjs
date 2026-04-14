const { spawnSync } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

const nativePackages = {
  darwin: {
    arm64: '@rollup/rollup-darwin-arm64',
    x64: '@rollup/rollup-darwin-x64'
  },
  linux: {
    arm64: '@rollup/rollup-linux-arm64-gnu',
    x64: '@rollup/rollup-linux-x64-gnu'
  },
  win32: {
    arm64: '@rollup/rollup-win32-arm64-msvc',
    x64: '@rollup/rollup-win32-x64-msvc'
  }
}

function resolveRollupVersion() {
  const rollupPackageJson = require.resolve('rollup/package.json', { paths: [projectRoot] })
  return require(rollupPackageJson).version
}

function resolveNativePackage() {
  return nativePackages[process.platform]?.[process.arch] || null
}

function hasNativePackage(packageName) {
  try {
    require.resolve(`${packageName}/package.json`, { paths: [projectRoot] })
    return true
  } catch (_) {
    return false
  }
}

function installNativePackage(packageName, version) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npmCommand, ['install', '--no-save', `${packageName}@${version}`], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(
      `Failed to install ${packageName}@${version} (exit ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''})`
    )
  }
}

function main() {
  const packageName = resolveNativePackage()
  if (!packageName) {
    process.stdout.write(
      `${JSON.stringify({ success: true, skipped: true, reason: `${process.platform}/${process.arch} not mapped` }, null, 2)}\n`
    )
    return
  }

  const rollupVersion = resolveRollupVersion()
  if (!hasNativePackage(packageName)) {
    installNativePackage(packageName, rollupVersion)
  }

  process.stdout.write(`${JSON.stringify({ success: true, packageName, rollupVersion }, null, 2)}\n`)
}

main()
