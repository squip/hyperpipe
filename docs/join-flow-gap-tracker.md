# Join Flow Gap Tracker

Last updated: 2026-02-21

This document tracks confirmed gaps, observed context, and recommended fix approaches for direct-join/open-join reliability work.

## Status Legend
- `open`: identified and not yet fixed
- `in-progress`: currently being investigated or patched
- `deferred`: intentionally postponed
- `done`: fixed and validated

## Gaps

### G-001: Public gateway open-join challenge endpoint returns 404 in fallback path
- Status: `in-progress`
- Scope: `public-gateway`
- Observed context:
  - During open-join fallback, worker requests:
    - `/api/relays/<identifier>/open-join/challenge`
    - `/api/relays/<relayKey>/open-join/challenge`
  - Both fail with `404` in the failing run.
  - Evidence:
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:3621`
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:4615`
- Impact:
  - Open-join append/provision path cannot execute, so relay remains non-writable after join fallback.
- Recommended fix approach:
  1. Ensure gateway `open-join/challenge` supports both canonical relay key and public identifier lookup.
  2. Ensure alias->relayKey resolution is deterministic and available before join fallback.
  3. Add API contract + e2e coverage for both identifier forms.

### G-002: Open-offline path can complete join progression while relay is still non-writable
- Status: `open`
- Scope: `worker`
- Observed context:
  - Join proceeds with no writer material (`writerSecret`, `writerCore`, `expectedWriter` all null).
  - Relay activation waits and times out with `writable:false`.
  - Evidence:
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:3010`
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:3680`
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:6700`
- Impact:
  - UX reports a successful join transition but relay cannot process normal writable flow.
- Recommended fix approach:
  1. Enforce writer-guarantee gate before reporting final join success.
  2. Emit explicit `writer-unavailable` fail-fast reason when no writable path exists.
  3. Prevent success-side membership progression when `requireWritable` path timed out.

### G-003: Peer candidate selection includes non-host/gateway peer for direct join attempts
- Status: `deferred` (return after gateway fixes)
- Scope: `worker` smart-select / candidate filtering
- Observed context:
  - Direct join attempts include peer `43089073...` (gateway-connected peer), leading to timeout.
  - Evidence:
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:3170`
    - `/Users/essorensen/hypertuna-electron/test-logs/multi-gateway-live-tests/test2/worker.log:3601`
- Impact:
  - Adds avoidable timeout latency and can mis-prioritize direct-join path selection.
- Recommended fix approach:
  1. Exclude known gateway/blind-peer keys from host-join candidate set for direct handshake.
  2. Require host capability proof (writer-provision capability) before ranking as primary host candidate.
  3. Add telemetry assertions for selected candidate role and source.

### G-004: Public-gateway container stopped writing stdout mirror logs to `/home/squip/public-gateway-logs`
- Status: `done`
- Scope: `public-gateway` runtime deployment + logging utility
- Observed context:
  - Runtime logs on VPS no longer append to mounted host log directory after multi-gateway updates.
  - `stdout-log-rotator` in current gateway source no longer mirrors stdout/stderr to rotating files.
  - Runtime env did not define explicit `GATEWAY_LOG_DIR`.
  - Evidence:
    - `/home/squip/hyperpipe-gateway/public-gateway/src/utils/stdout-log-rotator.mjs`
    - `/home/squip/hyperpipe-gateway/public-gateway/deploy/runtime/.env`
    - `/home/squip/public-gateway-logs` timestamps stalling during active runtime.
- Impact:
  - Loss of file-based operational logs used for production troubleshooting and regression triage.
- Recommended fix approach:
  1. Restore stdout/stderr interception + rotating file stream writes in `stdout-log-rotator`.
  2. Set `GATEWAY_LOG_DIR=/app/public-gateway/logs` and rotation/retention env vars in runtime env.
  3. Keep docker bind mount `/home/squip/public-gateway-logs:/app/public-gateway/logs` and verify new file writes after redeploy.
- Validation:
  - New rotated file observed after restart:
    - `/home/squip/public-gateway-logs/public-gateway-20260220-205228.log`
  - Startup log lines are now mirrored from container stdout into host-mounted file path.

### G-005: Snap docker compose `--build` fails with metadata temp-file error on VPS
- Status: `open`
- Scope: `public-gateway` deployment workflow
- Observed context:
  - Running `sudo /snap/bin/docker compose --env-file .env up -d --build` fails after successful image build with:
    - `open /tmp/.tmp-compose-build-metadataFile-*.json*: no such file or directory`
  - `up -d` without `--build` works and starts containers.
- Impact:
  - Build+deploy appears to fail, leaving stack stopped or unchanged and causing false-negative validation (e.g. no new logs).
