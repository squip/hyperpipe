# Release Secrets and Credentials

This repository can build and publish most release artifacts without additional
credentials, but the final production release flow depends on a small set of
secrets that must be configured outside git.

## Required Secrets

### Public Mirror Sync

The `Sync Public Mirrors` workflow requires:

- `PUBLIC_MIRROR_PUSH_TOKEN`

This token must have write access to the public mirror repositories:

- `squip/hyperpipe-bridge`
- `squip/hyperpipe-core`
- `squip/hyperpipe-core-host`
- `squip/hyperpipe-desktop`
- `squip/hyperpipe-tui`
- `squip/hyperpipe-gateway`

Recommended setup:

- create a dedicated GitHub personal access token for mirror syncing
- scope it to repo contents write access for the mirror repos only
- store it as the `PUBLIC_MIRROR_PUSH_TOKEN` secret in `squip/hyperpipe`

### Desktop Signing and Notarization

The `Release Desktop` workflow reads these secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

These values are used for:

- Windows/macOS signing material via `CSC_LINK` and `CSC_KEY_PASSWORD`
- Apple notarization via `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`

If these secrets are unset:

- release builds can still run
- unsigned artifacts may be produced
- macOS notarization will not succeed

## npm Publishing

The published packages are:

- `@squip/hyperpipe-bridge`
- `@squip/hyperpipe-core`
- `@squip/hyperpipe-core-host`

For browser-based publishing, the npm account can use the normal login flow.
For non-interactive publishing, use a dedicated npm token with package publish
permission. If the npm account enforces `auth-and-writes`, use either:

- an authenticator-backed OTP flow during `npm publish`
- or a token configuration that is allowed to bypass the interactive 2FA prompt

Do not store personal throwaway tokens in the repo or in shell history.

## Current Manual Release Checklist

1. Confirm the package versions to publish.
2. Publish `@squip/hyperpipe-bridge`, `@squip/hyperpipe-core`, and `@squip/hyperpipe-core-host` as needed.
3. Tag the monorepo with the appropriate namespaced release tag.
4. Ensure desktop signing/notarization secrets are present before running desktop release jobs.
5. Ensure `PUBLIC_MIRROR_PUSH_TOKEN` is configured before enabling automatic mirror sync from `main`.
