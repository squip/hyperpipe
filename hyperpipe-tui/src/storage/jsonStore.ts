import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ZodType } from 'zod'

async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export async function readJsonFile<T>(
  filePath: string,
  schema: ZodType<T, any, any>,
  fallback: () => T
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return schema.parse(parsed)
  } catch {
    const value = fallback()
    await writeJsonFile(filePath, value)
    return value
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await ensureParent(filePath)
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}