- Recommended fix approach:
  1. Use two-step deployment on VPS:
     - `sudo /snap/bin/docker compose build public-gateway` (or `docker build` directly)
     - `sudo /snap/bin/docker compose up -d`
  2. Optionally disable bake path in deployment command/environment for snap docker compose.
- Validation notes:
  - `sudo /snap/bin/docker compose --env-file .env build public-gateway` reproduces the temp-file error.
  - `sudo /snap/bin/docker build -f /home/squip/hyperpipe-gateway/public-gateway/Dockerfile -t runtime-public-gateway /home/squip/hyperpipe-gateway` succeeds.

### G-006: Relay host disabled in public-gateway runtime due missing relay admin key pair
- Status: `done`
- Scope: `public-gateway` runtime `.env`
- Observed context:
  - Gateway logs emit:
    - `Hyperbee relay feature enabled but admin key pair missing`
  - Runtime `.env` defines operator keys but does not define:
    - `GATEWAY_RELAY_ADMIN_PUBLIC_KEY`
    - `GATEWAY_RELAY_ADMIN_SECRET_KEY`
  - Code path confirms relay host is skipped when keys are missing.
- Impact:
  - Hyperbee relay host does not initialize, which likely contributes to open-join fallback failures and missing relay functionality.
- Recommended fix approach:
  1. Populate `GATEWAY_RELAY_ADMIN_PUBLIC_KEY` + `GATEWAY_RELAY_ADMIN_SECRET_KEY` in:
     - `/home/squip/hyperpipe-gateway/public-gateway/deploy/runtime/.env`
  2. Use known-good values from previous working deployment (if still valid) or provision a new keypair and update dependent metadata.
  3. Restart gateway and verify `Hyperbee relay host ready` appears in logs.
- Validation:
  - Runtime `.env` now includes relay admin keypair + namespace/topic.
  - Gateway log now reports:
    - `Hyperbee relay host ready`

### G-007: New runtime stack used fresh `runtime_*` volumes instead of existing `deploy_*` volumes
- Status: `done`
- Scope: `public-gateway` docker-compose volume mapping / migration continuity
- Observed context:
  - Active runtime stack initially mounted fresh volumes:
    - `runtime_gateway-relay-data`, `runtime_gateway-blind-peer-data`, `runtime_redis-data`
  - Historical data exists in old volumes:
    - `deploy_public-gateway-data` (3.5G, includes `/blind-peer` + `/gateway-relay`)
    - `deploy_redis-data` (registration state)
  - This caused empty/fresh runtime state and missing relay registrations during fallback joins.
- Impact:
  - Gateway can appear healthy but fail join flows for previously registered relays (`relay not registered`) because registration/mirror state is not in the new volumes.
- Recommended fix approach:
  1. Mount existing `deploy_*` volumes as external volumes in runtime compose.
  2. Recreate runtime services so gateway and redis load historical relay/mirror metadata.
- Validation:
  - Runtime compose now points to external volumes:
    - `deploy_public-gateway-data`, `deploy_redis-data`, `deploy_traefik-lets`
  - Gateway startup logs now show restored mirror snapshot size:
    - `Loaded metadata snapshot` with `entries: 3530`
  - Redis `DBSIZE` is non-trivial after migration (`754`), confirming restored keyspace.

### G-008: Direct peer join request could block indefinitely without request timeout
- Status: `done`
- Scope: `worker` direct-join handshake transport
- Observed context:
  - During renderer-driven S19, join selected `peer-local-provision` candidate and emitted `JOIN_PATH_SELECTED` / `JOIN_WRITER_SOURCE`, but stalled at:
    - `Attempting direct join via peer ...`
  - No progress/fail-fast event followed because the peer request was waiting indefinitely on `protocol.sendRequest`.
- Impact:
  - Join orchestration could hang for extended periods, causing scenario runner stalls and user-visible spinner hangs.
- Recommended fix approach:
  1. Add a request-timeout wrapper around peer protocol requests.
  2. Apply timeout wrapper to:
     - direct `POST /post/join/:identifier`
     - direct `POST /verify-ownership`
     - generic peer JSON RPC helper
  3. Ensure direct-join continues to next candidate/fallback path after timeout instead of hanging.
- Validation:
  - Renderer S19 run now shows explicit timeout + fallback progression:
    - first peer timed out with `direct join request (...) timed out after 12000ms`
    - next candidate/fallback completed and emitted `JOIN_WRITABLE_CONFIRMED`
  - Scenario status is now `PASS`:
    - `/Users/essorensen/hypertuna-electron/test-logs/live-matrix/multi-gateway/20260221-000914/S19/result.json`
