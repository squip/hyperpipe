# Hypertuna Public Gateway

Public HTTPS gateway for Hypertuna relays with multi-gateway policy controls, blind-peer mirror services, and operator tooling.

## What is included

- Gateway service (`src/index.mjs`) with relay bridge + blind-peer mirror functionality.
- Operator APIs for policy, allow-list, ban-list, join requests, invites, and status.
- Nostr challenge/verify JWT auth (`/api/auth/challenge`, `/api/auth/verify`).
- Embedded admin web UI at `/admin`.
- Guided deployment/management CLI: `gateway-admin`.

## Quick Start (Wizard + Docker)

```bash
cd public-gateway
npm install
node ./bin/gateway-admin.mjs init
node ./bin/gateway-admin.mjs deploy up
```

This creates runtime deployment files in:

- `public-gateway/deploy/runtime/docker-compose.yml`
- `public-gateway/deploy/runtime/.env`
- `public-gateway/deploy/runtime/config.json`

After `deploy up`, open:

- Admin UI: `${GATEWAY_PUBLIC_URL}/admin`
- Health: `${GATEWAY_PUBLIC_URL}/health`
- Metrics: `${GATEWAY_PUBLIC_URL}/metrics`

## Admin UI Login

The admin UI uses Nostr challenge auth:

1. Enter operator pubkey hex + nsec hex.
2. UI signs `kind:22242` auth event.
3. Gateway issues JWT + optional HttpOnly admin session cookie.

From the dashboard, operators can:

- Update OPEN/CLOSED policy and invite-only mode.
- Manage allow-list and ban-list entries.
- Review and approve/reject join requests.
- Create invites.
- View overview/metrics/activity.
- Trigger metadata republish and blind-peer GC actions.

## `gateway-admin` CLI

```bash
gateway-admin init
gateway-admin config show
gateway-admin config edit
gateway-admin deploy up
gateway-admin deploy status
gateway-admin deploy logs --service public-gateway
gateway-admin deploy down --volumes
```

Operator commands:

```bash
gateway-admin operator allow list
gateway-admin operator allow add <pubkey>
gateway-admin operator ban add <pubkey>
gateway-admin operator invite create <pubkey>
gateway-admin operator join-requests list
gateway-admin operator join-requests approve <requestId>
gateway-admin operator policy show
gateway-admin operator policy set --policy CLOSED --invite-only --discovery wss://relay.one,wss://relay.two
```

Legacy wrappers remain available and forward to `gateway-admin operator ...`:

- `gateway-allow`
- `gateway-ban`
- `gateway-invite`
- `gateway-join-requests`

## Deployment Profiles

Templates live in `public-gateway/deploy/templates/`:

- `docker-compose.local.yml` (single host/local access)
- `docker-compose.internet.yml` (Traefik + Let's Encrypt)

Env templates:

- `env.local.example`
- `env.internet.example`

## Development

```bash
npm run dev
npm test
```

## Configuration

See `public-gateway/.env.example` for the complete env surface, including:

- Gateway policy/auth (`GATEWAY_POLICY`, `GATEWAY_AUTH_*`)
- Admin UI/session settings (`GATEWAY_ADMIN_*`)
- Multi-gateway controls (`GATEWAY_ENABLE_MULTI`, allow/ban/discovery lists)
