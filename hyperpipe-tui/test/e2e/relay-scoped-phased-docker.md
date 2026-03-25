# Relay-Scoped Validation Runner

This runner replaces the previous timeout-only phased Docker script with a checkpoint-driven validation stack.

## Command

From `/Users/essorensen/hypertuna-electron/hyperpipe-tui`:

```bash
npm run demo:e2e:real:relay-scoped-phased-docker
```

Optional flags:

```bash
npm run demo:e2e:real:relay-scoped-phased-docker -- --phases 1,2,3,4,5,6,7,8 --base-dir /abs/path --keep-docker true
```

## Phase Summary

1. `Baseline Freeze`: parse golden logs and derive required markers/path hints.
2. `Instrumentation Pass`: strict metadata + checkpoint completeness for gateway-assisted open join.
3. `Contract Layer`: direct-join-only no-gateway traffic + deterministic gateway-unassigned failure contract.
4. `Single Relay Deterministic`: open/closed offline parity with fail-fast checkpoints.
5. `Multi Relay Isolation`: verify per-relay origin isolation across gateway assignments.
6. `Auth Lifecycle`: stale secret failure, retry with valid secret, and cleanup via registrar probe.
7. `End-to-End Regression`: matrix replay across open/closed, online/offline, and direct-join-only modes.
8. `CI And Triage Gates`: emit PR/nightly gates and first-failure repro metadata.

## Artifacts

Each scenario emits:

- `timeline.jsonl`
- `checkpoints.json`
- `gateway-trace.json`
- `verdict.json`
- `host-worker.log`
- `joiner-worker.log`
- `summary.json`

Each phase emits `phase-summary.json`. Top-level run emits `summary.json`.

## Failure Model

- Runner stops each scenario at the first failed checkpoint.
- Phase failure reports the first causal checkpoint rather than only final timeout state.
- `phase-8-ci-gates/ci-gates.json` includes first-failing phase/scenario/checkpoint and a repro command.
