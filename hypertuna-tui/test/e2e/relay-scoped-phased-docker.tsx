import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

type PhaseId = 1 | 2 | 3 | 4 | 5 | 6
type PhaseStatus = 'PASS' | 'FAIL' | 'SKIP'

type MarkerCounts = Record<string, number>

type ScenarioRun = {
  label: string
  baseDir: string
  command: string
  args: string[]
  startedAt: string
  endedAt: string
  elapsedMs: number
  exitCode: number
  stdoutFile: string
  stderrFile: string
  summaryFile: string
  markerCounts: MarkerCounts
  missingRequiredMarkers: string[]
  error?: string | null
  summary?: Record<string, unknown> | null
}

type PhaseCheck = {
  name: string
  ok: boolean
  detail: string
}

type PhaseResult = {
  phase: PhaseId
  name: string
  status: PhaseStatus
  startedAt: string
  endedAt: string
  elapsedMs: number
  reason: string
  checks: PhaseCheck[]
  runs: ScenarioRun[]
  summaryFile: string
}

type BaselineMarkerReport = {
  path: string
  exists: boolean
  markerCounts: MarkerCounts
}

type BaselineAnalysis = {
  baselineLogs: string[]
  markerCatalog: string[]
  requiredMarkers: string[]
  reports: BaselineMarkerReport[]
}

const MARKER_CATALOG = [
  'Start join flow input',
  'Start join flow resolved',
  'JOIN_PATH_SELECTED',
  'Open join bootstrap start',
  'Mirror metadata request',
  'gatewayMode'
]

const DEFAULT_BASELINE_LOGS = [
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/closed-join-local-worker-gateway-mode-auto-both-online.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/closed-join-local-worker-gateway-mode-auto-host-offline.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/open-join-local-worker-gateway-mode-auto-both-online.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test17/open-join-local-worker-gateway-mode-auto-host-offline.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test18/closed-join-gatewayMode-auto-gateway-offline-PASS/local-worker.log',
  '/Users/essorensen/hypertuna-electron/test-logs/TUI-direct-join/test18/open-join-gatewayMode-auto-gateway-offline-PASS/local-worker.log'
]

function nowIso(): string {
  return new Date().toISOString()
}

function logProgress(message: string): void {
  process.stdout.write(`[phase-runner] ${nowIso()} ${message}\n`)
}

async function appendLine(file: string, line: string): Promise<void> {
  await fs.appendFile(file, `${line}\n`, 'utf8')
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function parsePhaseList(value: string | undefined): PhaseId[] {
  const parsed = String(value || '2')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 6)
  return Array.from(new Set(parsed)) as PhaseId[]
}

function normalizeHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while (index <= haystack.length) {
    const next = haystack.indexOf(needle, index)
    if (next === -1) break
    count += 1
    index = next + needle.length
  }
  return count
}

function createEmptyCounts(): MarkerCounts {
  const counts: MarkerCounts = {}
  for (const marker of MARKER_CATALOG) counts[marker] = 0
  return counts
}

async function countMarkersInFiles(files: string[]): Promise<MarkerCounts> {
  const aggregate = createEmptyCounts()
  for (const file of files) {
    if (!(await fileExists(file))) continue
    const content = await fs.readFile(file, 'utf8')
    for (const marker of MARKER_CATALOG) {
      aggregate[marker] += countOccurrences(content, marker)
    }
  }
  return aggregate
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  if (!(await fileExists(filePath))) return null
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function getNestedObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const entry = (value as Record<string, unknown>)[key]
  if (entry && typeof entry === 'object') return entry as Record<string, unknown>
  return null
}

function getNestedString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'string' ? entry : null
}

function getNestedBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== 'object') return null
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'boolean' ? entry : null
}

function getNestedStringArray(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object') return []
  const entry = (value as Record<string, unknown>)[key]
  if (!Array.isArray(entry)) return []
  return entry.filter((item) => typeof item === 'string') as string[]
}

