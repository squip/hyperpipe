# Hyperpipe

Hyperpipe is a monorepo for the first-party packages and applications that make up
the Hyperpipe stack. This repository is the canonical source of truth; public
package publication and public repo mirroring flow out of this repo.

## Workspaces

- `hyperpipe-bridge` -> `@squip/hyperpipe-bridge`
- `hyperpipe-core` -> `@squip/hyperpipe-core`
- `hyperpipe-core-host` -> `@squip/hyperpipe-core-host`
- `hyperpipe-desktop`
- `hyperpipe-tui`
- `hyperpipe-gateway`

## Development

```bash
npm install
```

Common entrypoints:

- `npm test --workspace hyperpipe-core`
- `npm test --workspace hyperpipe-tui`
- `npm run build:web --workspace hyperpipe-desktop`
- `npm test --workspace hyperpipe-gateway`

Lockfile policy:

- the root `package-lock.json` is the canonical lockfile for this monorepo
- workspace package lockfiles are not tracked in the monorepo
- use `npm install` or `npm ci` from the repository root for normal development and CI

## Policies

- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Licensing Notes](./LICENSES.md)

## Release Model

- `@squip/hyperpipe-bridge`, `@squip/hyperpipe-core`, and
  `@squip/hyperpipe-core-host` are published from this monorepo.
- `hyperpipe-desktop` is distributed as downloadable Electron artifacts.
- `hyperpipe-tui` is distributed as portable bundles first, with npm publication
  available as a secondary path later.
- `hyperpipe-gateway` is distributed as a public repo plus container image, not as
  an npm package.
