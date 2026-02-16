import { join } from 'node:path';

import {
  quantile,
  writeJsonFile,
  writeTextFile
} from './utils.mjs';

class ScenarioContext {
  constructor({
    runId,
    profile,
    outputDir,
    logger = null,
    cluster,
    workers,
    options = {}
  }) {
    this.runId = runId;
    this.profile = profile;
    this.outputDir = outputDir;
    this.logger = typeof logger === 'function' ? logger : null;
    this.cluster = cluster;
    this.workers = workers;
    this.options = options;
    this.timings = new Map();
    this.scenarioResults = [];
    this.state = {
      relay: null,
      closedJoinRecipientPubkey: null
    };
  }

  log(message, data = null) {
    if (!this.logger) return;
    this.logger(data ? `${message} ${JSON.stringify(data)}` : message);
  }

  recordTiming(name, ms) {
    if (!Number.isFinite(Number(ms))) return;
    const key = String(name || '').trim();
    if (!key) return;
    const list = this.timings.get(key) || [];
    list.push(Number(ms));
    this.timings.set(key, list);
  }

  metricSnapshot() {
    const output = {};
    for (const [name, values] of this.timings.entries()) {
      output[name] = {
        count: values.length,
        p95: quantile(values, 0.95),
        p50: quantile(values, 0.5),
        max: values.length ? Math.max(...values) : null,
        min: values.length ? Math.min(...values) : null,
        values
      };
    }
    return output;
  }

  async runScenario(id, fn) {
    const startedAt = Date.now();
    this.log(`[scenario:start] ${id}`);
    try {
      const result = await fn(this);
      const durationMs = Date.now() - startedAt;
      const payload = {
        id,
        status: 'passed',
        durationMs,
        startedAt,
        finishedAt: Date.now(),
        result: result || null
      };
      this.scenarioResults.push(payload);
      await writeJsonFile(join(this.outputDir, 'scenarios', `${id}.json`), payload);
      this.log(`[scenario:pass] ${id}`, { durationMs });
      return payload;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const payload = {
        id,
        status: 'failed',
        durationMs,
        startedAt,
        finishedAt: Date.now(),
        error: {
          message: error?.message || String(error),
          stack: error?.stack || null
        }
      };
      this.scenarioResults.push(payload);
      await writeJsonFile(join(this.outputDir, 'scenarios', `${id}.json`), payload);
      this.log(`[scenario:fail] ${id}`, {
        durationMs,
        error: payload.error.message
      });
      throw error;
    }
  }

  async finalizeSummary({ thresholds = {}, extra = {} } = {}) {
    const metrics = this.metricSnapshot();
    const joinToWritable = this.#buildJoinToWritableSummary();
    const summary = {
      runId: this.runId,
      profile: this.profile,
      generatedAt: Date.now(),
      scenarioCount: this.scenarioResults.length,
      passedCount: this.scenarioResults.filter((entry) => entry.status === 'passed').length,
      failedCount: this.scenarioResults.filter((entry) => entry.status === 'failed').length,
      thresholds,
      thresholdChecks: this.#checkThresholds(metrics, thresholds, joinToWritable),
      scenarios: this.scenarioResults,
      metrics,
      joinToWritable,
      ...extra
    };
    await writeJsonFile(join(this.outputDir, 'summary.json'), summary);
    await writeTextFile(
      join(this.outputDir, 'summary.txt'),
      [
        `runId=${summary.runId}`,
        `profile=${summary.profile}`,
        `scenarioCount=${summary.scenarioCount}`,
        `passedCount=${summary.passedCount}`,
        `failedCount=${summary.failedCount}`,
        `thresholdFailures=${summary.thresholdChecks.failed.length}`
      ].join('\n')
    );
    return summary;
  }

  #buildJoinToWritableSummary() {
    const openResults = [];
    const closedResults = [];
    for (const scenario of this.scenarioResults) {
      if (scenario?.status !== 'passed') continue;
      const joinPayload = scenario?.result?.joinToWritable;
      const records = Array.isArray(joinPayload)
        ? joinPayload
        : (joinPayload && typeof joinPayload === 'object' ? [joinPayload] : []);
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const mode = record.mode === 'closed' ? 'closed' : 'open';
        const normalized = {
          mode,
          joinToWritableMs: Number.isFinite(Number(record.joinToWritableMs))
            ? Math.round(Number(record.joinToWritableMs))
            : null,
          joinAuthToWritableMs: Number.isFinite(Number(record.joinAuthToWritableMs))
            ? Math.round(Number(record.joinAuthToWritableMs))
            : null,
          writable: typeof record.writable === 'boolean' ? record.writable : null,
          expectedWriterActive: typeof record.expectedWriterActive === 'boolean' ? record.expectedWriterActive : null,
          relayKey: record.relayKey || null,
          publicIdentifier: record.publicIdentifier || null,
          scenarioId: scenario.id
        };
        if (mode === 'closed') closedResults.push(normalized);
        else openResults.push(normalized);
      }
    }
    return {
      open: {
        results: openResults,
        stats: this.#buildJoinStats(openResults)
      },
      closed: {
        results: closedResults,
        stats: this.#buildJoinStats(closedResults)
      }
    };
  }

  #buildJoinStats(results = []) {
    const values = (Array.isArray(results) ? results : [])
      .map((entry) => Number(entry?.joinToWritableMs))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return {
      count: values.length,
      min: values.length ? Math.min(...values) : null,
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      max: values.length ? Math.max(...values) : null
    };
  }

  #checkThresholds(metrics, thresholds, joinToWritable = null) {
    const passed = [];
    const failed = [];
    const skipped = [];
    const strictMissingMetrics = this.options?.strictThresholdMetrics === true;
    const synthetic = {
      'join_to_writable.open.p95': Number(joinToWritable?.open?.stats?.p95),
      'join_to_writable.closed.p95': Number(joinToWritable?.closed?.stats?.p95)
    };
    for (const [name, thresholdMs] of Object.entries(thresholds || {})) {
      let p95 = Number.NaN;
      if (Object.prototype.hasOwnProperty.call(synthetic, name)) {
        p95 = synthetic[name];
      } else {
        const metric = metrics[name] || null;
        p95 = Number(metric?.p95);
      }
      if (!Number.isFinite(p95)) {
        if (strictMissingMetrics) {
          failed.push({ metric: name, reason: 'missing-p95', thresholdMs });
        } else {
          skipped.push({ metric: name, reason: 'missing-p95', thresholdMs });
        }
        continue;
      }
      if (p95 <= Number(thresholdMs)) {
        passed.push({ metric: name, p95, thresholdMs });
      } else {
        failed.push({ metric: name, p95, thresholdMs, reason: 'p95-threshold-exceeded' });
      }
    }
    return {
      passed,
      failed,
      skipped
    };
  }
}

export default ScenarioContext;
