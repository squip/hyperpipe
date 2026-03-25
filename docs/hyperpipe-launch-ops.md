# Hyperpipe Launch Ops

This repository contains the Hyperpipe desktop client, TUI, worker, shared runtime, gateway server, and deploy tooling. The public `hyperpipe.io` website is intentionally external to this repository.

## Current Launch State

- Desktop, TUI, worker, gateway, shared runtime, storage keys, and plugin contract have been migrated to Hyperpipe.
- Plugins remain disabled by default for launch.
- Release workflows exist for desktop installers and TUI portable bundles under `.github/workflows/`.
- Deploy supports an optional static-site overlay for `hyperpipe.io` via `deploy/docker-compose.site.yml`.

## External Steps Still Required

### 1. Finalize the official GitHub repository URL

Update these files after the repository rename is complete:

- `hyperpipe-desktop/package.json`
- `hyperpipe-tui/package.json`
- `hyperpipe-gateway/package.json`
- `hyperpipe-desktop/src/constants.ts`

### 2. Create the external `hyperpipe.io` website project

Keep the site in a separate repository or deployment project. The site should stay minimal:

- product overview
- desktop and TUI download links that point to GitHub Releases
- official GitHub repository link
- optional docs/community links

The main Hyperpipe repository should not contain the website source.

### 3. Point DNS to the VPS

- `A` record: `hyperpipe.io` -> VPS IPv4
- optional `CNAME`: `www.hyperpipe.io` -> `hyperpipe.io`
- only add `AAAA` if IPv6 is confirmed working end-to-end

### 4. Deploy the site overlay behind Traefik

In `deploy/environments/<env>.env`:

- `SITE_ENABLED=true`
- `SITE_HOST=hyperpipe.io`
- `SITE_WWW_HOST=www.hyperpipe.io`
- `HYPERPIPE_SITE_ROOT=/srv/hyperpipe-site/current`

Then place the static site files at `${HYPERPIPE_SITE_ROOT}` on the VPS and deploy with the existing deploy tooling. Traefik will request the certificate automatically once DNS is live and ports `80/443` are reachable.

### 5. Configure release signing

Desktop release workflows still need the platform signing material:

- macOS Developer ID certificate and notarization credentials
- Windows code-signing certificate

Add the required GitHub Actions secrets before publishing the first public release.

### 6. Publish release artifacts

Use GitHub Releases as the binary distribution channel:

- desktop: macOS `arm64`/`x64`, Windows `x64`, Linux `x64`
- TUI: portable bundles for macOS `arm64`/`x64`, Windows `x64`, Linux `x64`
- include `SHA256SUMS`

## Intentional Exceptions

- `hypertuna.com` remains an operator-hosted gateway/relay domain where explicitly configured.
- The hosted translation service still uses the Fevela contract and is intentionally unchanged.
- Plugins are migrated to the Hyperpipe contract but remain disabled by default for launch.
