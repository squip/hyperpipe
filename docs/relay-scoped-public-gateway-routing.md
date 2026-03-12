## Relay-Scoped Public Gateway Routing (Phase Plan)

### Summary
- Replace global user-level gateway config with relay-scoped gateway assignment carried in group metadata/invites.
- Keep existing join/mirror workflows intact by introducing a worker-side routing layer that maps `relayKey -> gatewayOrigin`.
- Use Nostr `kind:30078` gateway announcements as primary discovery, with temporary dual-publish fallback to current Hyperswarm discovery.
- Keep auth model as shared-secret-based, but make it automatic and per-gateway with lazy resolution and caching.
- Disable worker `public-gateway:hyperbee` virtual relay logic early to remove noise and out-of-scope behavior.

### Key Implementation Changes
- **Gateway discovery + metadata contracts**
  - Add gateway announcement schema on `kind:30078` (parameterized replaceable with `d` tag).
  - Required fields: stable `gatewayId`, `httpOrigin`; optional fields: `wsOrigin`, display name, secret bootstrap metadata, capability tags.
  - Gateway server publishes both `30078` and existing Hyperswarm advertisement during rollout.
  - Client/worker discovery aggregator prefers fresh `30078`; falls back to Hyperswarm when no fresh `30078` record exists.

- **Group/invite schema updates**
  - Add relay-scoped gateway fields to group metadata events and invite payloads:
  - `gatewayId` (nullable), `gatewayOrigin` (nullable), `directJoinOnly` boolean.
  - Group create UI: gateway dropdown from discovery, plus manual URL fallback entry, plus explicit “Direct-join only (no gateway)” option.
  - Join flow persists assignment immediately from metadata/invite before any gateway-assisted operations.

- **Worker routing layer (minimal flow rewrites)**
  - Introduce `RelayGatewayMapStore` persisted locally and keyed by normalized `relayKey`.
  - Introduce `GatewayRouter` API used by existing gateway callsites:
  - `resolveForRelay(relayKey)` returns designated origin or “none”.
  - `withRelayGateway(relayKey, operation)` wraps existing registrar/mirror/open-join calls without changing core join logic.
  - Behavior:
  - If mapped gateway exists, only that origin is used.
  - If `directJoinOnly`, gateway fallbacks are skipped.
  - If gateway-assisted op requires mapping and none exists, return deterministic `gateway-unassigned` error.

- **Disable out-of-scope virtual relay behavior**
  - Disable `public-gateway:hyperbee` virtual relay registration/sync/unregister paths in worker gateway service.
  - Remove related status emissions from tests and runtime expectations.

- **Auth adaptation (automatic, no user input)**
  - Keep shared-secret token model for write routes.
  - Add per-gateway secret registry/cache keyed by origin.
  - Resolve secret lazily on first authenticated operation for that gateway.
  - Retry once on auth failure after forced secret refresh, then fail with scoped error.
  - Do not require pre-registration at worker startup; perform registration/pool updates only when relay operations need it.

- **Scope cleanups**
  - Remove/ignore `gatewayMode` disabled/auto test-flag pathways in this wave.
  - No backward-compat migrations for old groups/events; hard cutover to new relay-scoped model.

### Public APIs / Interfaces / Types
- `kind:30078` gateway announcement event contract (gateway discovery payload).
- Group metadata + invite contracts gain nullable `gatewayId`, `gatewayOrigin`, and `directJoinOnly`.
- Worker IPC/message payloads for create/join include relay-scoped gateway assignment.
- New internal worker interfaces:
  - `RelayGatewayMapStore` (upsert/get/list/prune),
  - `GatewayRouter` (resolve + route wrapper),
  - `GatewaySecretRegistry` (get/refresh/invalidate by origin).

### Test Plan (phased, docker-backed, auditable)
- **Phase 1: Discovery + Create**
  - Start 2 gateway containers and publish discovery records.
  - Validate dropdown population, manual URL fallback, and direct-join-only selection.
  - Assert created group metadata contains expected gateway assignment fields.

- **Phase 2: Routing correctness**
  - Create Group A on Gateway 1 and Group B on Gateway 2.
  - Verify worker request routing isolation: each relay only hits its assigned gateway for register/mirror/bootstrap calls.

- **Phase 3: Offline join parity (open + closed)**
  - Host offline, designated gateway online: join succeeds and rehydrates state for both open and closed groups.
  - Confirm no calls are sent to non-assigned gateways.

- **Phase 4: Direct join path parity**
  - Host online, designated gateway offline: direct join succeeds for open and closed groups.
  - For direct-join-only groups, assert gateway services are never called.

- **Phase 5: Auth lifecycle**
  - Join relay mapped to gateway not previously contacted by worker.
  - Verify automatic secret resolution, lazy registration behavior, token refresh-once, and no user interaction.

- **Phase 6: Regression suite**
  - Re-run your current 10 scenario baseline across Electron renderer + TUI with new routing.
  - Emit standardized artifacts per test run: gateway logs, peer logs, timeline, and JSON summary.

### Assumptions and Defaults
- Discovery rollout is **dual publish** initially; removal of Hyperswarm discovery happens after parity is proven.
- Auth remains **shared-secret-based**, upgraded to **automatic per-gateway secret management**.
- Group create flow supports **manual gateway URL fallback** and allows **blank gateway assignment** for direct-join-only groups.
- Legacy group compatibility is intentionally excluded in this wave.
