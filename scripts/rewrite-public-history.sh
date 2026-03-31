#!/usr/bin/env bash
set -euo pipefail

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo is required. Install it first, for example:"
  echo "  python3 -m pip install --user git-filter-repo"
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "This will rewrite git history in-place."
echo "Make sure you have a fresh mirror backup before continuing."

git filter-repo \
  --force \
  --invert-paths \
  --path .DS_Store \
  --path-glob '*/.DS_Store' \
  --path-glob '*/node_modules/*' \
  --path hyperpipe-worker/data/relay-profiles.json \
  --path hyperpipe-core/data/relay-profiles.json \
  --path hyperpipe-gateway/deploy/runtime/.env

echo "History rewrite complete."
echo "Next steps:"
echo "  1. Re-add the correct origin URL if needed."
echo "  2. Force-push rewritten branches and tags after review."
echo "  3. Ask collaborators to reclone or hard-reset to the rewritten history."
