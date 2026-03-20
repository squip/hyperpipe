# Public Gateway Deploy Bundle

This directory contains a standalone Docker Compose bundle and deploy CLI for self-hosting the public gateway on a machine or VPS.

## Recommended Flow

1. Install prerequisites:
   - Docker
   - Docker Compose plugin or `docker-compose`
   - Node.js 20+ for the deploy CLI
   - a DNS A record pointing your chosen hostname at the target machine

2. Install the deploy CLI dependencies:
   ```bash
   cd deploy
   npm install
   ```

3. Generate a runtime env file:
   ```bash
   npm run deploy:init
   ```

4. Validate the deploy bundle:
   ```bash
   npm run deploy:check
   ```

5. Start the stack:
   ```bash
   npm run deploy:apply
   ```

6. Run smoke checks:
   ```bash
   npm run deploy:smoke
   ```

The package also exposes the standalone CLI directly if you prefer:

```bash
./bin/gateway-deploy.mjs init
./bin/gateway-deploy.mjs check
```

By default the generated runtime config is written to `deploy/.env`. You can also target a named env file under `deploy/environments/`:

```bash
npm run deploy:init -- --deploy-env production
npm run deploy:apply -- --deploy-env production
```

## Commands

### `init`

Interactive setup wizard that:

- prompts for foundational values such as host, email, profile, display name, region, and relay lists
- applies one of the built-in auth profiles:
  - `open`
  - `allowlist`
  - `wot`
  - `allowlist+wot`
- generates stable secrets and relay admin keys when missing
- preserves existing values when re-run against the same env file

### `check`

Runs deploy validation before you start containers:

- schema validation for the selected profile
- Docker / Compose availability checks
- Docker daemon reachability
- best-effort port-availability warnings
- `docker compose config` validation against `deploy/docker-compose.yml`

### `apply`

Runs `check` first, then executes:

```bash
docker compose --env-file <selected-env> -f deploy/docker-compose.yml up -d --build
```

### `smoke`

Runs post-deploy health checks:

- `docker compose ps`
- container runtime inspection
- `GET /health` against the configured public URL
- secret endpoint validation when the selected profile advertises open access

Optional deep auth validation is available if you provide an auth manifest:

```bash
npm run deploy:smoke -- \
  --auth-manifest ./path/to/manifest.json \
  --policy-column wotDepth2Threshold
```

The manifest should follow the same shape used by the gateway auth fixture tooling: an `accounts` array with credential material and a `policyMatrix` describing expected `ALLOW` / `DENY` outcomes.

## Profiles

Profile defaults are stored in:

- `deploy/profiles/open.env`
- `deploy/profiles/allowlist.env`
- `deploy/profiles/wot.env`
- `deploy/profiles/allowlist+wot.env`

The CLI writes explicit env values for discovery relays, auth relays, public URL, and auth policy so deployments do not inherit project-specific defaults accidentally.
The checked-in profile files are also the source of truth for the profile presets loaded by the schema.

The deploy bundle now enables the live Block List store by default for every profile, and enables the live Allow List store by default for `allowlist` and `allowlist+wot`, with:

- `GATEWAY_AUTH_ALLOWLIST_FILE=/data/config/allowlist.json`
- `GATEWAY_AUTH_ALLOWLIST_REFRESH_MS=5000`
- `GATEWAY_AUTH_BLOCKLIST_FILE=/data/config/blocklist.json`
- `GATEWAY_AUTH_BLOCKLIST_REFRESH_MS=5000`

If `GATEWAY_AUTH_OPERATOR_PUBKEY` is set, the gateway exposes the operator access manager at `/admin/allowlist`, including user-friendly **Allow List**, **Web of Trust**, and **Block List** tabs when those features are enabled by the active profile and env file.

## Portable Defaults

The deploy CLI generates and persists the following values automatically when missing:

- `GATEWAY_REGISTRATION_SECRET`
- `GATEWAY_RELAY_NAMESPACE`
- `GATEWAY_RELAY_REPLICATION_TOPIC`
- `GATEWAY_RELAY_ADMIN_PUBLIC_KEY`
- `GATEWAY_RELAY_ADMIN_SECRET_KEY`
- `GATEWAY_BLINDPEER_PORT`

Override these manually only if you already have stable values you need to preserve.

## Advanced Manual Editing

`deploy/.env.example` is a full reference template for advanced users, but the preferred workflow is still `init -> check -> apply -> smoke`.