function extractScenarioLogFiles(summary: Record<string, unknown> | null): string[] {
  if (!summary) return []
  const files = new Set<string>()
  const pushIfString = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) files.add(value.trim())
  }

  pushIfString(summary.hostLogFile)
  pushIfString(summary.joinerLogFile)
  pushIfString(summary.timelineLogFile)

  const nestedFiles = getNestedObject(summary, 'files')
  if (nestedFiles) {
    pushIfString(nestedFiles.hostWorkerLog)
    pushIfString(nestedFiles.joinerWorkerLog)
    pushIfString(nestedFiles.timelineLog)
  }

  return Array.from(files)
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdoutFile: string
    stderrFile: string
    timeoutMs: number
  }
): Promise<{ exitCode: number; elapsedMs: number; error?: string }> {
  const startedAt = Date.now()
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, Math.max(30_000, options.timeoutMs))

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stdout.write(text)
      void fs.appendFile(options.stdoutFile, text, 'utf8').catch(() => {})
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      process.stderr.write(text)
      void fs.appendFile(options.stderrFile, text, 'utf8').catch(() => {})
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: 1,
        elapsedMs: Date.now() - startedAt,
        error: error.message || String(error)
      })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const exitCode = Number.isInteger(code) ? Number(code) : 1
      if (signal) {
        resolve({
          exitCode: 1,
          elapsedMs: Date.now() - startedAt,
          error: `terminated by signal ${signal}`
        })
        return
      }
      resolve({
        exitCode,
        elapsedMs: Date.now() - startedAt,
        error: exitCode === 0 ? undefined : `process exited with code ${exitCode}`
      })
    })
  })
}

async function analyzeBaselines(paths: string[]): Promise<BaselineAnalysis> {
  const reports: BaselineMarkerReport[] = []
  for (const baselinePath of paths) {
    const exists = await fileExists(baselinePath)
    const markerCounts = exists ? await countMarkersInFiles([baselinePath]) : createEmptyCounts()
    reports.push({
      path: baselinePath,
      exists,
      markerCounts
    })
  }

  const existingReports = reports.filter((report) => report.exists)
  const threshold = Math.max(1, existingReports.length)
  const requiredMarkers = MARKER_CATALOG.filter((marker) => {
    const presentIn = existingReports.filter((report) => (report.markerCounts[marker] || 0) > 0).length
    return presentIn >= threshold
  })

  return {
    baselineLogs: paths,
    markerCatalog: MARKER_CATALOG,
    requiredMarkers,
    reports
  }
}

async function runClosedGatewayScenario(options: {
  tuiRoot: string
  phaseDir: string
  label: string
  logLevel: string
  gatewayPort: number
  keepDocker: boolean
  timeoutMs: number
  requiredMarkers: string[]
  timelineFile: string
}): Promise<ScenarioRun> {
  const scenarioDir = path.join(options.phaseDir, options.label)
  await fs.mkdir(scenarioDir, { recursive: true })
  const stdoutFile = path.join(scenarioDir, 'runner.stdout.log')
  const stderrFile = path.join(scenarioDir, 'runner.stderr.log')
  const summaryFile = path.join(scenarioDir, 'summary.json')
  const startedAt = nowIso()

  const args = [
    'run',
    'demo:e2e:real:closed-gateway-inheritance-docker',
    '--',
    '--base-dir',
    scenarioDir,
    '--gateway-port',
    String(options.gatewayPort),
    '--log-level',
    options.logLevel,
    '--routing-only',
    'true'
  ]
  if (options.keepDocker) {
    args.push('--keep-docker', 'true')
  }

  await appendLine(options.timelineFile, `[${startedAt}] [run-start] ${options.label} npm ${args.join(' ')}`)
  const startedMs = Date.now()
  const commandResult = await runCommand('npm', args, {
    cwd: options.tuiRoot,
    stdoutFile,
    stderrFile,
    timeoutMs: options.timeoutMs
  })
  const endedAt = nowIso()
  await appendLine(
    options.timelineFile,
    `[${endedAt}] [run-end] ${options.label} exit=${commandResult.exitCode} elapsedMs=${commandResult.elapsedMs}`
  )

  const summary = await readJsonObject(summaryFile)
  const logFiles = extractScenarioLogFiles(summary)
  const markerCounts = await countMarkersInFiles(logFiles)
  const missingRequiredMarkers = options.requiredMarkers.filter((marker) => (markerCounts[marker] || 0) === 0)

  return {
    label: options.label,
    baseDir: scenarioDir,
    command: 'npm',
    args,
    startedAt,
    endedAt,
    elapsedMs: Date.now() - startedMs,
    exitCode: commandResult.exitCode,
    stdoutFile,
    stderrFile,
    summaryFile,
    markerCounts,
    missingRequiredMarkers,
    error: commandResult.error || null,
    summary
  }
}

function isResultOk(summary: Record<string, unknown> | null): boolean {
  if (!summary) return false
  const result = getNestedObject(summary, 'result')
  return getNestedBoolean(result, 'ok') === true
}

function getScenarioOrigin(summary: Record<string, unknown> | null): string | null {
  if (!summary) return null
  return normalizeHttpOrigin(getNestedString(summary, 'gatewayOrigin'))
}

function getScenarioGatewayCallOrigins(summary: Record<string, unknown> | null): string[] {
  if (!summary) return []
  const telemetry = getNestedObject(summary, 'telemetry')
  return getNestedStringArray(telemetry, 'gatewayCallOrigins')
    .map((origin) => normalizeHttpOrigin(origin))
    .filter((origin): origin is string => Boolean(origin))
}

