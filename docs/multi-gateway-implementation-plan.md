# Multi-Gateway Public-Gateway Redundancy Plan (Implementation + Live Validation + Join Performance Gates)

## Summary
This implementation layers Blossom-style multi-gateway redundancy on top of the current worker/gateway behavior. It adds:
- multi-gateway metadata tags at group level,
- gateway policy/auth controls (OPEN/CLOSED, allow-list, ban-list, invite/join-request),
- relay status probing and ranking,
- join telemetry/fail-fast instrumentation,
- post-join fanout diagnostics,
- and a dedicated live matrix harness with S01-S18 scenarios and SLA gates.

## Locked Decisions
1. Auth model: Nostr Challenge JWT.
2. Operator workflow: API + CLI only.
3. Live validation harness: dedicated multi-gateway harness under `public-gateway/e2e/multi-gateway`.

## Success Criteria
### Functional
1. Group metadata stores selected gateways in `kind:39000` `gateway` tags.
2. Join probes/ranks listed gateways and supports fallback.
3. Join reaches writable with expected writer material and sync path.
4. Fanout succeeds on at least one gateway and reports per-gateway failures.
5. CLOSED gateways enforce allow-list for relay admin registration.
6. Ban-list blocks banned requestors on protected paths.

### Performance
1. `join_start -> writable:true <= 120000ms` hard fail.
2. `<= 60000ms` warning threshold.
3. Writer material stage <= 45000ms.
4. Fast-forward stage <= 30000ms.
5. Writable confirmation includes view-length evidence for match checking.

## Implemented Components
### Shared contracts
- `shared/public-gateway/GatewayContracts.mjs`
- Canonical parse/build for:
  - `kind:39000` `gateway` tags,
  - `kind:30078` metadata/invite/join-request variants.

### Public gateway
- New services:
  - `public-gateway/src/GatewayPolicyService.mjs`
  - `public-gateway/src/GatewayAuthService.mjs`
  - `public-gateway/src/GatewayEventPublisher.mjs`
  - `public-gateway/src/GatewayInviteService.mjs`
- `PublicGatewayService` additions:
  - `GET /api/relays/:relayKey/status`
  - `POST /api/auth/challenge`
  - `POST /api/auth/verify`
  - `GET/POST /api/gateway/policy`
  - allow/ban list endpoints
  - join-request and invite endpoints
  - OPEN/CLOSED allow/ban enforcement for register/open-join paths
  - debug stream `PG_DEBUG_MULTI_GATEWAY=1`
- Config additions in `public-gateway/src/config.mjs`:
  - operator keys, policy, allow/ban lists, discovery relays,
  - invite-only, JWT secret/ttl, feature flags.
- Operator CLI commands:
  - `gateway-allow`, `gateway-ban`, `gateway-invite`, `gateway-join-requests`.

### Worker
- Multi-gateway probe/rank/fanout and join telemetry in `hypertuna-worker/index.js`.
- Join telemetry events:
  - `JOIN_START`
  - `JOIN_WRITER_MATERIAL_APPLIED`
  - `JOIN_FAST_FORWARD_APPLIED`
  - `JOIN_WRITABLE_EVENT`
  - `JOIN_WRITABLE_CONFIRMED`
  - `JOIN_FAIL_FAST_ABORT`
- Added `hypertuna-worker/gateway/MultiGatewayJoinUtils.mjs` for testable ranking/SLA/fanout evaluation.
- `pear-relay-server.mjs` writable events now include length metadata for view-length match checks.

### Renderer + TUI
- Gateway tags parsed and threaded through create/join payloads.
- Worker bridge join payload supports `gatewayOrigins`.
- Group metadata update path preserves unknown tags.

### Harness
Path: `public-gateway/e2e/multi-gateway`
- `scenarios.mjs`: canonical S01-S18 matrix.
- `docker-compose.yml`: 2 gateways + 2 redis.
- `run-matrix.mjs`:
  - scenario orchestration,
  - policy pre-configuration,
  - executor integration,
  - fail-fast detection,
  - SLA + fanout + view-length assertions,
  - artifact generation.
- `executor-stub.mjs`: deterministic pass/fail stub for harness verification.

## Validation Outputs
Artifacts root:
- `test-logs/live-matrix/multi-gateway/<timestamp>/`

Generated per run:
- `matrix-summary.json`
- `matrix-summary.md`
- per-scenario logs and `result.json`

## Baseline Calibration
Harness references:
- `test-logs/CLOSED-JOIN-V2/PASS-closed-join-refactor-V2-3/`
for expected marker sequencing and join-writable timing behavior.

## Notes
1. Full live S01-S18 execution requires a scenario executor that drives two real workers through create/join flows and emits scenario summaries/log paths.
2. Harness and gateway stack are implemented and validated (dry-run, stub-run, docker + policy/auth orchestration).
