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
    const summary = {
      runId: this.runId,
      profile: this.profile,
      generatedAt: Date.now(),
      scenarioCount: this.scenarioResults.length,
      passedCount: this.scenarioResults.filter((entry) => entry.status === 'passed').length,
      failedCount: this.scenarioResults.filter((entry) => entry.status === 'failed').length,
      thresholds,
      thresholdChecks: this.#checkThresholds(metrics, thresholds),
      scenarios: this.scenarioResults,
      metrics,
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

  #checkThresholds(metrics, thresholds) {
    const passed = [];
    const failed = [];
    for (const [name, thresholdMs] of Object.entries(thresholds || {})) {
      const metric = metrics[name] || null;
      const p95 = Number(metric?.p95);
      if (!Number.isFinite(p95)) {
        failed.push({ metric: name, reason: 'missing-p95', thresholdMs });
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
      failed
    };
  }
}

export default ScenarioContext;
