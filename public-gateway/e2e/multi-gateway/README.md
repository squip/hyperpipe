# Multi-Gateway Live Matrix Harness

This harness drives S01-S18 multi-gateway scenarios with:
- 2 dockerized public gateways (`gateway1`, `gateway2`)
- 2 isolated Redis instances (`redis1`, `redis2`)
- fail-fast detection from worker join telemetry
- hard performance gates and fanout threshold checks

## Files
- `scenarios.mjs`: canonical S01-S18 scenario definitions + hard gate constants.
- `docker-compose.yml`: local stack for gateways and Redis.
- `env/gateway1.env`, `env/gateway2.env`: default gateway configs.
- `run-matrix.mjs`: orchestrator + evaluator + artifacts writer.

## Required Inputs
The matrix runner can execute the built-in real executor (`executor-real.mjs`) by default.
You can still override with:
- `--executor "<command>"`
- `HT_MULTI_GATEWAY_SCENARIO_EXECUTOR="<command>"`

The command is executed with scenario context env vars:
- `HT_SCENARIO_ID`
- `HT_SCENARIO_JSON`
- `HT_SCENARIO_DIR`
- `HT_SCENARIO_TIMEOUT_MS`
- `HT_SCENARIO_BASELINE_DIR`
- `HT_MULTI_GATEWAY_GATES`

The executor should write:
- worker logs to `${HT_SCENARIO_DIR}/workerA.log` and `${HT_SCENARIO_DIR}/workerB.log`
  OR return explicit paths in summary JSON.
- optional structured summary line:
  - `HT_SCENARIO_SUMMARY={...json...}`

Summary fields recognized by the harness:
- `workerLogs: string[]`
- `observedViewLength: number`
- `expectedViewLength: number`

## Join / Reliability Gates
Hard-fail gates per scenario:
- join-to-writable <= 120000ms
- writer-material stage <= 45000ms
- fast-forward stage <= 30000ms
- fanout success count >= 1
- writable view length equals expected view length

Warning-only gate:
- join-to-writable <= 60000ms (warning when exceeded)

## Commands
Run full matrix (with docker stack):
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs \
  --executor "<your-scenario-driver>"
```

Run one scenario:
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs \
  --scenario S11 \
  --executor "<your-scenario-driver>"
```

Dry run (no docker, no execution):
```bash
node /Users/essorensen/hypertuna-electron/public-gateway/e2e/multi-gateway/run-matrix.mjs --dry-run
```

## Artifacts
Outputs are written under:
- `/Users/essorensen/hypertuna-electron/test-logs/live-matrix/multi-gateway/<timestamp>/`

Per run:
- `matrix-summary.json`
- `matrix-summary.md`
- per-scenario folder with `scenario.json`, executor logs, `result.json`.
