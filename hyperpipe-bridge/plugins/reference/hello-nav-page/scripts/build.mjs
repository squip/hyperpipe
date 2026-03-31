import { promises as fs } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'runner.mjs')
const distDir = path.join(root, 'dist')
const targetPath = path.join(distDir, 'runner.mjs')

await fs.mkdir(distDir, { recursive: true })
await fs.copyFile(sourcePath, targetPath)
console.log('[reference-plugin] built dist/runner.mjs')