async function executePhase2(options: {
  tuiRoot: string
  runRoot: string
  logLevel: string
  keepDocker: boolean
  timeoutMs: number
  baseline: BaselineAnalysis
  timelineFile: string
}): Promise<PhaseResult> {
  const phase: PhaseId = 2
  const name = 'Routing Correctness'
  const startedAt = nowIso()
  const startedMs = Date.now()
  const phaseDir = path.join(options.runRoot, 'phase-2-routing-correctness')
  await fs.mkdir(phaseDir, { recursive: true })

  const runA = await runClosedGatewayScenario({
    tuiRoot: options.tuiRoot,
    phaseDir,
    label: 'group-a-gateway-1',
    logLevel: options.logLevel,
    gatewayPort: 4430,
    keepDocker: options.keepDocker,
    timeoutMs: options.timeoutMs,
    requiredMarkers: options.baseline.requiredMarkers,
    timelineFile: options.timelineFile
  })

  const runB = await runClosedGatewayScenario({
    tuiRoot: options.tuiRoot,
    phaseDir,
    label: 'group-b-gateway-2',
    logLevel: options.logLevel,
    gatewayPort: 4431,
    keepDocker: options.keepDocker,
    timeoutMs: options.timeoutMs,
    requiredMarkers: options.baseline.requiredMarkers,
    timelineFile: options.timelineFile
  })

  const runs = [runA, runB]
  const checks: PhaseCheck[] = []

  const runAOk = runA.exitCode === 0 && isResultOk(runA.summary || null)
  const runBOk = runB.exitCode === 0 && isResultOk(runB.summary || null)
  checks.push({
    name: 'scenario-a-pass',
    ok: runAOk,
    detail: runAOk ? 'Group A scenario passed' : `Scenario A failed (exit=${runA.exitCode})`
  })
  checks.push({
    name: 'scenario-b-pass',
    ok: runBOk,
    detail: runBOk ? 'Group B scenario passed' : `Scenario B failed (exit=${runB.exitCode})`
  })

  const originA = getScenarioOrigin(runA.summary || null)
  const originB = getScenarioOrigin(runB.summary || null)
  const distinctOrigins = Boolean(originA && originB && originA !== originB)
  checks.push({
    name: 'distinct-gateway-origins',
    ok: distinctOrigins,
    detail: `originA=${originA || 'null'} originB=${originB || 'null'}`
  })

  const callOriginsA = getScenarioGatewayCallOrigins(runA.summary || null)
  const callOriginsB = getScenarioGatewayCallOrigins(runB.summary || null)
  const callOriginsAValid = callOriginsA.every((entry) => entry === originA)
  const callOriginsBValid = callOriginsB.every((entry) => entry === originB)
  checks.push({
    name: 'route-origin-isolation-a',
    ok: callOriginsAValid,
    detail: callOriginsA.length
      ? `observed=${callOriginsA.join(',')}`
      : 'no gateway call origins captured in telemetry'
  })
  checks.push({
    name: 'route-origin-isolation-b',
    ok: callOriginsBValid,
    detail: callOriginsB.length
      ? `observed=${callOriginsB.join(',')}`
      : 'no gateway call origins captured in telemetry'
  })

  const missingRequiredA = runA.missingRequiredMarkers
  const missingRequiredB = runB.missingRequiredMarkers
  checks.push({
    name: 'baseline-required-markers-a',
    ok: missingRequiredA.length === 0,
    detail: missingRequiredA.length
      ? `missing=${missingRequiredA.join(', ')}`
      : 'all required markers found'
  })
  checks.push({
    name: 'baseline-required-markers-b',
    ok: missingRequiredB.length === 0,
    detail: missingRequiredB.length
      ? `missing=${missingRequiredB.join(', ')}`
      : 'all required markers found'
  })

  const criticalCheckNames = new Set([
    'scenario-a-pass',
    'scenario-b-pass',
    'distinct-gateway-origins'
  ])
  const status: PhaseStatus = checks
    .filter((check) => criticalCheckNames.has(check.name))
    .every((check) => check.ok)
    ? 'PASS'
    : 'FAIL'
  const reason = status === 'PASS'
    ? 'phase-2-routing-isolation-pass'
    : 'phase-2-routing-isolation-fail'

  const endedAt = nowIso()
  const phaseResult: PhaseResult = {
    phase,
    name,
    status,
    startedAt,
    endedAt,
    elapsedMs: Date.now() - startedMs,
    reason,
    checks,
    runs,
    summaryFile: path.join(phaseDir, 'phase-summary.json')
  }

  await fs.writeFile(phaseResult.summaryFile, `${JSON.stringify(phaseResult, null, 2)}\n`, 'utf8')
  return phaseResult
}

