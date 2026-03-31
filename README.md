# Hyperpipe

Canonical Hyperpipe monorepo.

This repository contains the first-party packages and applications that make up the
Hyperpipe stack:

- `hyperpipe-bridge` -> `@hyperpipe/bridge`
- `hyperpipe-core` -> `@hyperpipe/core`
- `hyperpipe-core-host` -> `@hyperpipe/core-host`
- `hyperpipe-desktop`
- `hyperpipe-tui`
- `hyperpipe-gateway`

Public package publication and public repo mirroring flow out of this monorepo. The
monorepo remains the source of truth.

Installation policy:

- the root `package-lock.json` is the canonical lockfile for this monorepo
- workspace package lockfiles are not tracked in the monorepo
- use `npm install` or `npm ci` from the repository root for normal development and CI
