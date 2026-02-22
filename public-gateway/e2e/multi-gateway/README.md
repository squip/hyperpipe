# Multi-Gateway Live Matrix Harness

This harness validates S01-S22 across:
- worker-direct executor (`executor-real.mjs`)
- renderer/Electron executor (`executor-renderer.mjs`)
- local/remote/disabled gateway topology mixes

## Files
- `scenarios.mjs`: canonical S01-S22 scenario definitions + hard gate constants.
- `executor-real.mjs`: worker-direct scenario driver.
- `executor-renderer.mjs`: Playwright-driven Electron renderer scenario driver.
- `run-matrix.mjs`: orchestrator, policy setup, health checks, evaluation, artifact generation.
- `docker-compose.yml`: local gateway stack (`gateway1`,`gateway2`,`redis1`,`redis2`).

Renderer executor prerequisites:
- `indiepress-dev/node_modules/playwright` installed
- `hypertuna-desktop/node_modules/electron` installed

## Executor Contract
The selected executor receives:
- `HT_SCENARIO_ID`
- `HT_SCENARIO_JSON`
- `HT_SCENARIO_DIR`
- `HT_SCENARIO_TIMEOUT_MS`
- `HT_SCENARIO_BASELINE_DIR`
- `HT_MULTI_GATEWAY_GATES`
- `HT_GW1_MODE`
- `HT_GW2_MODE`

Executors should emit:
- worker logs (at minimum `workerA.log`, `workerB.log`) under `${HT_SCENARIO_DIR}`
- `HT_SCENARIO_SUMMARY={...json...}` with optional:
  - `workerLogs: string[]`
  - `observedViewLength: number`
  - `expectedViewLength: number`
  - `autoConnectObservedViewLength: number`
  - `autoConnectExpectedViewLength: number`

## Gateway Topology Controls
`run-matrix.mjs` supports per-gateway modes:
- `HT_GW1_MODE=local|remote|disabled`
- `HT_GW2_MODE=local|remote|disabled`

Behavior:
- local: docker service is started/stopped by the runner.
- remote: no docker for that gateway; health/policy APIs are still exercised.
- disabled: gateway is skipped for docker, health, and policy.

Optional remote log snapshots per scenario:
- `HT_GW1_REMOTE_LOG_CMD="<shell command>"`
- `HT_GW2_REMOTE_LOG_CMD="<shell command>"`

Snapshot outputs are written into each scenario artifact directory.

## Reliability Gates
Hard-fail:
- join-to-writable <= 120000ms
- writer-material stage <= 45000ms
- fast-forward stage <= 30000ms
- fanout success >= 1
- writable view length parity

Warning:
- join-to-writable <= 60000ms

Additional regression checks:
- `join_dispatch_hint_evidence`
- `metadata_hint_continuity`
- `legacy_shared_secret_fallback_not_used`
- `gateway_nostr_bearer_auth_observed` (when a gateway writer path is selected)
- required telemetry/source checks for S19-S22 (`JOIN_PATH_SELECTED`, `JOIN_WRITER_SOURCE`)

## Commands
Default matrix (worker-direct executor):
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs
```

Renderer executor matrix:
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs \
  --executor "node ./public-gateway/e2e/multi-gateway/executor-renderer.mjs"
```

Mixed topology (`GW1=remote`, `GW2=local`) with renderer executor:
```bash
HT_GW1_MODE=remote HT_GW2_MODE=local \
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs \
  --executor "node ./public-gateway/e2e/multi-gateway/executor-renderer.mjs"
```

One scenario:
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs \
  --scenario S22 \
  --executor "node ./public-gateway/e2e/multi-gateway/executor-renderer.mjs"
```

Dry run:
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs --dry-run
```

## Artifacts
Outputs are written under:
- `/Users/essorensen/hypertuna-electron/test-logs/live-matrix/multi-gateway/<timestamp>/`

Per run:
- `matrix-summary.json`
- `matrix-summary.md`
- per-scenario directory with `scenario.json`, executor logs, `result.json`, optional `gateway-snapshots.json`.
