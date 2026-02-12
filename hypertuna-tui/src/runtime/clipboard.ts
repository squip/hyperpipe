import { spawn } from 'node:child_process'
import process from 'node:process'

export type ClipboardCopyMethod = 'osc52' | 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'none'

export type ClipboardCopyResult = {
  ok: boolean
  method: ClipboardCopyMethod
  error?: string
}

export type ClipboardRuntime = {
  isTTY: boolean
  writeStdout: (chunk: string) => void
  commandExists: (command: string) => Promise<boolean>
  runWithInput: (command: string, args: string[], input: string) => Promise<void>
}

const OSC52_MAX_BYTES = 100_000

async function defaultCommandExists(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn('which', [command], {
      stdio: 'ignore'
    })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

async function defaultRunWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe']
    })

    let stderr = ''

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    child.once('error', (error) => reject(error))
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${String(code ?? 'unknown')}`))
    })

    child.stdin?.on('error', (error) => reject(error))
    child.stdin?.end(input)
  })
}

function defaultRuntime(): ClipboardRuntime {
  return {
    isTTY: Boolean(process.stdout.isTTY),
    writeStdout: (chunk) => {
      process.stdout.write(chunk)
    },
    commandExists: defaultCommandExists,
    runWithInput: defaultRunWithInput
  }
}

function tryOsc52(text: string, runtime: ClipboardRuntime): ClipboardCopyResult {
  if (!runtime.isTTY) {
    return { ok: false, method: 'none', error: 'stdout is not a TTY' }
  }

  const encoded = Buffer.from(text, 'utf8').toString('base64')
  if (encoded.length > OSC52_MAX_BYTES) {
    return { ok: false, method: 'none', error: `OSC52 payload too large (${encoded.length} bytes)` }
  }

  try {
    runtime.writeStdout(`\u001b]52;c;${encoded}\u0007`)
    return { ok: true, method: 'osc52' }
  } catch (error) {
    return {
      ok: false,
      method: 'none',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function copyWithRuntime(text: string, runtime: ClipboardRuntime): Promise<ClipboardCopyResult> {
  const value = String(text || '')
  if (!value) {
    return { ok: false, method: 'none', error: 'Nothing to copy' }
  }

  const osc52Result = tryOsc52(value, runtime)
  if (osc52Result.ok) return osc52Result

  const runners: Array<{ method: Exclude<ClipboardCopyMethod, 'osc52' | 'none'>; args: string[] }> = [
    { method: 'pbcopy', args: [] },
    { method: 'wl-copy', args: [] },
    { method: 'xclip', args: ['-selection', 'clipboard'] },
    { method: 'xsel', args: ['--clipboard', '--input'] }
  ]

  let lastError = osc52Result.error || 'Clipboard backend unavailable'

  for (const runner of runners) {
    const exists = await runtime.commandExists(runner.method)
    if (!exists) continue
    try {
      await runtime.runWithInput(runner.method, runner.args, value)
      return { ok: true, method: runner.method }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ok: false,
    method: 'none',
    error: lastError
  }
}

export async function copy(text: string): Promise<ClipboardCopyResult> {
  return await copyWithRuntime(text, defaultRuntime())
}
