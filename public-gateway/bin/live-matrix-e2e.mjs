#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import DockerGatewayCluster from '../e2e/harness/DockerGatewayCluster.mjs';
import ScenarioContext from '../e2e/harness/ScenarioContext.mjs';
import WorkerHarness from '../e2e/harness/WorkerHarness.mjs';
import {
  parseBoolean,
  randomHex,
  sanitizeIdentifier,
  writeTextFile
} from '../e2e/harness/utils.mjs';
import {
  SCENARIO_IMPLEMENTATIONS,
  resolveScenarioIds
} from '../e2e/scenarios/index.mjs';

const thisFile = fileURLToPath(import.meta.url);
const gatewayRoot = resolve(dirname(thisFile), '..');
const repoRoot = resolve(gatewayRoot, '..');
const workerRoot = resolve(repoRoot, 'hypertuna-worker');

const DEFAULT_THRESHOLDS = {
  'mirror.read': 2000,
  'auth.challenge_session': 2500,
  'open_join.lease_claim': 5000,
  'closed_join.lease_claim': 5000,
  'join_to_writable.open.p95': 45000,
  'join_to_writable.closed.p95': 60000,
  'key_mismatch_detection': 10000
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    profile: process.env.E2E_PROFILE || 'smoke',
    scenario: [],
    repeat: Number(process.env.E2E_REPEAT || 1),
    keepStack: parseBoolean(process.env.E2E_KEEP_STACK, false),
    transportMode: process.env.E2E_TRANSPORT_MODE || 'http-required',
    stabilityIterations: Number(process.env.E2E_STABILITY_ITERATIONS || 5),
    failureBudget: Number(process.env.E2E_FAILURE_BUDGET || 0),
    outputDir: process.env.E2E_OUTPUT_DIR || null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token === '--profile' && argv[i + 1]) {
      options.profile = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--profile=')) {
      options.profile = token.slice('--profile='.length);
      continue;
    }
    if (token === '--scenario' && argv[i + 1]) {
      options.scenario.push(...String(argv[i + 1]).split(',').map((entry) => entry.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (token.startsWith('--scenario=')) {
      options.scenario.push(...token.slice('--scenario='.length).split(',').map((entry) => entry.trim()).filter(Boolean));
      continue;
    }
    if (token === '--repeat' && argv[i + 1]) {
      options.repeat = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith('--repeat=')) {
      options.repeat = Number(token.slice('--repeat='.length));
      continue;
    }
    if (token === '--keep-stack') {
      options.keepStack = true;
      continue;
    }
    if (token === '--transport-mode' && argv[i + 1]) {
      options.transportMode = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--transport-mode=')) {
      options.transportMode = token.slice('--transport-mode='.length);
      continue;
    }
    if (token === '--stability-iterations' && argv[i + 1]) {
      options.stabilityIterations = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith('--stability-iterations=')) {
      options.stabilityIterations = Number(token.slice('--stability-iterations='.length));
      continue;
    }
    if (token === '--failure-budget' && argv[i + 1]) {
      options.failureBudget = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith('--failure-budget=')) {
      options.failureBudget = Number(token.slice('--failure-budget='.length));
      continue;
    }
    if (token === '--output-dir' && argv[i + 1]) {
      options.outputDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--output-dir=')) {
      options.outputDir = token.slice('--output-dir='.length);
      continue;
    }
  }

  options.repeat = Number.isFinite(options.repeat) && options.repeat > 0 ? Math.round(options.repeat) : 1;
  options.stabilityIterations = Number.isFinite(options.stabilityIterations) && options.stabilityIterations > 0
    ? Math.round(options.stabilityIterations)
    : 5;
  options.failureBudget = Number.isFinite(options.failureBudget) && options.failureBudget >= 0
    ? Math.round(options.failureBudget)
    : 0;

  return options;
}

async function createLogCollector(path) {
  const lines = [];
  const verbose = parseBoolean(process.env.E2E_VERBOSE, false);
  return {
    push(line, { echo = true } = {}) {
      const next = `[${new Date().toISOString()}] ${line}`;
      lines.push(next);
      if (echo && verbose) {
        process.stdout.write(`${next}\n`);
      }
    },
    async flush() {
      await writeTextFile(path, `${lines.join('\n')}\n`);
    }
  };
}

async function main() {
  const options = parseArgs();
  const runId = sanitizeIdentifier(`live-matrix-${Date.now()}-${randomHex(3)}`, `live-matrix-${Date.now()}`);
  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : resolve(repoRoot, 'test-logs', 'live-matrix', runId);

  await fs.mkdir(outputDir, { recursive: true });

  const runnerLog = await createLogCollector(join(outputDir, 'runner.log'));
  const workerALog = await createLogCollector(join(outputDir, 'worker-a.log'));
  const workerBLog = await createLogCollector(join(outputDir, 'worker-b.log'));

  const log = (message, data = null) => {
    const line = data ? `${message} ${JSON.stringify(data)}` : message;
    runnerLog.push(line, { echo: true });
    process.stdout.write(`${line}\n`);
  };

  log('[LiveMatrixE2E] starting', {
    runId,
    profile: options.profile,
    repeat: options.repeat,
    keepStack: options.keepStack,
    transportMode: options.transportMode,
    outputDir
  });

  const cluster = new DockerGatewayCluster({
    repoRoot,
    outputDir,
    projectName: `ht-live-${runId}`,
    logger: log
  });

  let workerCreator = null;
  let workerJoiner = null;
  let summary = null;

  try {
    await cluster.start();

    workerCreator = await WorkerHarness.start({
      label: 'worker-a',
      workerRoot,
      storageDir: join(outputDir, 'workers', 'worker-a'),
      port: 39401,
      gatewayBaseUrl: cluster.gatewayBaseUrl('a'),
      logger: (line) => workerALog.push(line, { echo: false })
    });

    workerJoiner = await WorkerHarness.start({
      label: 'worker-b',
      workerRoot,
      storageDir: join(outputDir, 'workers', 'worker-b'),
      port: 39402,
      gatewayBaseUrl: cluster.gatewayBaseUrl('a'),
      logger: (line) => workerBLog.push(line, { echo: false })
    });

    const gatewayConfig = cluster.workerGatewayConfig({
      transportMode: options.transportMode
    });
    await workerCreator.configurePublicGateway(gatewayConfig);
    await workerJoiner.configurePublicGateway(gatewayConfig);

    const scenarioIds = resolveScenarioIds({
      profile: options.profile,
      scenarioList: options.scenario
    });

    log('[LiveMatrixE2E] scenario plan', {
      scenarioIds,
      count: scenarioIds.length
    });

    const context = new ScenarioContext({
      runId,
      profile: options.profile,
      outputDir,
      logger: log,
      cluster,
      workers: {
        creator: workerCreator,
        joiner: workerJoiner
      },
      options
    });

    for (let run = 0; run < options.repeat; run += 1) {
      for (const scenarioId of scenarioIds) {
        const impl = SCENARIO_IMPLEMENTATIONS[scenarioId];
        if (typeof impl !== 'function') {
          throw new Error(`Scenario implementation missing: ${scenarioId}`);
        }
        const effectiveId = options.repeat > 1 ? `${scenarioId}__run${run + 1}` : scenarioId;
        await context.runScenario(effectiveId, impl);
      }
    }

    summary = await context.finalizeSummary({
      thresholds: DEFAULT_THRESHOLDS,
      extra: {
        runOptions: options,
        cluster: {
          federationId: cluster.federationId,
          gatewayIds: cluster.gatewayIds,
          gatewayPorts: cluster.gatewayPorts,
          gatewayBaseUrls: {
            a: cluster.gatewayBaseUrl('a'),
            b: cluster.gatewayBaseUrl('b')
          }
        }
      }
    });

    const hardFailures = Number(summary?.failedCount || 0);
    const thresholdFailures = Number(summary?.thresholdChecks?.failed?.length || 0);
    const totalFailures = hardFailures + thresholdFailures;

    log('[LiveMatrixE2E] completed', {
      hardFailures,
      thresholdFailures,
      totalFailures,
      failureBudget: options.failureBudget
    });

    if (totalFailures > options.failureBudget) {
      throw new Error(`live matrix failed: total failures ${totalFailures} > budget ${options.failureBudget}`);
    }
  } finally {
    try {
      await cluster.collectLogs();
    } catch (error) {
      log('[LiveMatrixE2E] failed to collect docker logs', { error: error?.message || String(error) });
    }

    if (!options.keepStack) {
      try {
        await workerCreator?.shutdown({ timeoutMs: 15_000 });
      } catch (_) {}
      try {
        await workerJoiner?.shutdown({ timeoutMs: 15_000 });
      } catch (_) {}
      try {
        await cluster.stop({ removeVolumes: true });
      } catch (_) {}
    }

    await runnerLog.flush();
    await workerALog.flush();
    await workerBLog.flush();

    if (summary) {
      process.stdout.write(`${JSON.stringify({
        runId: summary.runId,
        profile: summary.profile,
        passedCount: summary.passedCount,
        failedCount: summary.failedCount,
        thresholdFailures: summary.thresholdChecks?.failed?.length || 0,
        outputDir
      }, null, 2)}\n`);
    }
  }
}

main().catch((error) => {
  console.error('[LiveMatrixE2E] failed', {
    error: error?.message || String(error)
  });
  process.exitCode = 1;
});
