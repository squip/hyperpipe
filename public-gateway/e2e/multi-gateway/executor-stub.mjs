#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const scenarioId = process.env.HT_SCENARIO_ID || 'S00'
const scenarioDir = process.env.HT_SCENARIO_DIR || process.cwd()
const shouldFail = process.env.HT_SCENARIO_STUB_FAIL === '1'
const traceId = `stub-${scenarioId}-${Date.now().toString(16)}`
const now = Date.now()
const autoconnectTraceId = `stub-autoconnect-${scenarioId}-${Date.now().toString(16)}`

const workerA = path.join(scenarioDir, 'workerA.log')
const workerB = path.join(scenarioDir, 'workerB.log')

const events = shouldFail
  ? [
      { eventType: 'JOIN_START', traceId, elapsedMs: 0, timestamp: now },
      { eventType: 'JOIN_WRITER_MATERIAL_APPLIED', traceId, elapsedMs: 50001, timestamp: now + 50001 },
      { eventType: 'JOIN_FAST_FORWARD_APPLIED', traceId, elapsedMs: 40000, timestamp: now + 40000 },
      { eventType: 'JOIN_FAIL_FAST_ABORT', traceId, elapsedMs: 120001, reasonCode: 'join-writable-timeout', timestamp: now + 120001 }
    ]
  : [
      { eventType: 'JOIN_START', traceId, elapsedMs: 0, timestamp: now },
      { eventType: 'JOIN_WRITER_MATERIAL_APPLIED', traceId, elapsedMs: 14000, timestamp: now + 14000 },
      { eventType: 'JOIN_FAST_FORWARD_APPLIED', traceId, elapsedMs: 19000, timestamp: now + 19000 },
      {
        eventType: 'JOIN_WRITABLE_CONFIRMED',
        traceId,
        elapsedMs: 48000,
        writable: true,
        timestamp: now + 48000,
        meta: {
          viewLength: 120,
          expectedViewLength: 120,
          localLength: 120,
          viewLengthMatch: true
        }
      }
    ]

const autoconnectEvents = shouldFail
  ? [
      {
        eventType: 'AUTOCONNECT_START',
        traceId: autoconnectTraceId,
        elapsedMs: 0,
        timestamp: now + 60000,
        meta: {
          hasFastForward: false,
          hasWriterMaterial: true
        }
      },
      {
        eventType: 'AUTOCONNECT_WRITER_MATERIAL_APPLIED',
        traceId: autoconnectTraceId,
        elapsedMs: 47000,
        timestamp: now + 107000
      },
      {
        eventType: 'AUTOCONNECT_FAIL_FAST_ABORT',
        traceId: autoconnectTraceId,
        elapsedMs: 120001,
        reasonCode: 'autoconnect-writable-timeout',
        timestamp: now + 180001
      }
    ]
  : [
      {
        eventType: 'AUTOCONNECT_START',
        traceId: autoconnectTraceId,
        elapsedMs: 0,
        timestamp: now + 60000,
        meta: {
          hasFastForward: false,
          hasWriterMaterial: true
        }
      },
      {
        eventType: 'AUTOCONNECT_WRITER_MATERIAL_APPLIED',
        traceId: autoconnectTraceId,
        elapsedMs: 1000,
        timestamp: now + 61000
      },
      {
        eventType: 'AUTOCONNECT_WRITABLE_CONFIRMED',
        traceId: autoconnectTraceId,
        elapsedMs: 22000,
        writable: true,
        timestamp: now + 82000,
        meta: {
          viewLength: 120,
          expectedViewLength: 120,
          localLength: 120,
          viewLengthMatch: true
        }
      }
    ]

const fanout = {
  type: 'join-fanout-summary',
  data: {
    traceId,
    total: 2,
    successCount: shouldFail ? 0 : 1,
    failedCount: shouldFail ? 2 : 1,
    results: [
      { origin: 'https://gateway1.local', status: shouldFail ? 'error' : 'ok' },
      { origin: 'https://gateway2.local', status: 'error' }
    ]
  }
}

const autoconnectFanout = {
  type: 'autoconnect-fanout-summary',
  data: {
    traceId: autoconnectTraceId,
    total: 2,
    successCount: shouldFail ? 0 : 2,
    failedCount: shouldFail ? 2 : 0,
    results: [
      { origin: 'https://gateway1.local', status: shouldFail ? 'error' : 'ok' },
      { origin: 'https://gateway2.local', status: shouldFail ? 'error' : 'ok' }
    ]
  }
}

const linesA = events.map((event) => JSON.stringify({ type: 'join-telemetry', data: event }))
linesA.push(JSON.stringify(fanout))
linesA.push(...autoconnectEvents.map((event) => JSON.stringify({ type: 'autoconnect-telemetry', data: event })))
linesA.push(JSON.stringify(autoconnectFanout))
await fs.writeFile(workerA, `${linesA.join('\n')}\n`, 'utf8')
await fs.writeFile(workerB, '', 'utf8')

const summary = {
  scenarioId,
  workerLogs: [workerA, workerB],
  observedViewLength: shouldFail ? 0 : 120,
  expectedViewLength: 120,
  autoConnectObservedViewLength: shouldFail ? 0 : 120,
  autoConnectExpectedViewLength: 120
}

process.stdout.write(`HT_SCENARIO_SUMMARY=${JSON.stringify(summary)}\n`)
