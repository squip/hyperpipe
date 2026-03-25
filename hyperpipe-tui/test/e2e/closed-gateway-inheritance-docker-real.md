# Closed Gateway Inheritance Docker Harness

This harness is the deterministic replacement for the prior ad-hoc run script.

## What it fixes

1. Starts a dedicated docker gateway+redis stack per run (`docker compose -p <unique>`).
2. Enables blind-peering in the gateway container and blocks until `/health` and `/api/blind-peer` both report ready.
3. Pre-seeds each worker storage with `hyperpipe-gateway-settings.json` and `public-hyperpipe-gateway-settings.json` **before worker start**.
4. Forces route preflight checks so workers confirm the expected gateway origin instead of global fallback defaults.
5. Tears docker down with volumes by default to prevent stale state contamination between runs.

## Run

From `hyperpipe-tui`:

```bash
npm run demo:e2e:real:closed-gateway-inheritance-docker
```

Optional flags:

```bash
npm run demo:e2e:real:closed-gateway-inheritance-docker -- --gateway-port 4430 --keep-docker true
```

Dry-run (setup only, no workers/join flow):

```bash
npm run demo:e2e:real:closed-gateway-inheritance-docker -- --dry-run true
```

