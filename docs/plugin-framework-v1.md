# Hyperpipe Plugin Framework v1

## Status
Implemented foundation:
- Plugin supervisor in Electron main process (`hyperpipe-desktop/electron/plugin-supervisor.cjs`)
- Out-of-process plugin runner (`hyperpipe-desktop/electron/plugin-runner.cjs`)
- Renderer plugin route/nav registry (`hyperpipe-desktop/src/providers/PluginRegistryProvider.tsx`)
- Dynamic plugin route support (`hyperpipe-desktop/src/routes.tsx`)
- Worker media capability layer (`hyperpipe-worker/media/*.mjs`)
- `.htplugin.tgz` archive installation/extraction path (`plugin-install-archive`)
- Marketplace discovery ingestion path (`plugin-marketplace-discover`)

## Manifest Shape
Primary schema lives in:
- `shared/plugins/PluginManifest.mjs`

Required fields:
- `id` (reverse DNS style, used for namespace)
- `name`
- `version`
- `engines.hyperpipe`, `engines.worker`, `engines.renderer`, `engines.mediaApi`
- `permissions[]`
- `contributions.navItems[]`
- `contributions.routes[]`

Important constraints:
- Route paths must be namespaced under `/plugins/<pluginId>/*`.
- Nav item `routePath` must also be within `/plugins/<pluginId>/*`.
- Unknown permission keys are rejected.

## Supported Permission Keys
- `renderer.nav`
- `renderer.route`
- `nostr.read`
- `nostr.publish`
- `p2p.session`
- `media.session`
- `media.record`
- `media.transcode`

## Plugin Packaging Convention (v1)
Recommended package layout:
- `manifest.json`
- `dist/runner.mjs`
- `src/**`
- `README.md`
- `checksums.sha256`
- `sbom.spdx.json`

Current installer status:
- Manifest install via IPC (`plugin-install`)
- Archive install via IPC (`plugin-install-archive`) for `.htplugin.tgz` / `.tgz`
  - Preflight checks:
    - archive size and entry-count limits
    - archive path traversal and blocked path segment checks
    - archive type checks (rejects symlink/hardlink/device entries)
    - extracted file-count and byte-size limits
    - manifest size limit
    - symlink/special-file rejection in extracted payload
  - Extracts package to temporary workspace
  - Validates manifest contract
  - Verifies integrity SHA-256:
    - `integrity.bundleSha256` must match packaged runtime bundle artifact
    - `integrity.sourceSha256` must match `src/` hash (when present)
  - Installs package content into `hyperpipe-data/plugins/<id>/<version>/`
  - Records archive provenance hash (`archiveSha256`) in plugin source metadata
 - Archive preview via IPC (`plugin-preview-archive`)
   - Returns manifest + contributions + permissions + integrity summary before install

Plugin authoring CLI:
- `shared/plugins/sdk/htplugin-cli.mjs`
- Commands:
  - `init` (scaffold plugin template)
  - `build` (run plugin build script or fallback copy)
  - `validate` (manifest + integrity contract checks)
  - `pack` (build + validate + deterministic `.htplugin.tgz`)
- One-command package flow:
  - `node shared/plugins/sdk/htplugin-cli.mjs pack <pluginDir>`

## IPC Surface
Preload exposes:
- Plugin lifecycle: `listPlugins`, `discoverPlugin`, `installPlugin`, `uninstallPlugin`, `enablePlugin`, `disablePlugin`
- Approval/policy: `approvePluginVersion`, `elevatePluginTier`
- Rejection/policy: `rejectPluginVersion`
- Observability: `getPluginAudit`, `onPluginEvent`
- UI contributions: `getPluginUIContributions`
- Invocation: `invokePlugin`
- Media bridge: `mediaCommand`
- Marketplace bridge: `discoverMarketplacePlugins`
- Marketplace install bridge: `installMarketplacePlugin`

## Renderer Extension Model
Implemented:
- Additive sidebar contributions via plugin nav items.
- Additive route contributions under `/plugins/<pluginId>/*`.
- Plugin management page under `/settings/plugins`:
  - archive upload + inspection
  - install with manifest/permission preview
  - per-version approve/reject
  - enable/disable/uninstall actions
  - marketplace discovery from Nostr + Hyperdrive metadata
  - install-from-listing action (downloads archive via worker then runs hardened archive installer)
- Route host supports:
  - `iframeSrc` routes
  - plugin-runner `render-route` responses that return HTML (`{ html: string }`)

Not implemented in v1:
- Core route/component replacement.

## Worker Media Commands
Implemented commands:
- Session: `media-create-session`, `media-join-session`, `media-leave-session`, `media-list-sessions`, `media-get-session`
- Signaling: `media-send-signal`
- Metadata: `media-update-stream-metadata`
- Recording: `media-start-recording`, `media-stop-recording`, `media-list-recordings`, `media-export-recording`
- Transcode: `media-transcode-recording` (host capability gated)
- Service health: `media-get-service-status`, `media-get-stats`
- Aliases: `p2p-create-session`, `p2p-join-session`, `p2p-leave-session`, `p2p-send-signal`

Emitted events:
- `media-session-created`
- `media-session-participant-joined`
- `media-session-participant-left`
- `media-session-stream-updated`
- `media-session-signal`
- `media-recording-started`
- `media-recording-stopped`
- `media-recording-exported`
- `media-recording-transcoded`
- `media-error`

## Marketplace Discovery (v1)
Worker command:
- `plugin-marketplace-discover`
- `plugin-marketplace-download`

Worker module:
- `hyperpipe-worker/plugins/PluginMarketplaceService.mjs`

Pipeline behavior:
- Queries Nostr relays for plugin announcement events (default kind `37130`)
- Parses manifest hints from event content and tags
- Parses Hyperdrive metadata (`hyper://...` source fields/tags)
- Attempts manifest hydration from:
  - embedded content (`content.manifest`)
  - `manifestUrl` over HTTP(S)
  - Hyperdrive URL (`hyper://<driveKey>/manifest.json` or provided manifest path)
- Returns normalized listings to Electron main
- Electron ingests listings into supervisor state via `discoverPlugin`
- Electron install flow:
  - renderer submits selected listing
  - main asks worker to download bundle archive (`http(s)` / `hyper://` / local archive path)
  - supervisor installs via `plugin-install-archive` hardened path

## Safety Defaults
- New plugins are `restricted` tier and disabled by default.
- Plugin version must be explicitly approved before enabling.
- Plugin runners are isolated in separate child processes.
- Renderer module loader bridge is now allowlisted in preload.
- Plugin-origin worker commands are deny-by-default unless:
  - command is allowlisted, and
  - plugin is enabled + approved, and
  - plugin has required permission for the command.
