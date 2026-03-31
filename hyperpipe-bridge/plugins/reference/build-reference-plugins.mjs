import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function main() {
  const currentFile = fileURLToPath(import.meta.url)
  const referenceRoot = path.dirname(currentFile)
  const cliPath = path.join(referenceRoot, '..', 'sdk', 'htplugin-cli.mjs')
  const catalogPath = path.join(referenceRoot, 'catalog.json')
  const distDir = path.join(referenceRoot, 'dist')
  await fs.mkdir(distDir, { recursive: true })

  const catalog = await readJson(catalogPath)
  if (!Array.isArray(catalog) || !catalog.length) {
    throw new Error('Reference plugin catalog is empty')
  }

  const results = []
  for (const entry of catalog) {
    const item = asObject(entry)
    if (!item) continue
    const slug = asString(item.slug)
    const pluginId = asString(item.id)
    if (!slug || !pluginId) continue

    const pluginDir = path.join(referenceRoot, slug)
    const manifestPath = path.join(pluginDir, 'manifest.json')
    const manifest = await readJson(manifestPath)
    const version = asString(manifest?.version) || '0.0.0'
    const outputPath = path.join(distDir, `${pluginId}-${version}.htplugin.tgz`)

    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, 'pack', pluginDir, '--output', outputPath, '--json'],
      {
        cwd: referenceRoot,
        maxBuffer: 8 * 1024 * 1024
      }
    )

    let payload = {}
    try {
      payload = JSON.parse(String(stdout || '{}'))
    } catch (_) {
      payload = {}
    }

    results.push({
      id: pluginId,
      version,
      outputPath,
      archive: asObject(payload.archive) || null
    })
  }

  process.stdout.write(`${JSON.stringify({ success: true, count: results.length, results }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`)
  process.exitCode = 1
})