function makeSkippedPhase(options: {
  phase: PhaseId
  name: string
  reason: string
  runRoot: string
}): PhaseResult {
  const startedAt = nowIso()
  const endedAt = nowIso()
  const summaryFile = path.join(options.runRoot, `phase-${options.phase}-skipped-summary.json`)
  return {
    phase: options.phase,
    name: options.name,
    status: 'SKIP',
    startedAt,
    endedAt,
    elapsedMs: 0,
    reason: options.reason,
    checks: [{
      name: 'phase-skip',
      ok: true,
      detail: options.reason
    }],
    runs: [],
    summaryFile
  }
}

async function writeSkippedSummary(result: PhaseResult): Promise<void> {
  await fs.writeFile(result.summaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const tuiRoot = path.resolve(__dirname, '../..')
  const repoRoot = path.resolve(tuiRoot, '..')

  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      'base-dir': { type: 'string' },
      phases: { type: 'string' },
      'log-level': { type: 'string' },
      'keep-docker': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'skip-baseline': { type: 'string' },
      'baseline-log': { type: 'string', multiple: true }
    }
  })

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const runRoot = parsed.values['base-dir']
    ? path.resolve(process.cwd(), parsed.values['base-dir'])
    : path.join(repoRoot, 'test-logs/relay-scoped-phased-docker', `run-${runId}`)
  await fs.mkdir(runRoot, { recursive: true })

  const selectedPhases = parsePhaseList(parsed.values.phases)
  if (!selectedPhases.length) {
    throw new Error('No valid phases selected. Use --phases 1,2,3,4,5,6')
  }

  const keepDocker = String(parsed.values['keep-docker'] || 'false').trim().toLowerCase() === 'true'
  const logLevel = String(parsed.values['log-level'] || 'info').trim().toLowerCase()
  const timeoutMsRaw = Number.parseInt(String(parsed.values['timeout-ms'] || '1200000'), 10)
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(120_000, timeoutMsRaw) : 1_200_000
  const skipBaseline = String(parsed.values['skip-baseline'] || 'false').trim().toLowerCase() === 'true'
  const baselineLogs = parsed.values['baseline-log']?.length
    ? parsed.values['baseline-log'].map((entry) => path.resolve(process.cwd(), entry))
    : DEFAULT_BASELINE_LOGS

  const timelineFile = path.join(runRoot, 'timeline.log')
  const startedAt = nowIso()
  await appendLine(timelineFile, `[${startedAt}] [start] selectedPhases=${selectedPhases.join(',')}`)
  logProgress(`runRoot=${runRoot}`)
  logProgress(`selectedPhases=${selectedPhases.join(',')}`)

  const baseline = skipBaseline
    ? {
      baselineLogs,
      markerCatalog: MARKER_CATALOG,
      requiredMarkers: ['Start join flow input', 'Start join flow resolved'],
      reports: [] as BaselineMarkerReport[]
    }
    : await analyzeBaselines(baselineLogs)

  await fs.writeFile(path.join(runRoot, 'baseline-analysis.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  await appendLine(
    timelineFile,
    `[${nowIso()}] [baseline] requiredMarkers=${baseline.requiredMarkers.join(',') || 'none'}`
  )

  const phaseResults: PhaseResult[] = []
  for (const phase of selectedPhases) {
    if (phase === 2) {
      logProgress('executing phase 2: routing correctness')
      const phaseResult = await executePhase2({
        tuiRoot,
        runRoot,
        logLevel,
        keepDocker,
        timeoutMs,
        baseline,
        timelineFile
      })
      phaseResults.push(phaseResult)
      await appendLine(
        timelineFile,
        `[${nowIso()}] [phase-complete] phase=${phaseResult.phase} status=${phaseResult.status} reason=${phaseResult.reason}`
      )
      continue
    }

    const skipped = makeSkippedPhase({
      phase,
      name: `Phase ${phase}`,
      reason: 'not-implemented-in-this-pass',
      runRoot
    })
    phaseResults.push(skipped)
    await writeSkippedSummary(skipped)
    await appendLine(
      timelineFile,
      `[${nowIso()}] [phase-skipped] phase=${skipped.phase} reason=${skipped.reason}`
    )
  }

  const endedAt = nowIso()
  const anyFail = phaseResults.some((result) => result.status === 'FAIL')
  const summary = {
    generatedAt: endedAt,
    runRoot,
    timelineFile,
    selectedPhases,
    baseline,
    result: {
      ok: !anyFail,
      reason: anyFail ? 'one-or-more-phases-failed' : 'selected-phases-passed'
    },
    phases: phaseResults
  }

  const summaryFile = path.join(runRoot, 'summary.json')
  await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`[output] ${summaryFile}\n`)
  if (anyFail) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
