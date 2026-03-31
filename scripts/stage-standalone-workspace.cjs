const { cpSync, mkdirSync, rmSync } = require('node:fs')
const path = require('node:path')

const [sourceArg, targetArg] = process.argv.slice(2)

if (!sourceArg || !targetArg) {
  throw new Error('Usage: node ./scripts/stage-standalone-workspace.cjs <source-dir> <target-dir>')
}

const sourceRoot = path.resolve(process.cwd(), sourceArg)
const targetRoot = path.resolve(process.cwd(), targetArg)

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
  )
}

rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(path.dirname(targetRoot), { recursive: true })
cpSync(sourceRoot, targetRoot, {
  recursive: true,
  filter: (source) => shouldInclude(path.relative(sourceRoot, source))
})

process.stdout.write(`${JSON.stringify({ success: true, sourceRoot, targetRoot }, null, 2)}\n`)
