# Public Mirror Sync

Hyperpipe public repos are synchronized mirrors of subdirectories from the canonical
monorepo. The automation for that sync lives in:

- `.github/workflows/sync-public-mirrors.yml`
- `scripts/sync-public-mirror.sh`

## Mirror Targets

- `hyperpipe-bridge` -> `squip/hyperpipe-bridge`
- `hyperpipe-core` -> `squip/hyperpipe-core`
- `hyperpipe-core-host` -> `squip/hyperpipe-core-host`
- `hyperpipe-desktop` -> `squip/hyperpipe-desktop`
- `hyperpipe-tui` -> `squip/hyperpipe-tui`
- `hyperpipe-gateway` -> `squip/hyperpipe-gateway`

## Trigger Model

- automatic sync on pushes to `main`
- manual sync via `workflow_dispatch`
- optional manual dry-run mode for validation before a real push

## Required Secret

Set this secret in the canonical `squip/hyperpipe` repository:

- `PUBLIC_MIRROR_PUSH_TOKEN`

That token must have write access to the target mirror repositories.

## Overlay Files

Each mirror is generated from its workspace subtree and then overlaid with the
shared public-repo policy files from the monorepo root:

- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `.github/ISSUE_TEMPLATE/*`
- `.github/pull_request_template.md`

This keeps the mirror repos aligned with the canonical contribution and security
policy without duplicating those files by hand in every workspace.

## Local Dry Run

You can validate a mirror build locally without pushing:

```bash
./scripts/sync-public-mirror.sh \
  --prefix hyperpipe-core \
  --target squip/hyperpipe-core \
  --ref HEAD \
  --dry-run
```

For local testing against a bare repo path:

```bash
git init --bare /tmp/hyperpipe-core.git
./scripts/sync-public-mirror.sh \
  --prefix hyperpipe-core \
  --target /tmp/hyperpipe-core.git \
  --branch main \
  --ref HEAD
```
