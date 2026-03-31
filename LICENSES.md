# Licensing Notes

This monorepo currently contains multiple first-party components with package-specific
license files and metadata.

Current workspace licensing:

- `hyperpipe-core`: Apache-2.0
- `hyperpipe-core-host`: Apache-2.0
- `hyperpipe-bridge`: Apache-2.0
- `hyperpipe-desktop`: MIT

Workspaces that should receive an explicit standalone license decision before public
mirror launch:

- `hyperpipe-tui`
- `hyperpipe-gateway`

Until that decision is finalized, refer to the package-level metadata and license
files that already ship with each workspace instead of assuming a single monorepo-wide
license.
