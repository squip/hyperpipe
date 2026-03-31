# Contributing

The `hyperpipe` monorepo is the canonical source of truth for all first-party Hyperpipe
packages and applications.

Repository policy:

- Development happens in this monorepo.
- Public repos are synchronized mirrors, not the authoritative development history.
- Versioning is package-specific and release tags are namespaced by package or app.

Current first-party packages:

- `@hyperpipe/bridge`
- `@hyperpipe/core`
- `@hyperpipe/core-host`

Current first-party applications:

- `hyperpipe-desktop`
- `hyperpipe-tui`
- `hyperpipe-gateway`

Release tags:

- `bridge-vX.Y.Z`
- `core-vX.Y.Z`
- `core-host-vX.Y.Z`
- `desktop-vX.Y.Z`
- `tui-vX.Y.Z`
- `gateway-vX.Y.Z`

Install policy:

- the root `package-lock.json` is the only tracked lockfile in this monorepo
- run `npm install` or `npm ci` from the monorepo root
- nested workspace `package-lock.json` files should not be committed
