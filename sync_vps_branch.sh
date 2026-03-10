#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./sync_vps_branch.sh [options]

Sync the current local branch (or --branch) to a remote VPS checkout by:
1) verifying local HEAD is pushed to origin
2) resetting remote checkout to origin/<branch>
3) optionally reinstalling hypertuna-worker + hypertuna-tui dependencies
4) printing final branch/head/status verification

Options:
  --branch <name>        Branch to sync (default: current local branch)
  --host <ssh-target>    SSH target (default: squip@24.199.122.164)
  --repo <remote-path>   Remote repo path
                         (default: /home/squip/hypertuna-tui-direct-join-test/hypertuna-electron-dev-phase9)
  --node-version <ver>   Node version for nvm use on VPS (default: 23.11.0)
  --skip-install         Skip npm install/ci on VPS
  --preserve-path <path> Preserve a remote repo path across sync (repeatable)
                         Example:
                           --preserve-path deploy/docker-compose.yml \
                           --preserve-path public-gateway/src/utils/stdout-log-rotator.mjs
  --allow-unpushed       Allow syncing even if local HEAD != origin/<branch>
  -h, --help             Show this help

Examples:
  ./sync_vps_branch.sh
  ./sync_vps_branch.sh --branch direct-join-integration-phase9
  ./sync_vps_branch.sh --branch public-gateway-router-phase8 \
    --preserve-path deploy/docker-compose.yml \
    --preserve-path public-gateway/src/utils/stdout-log-rotator.mjs
  ./sync_vps_branch.sh --repo /home/squip/hypertuna-tui-direct-join-test/hypertuna-electron-dev
USAGE
}

HOST="squip@24.199.122.164"
REMOTE_REPO="/home/squip/hypertuna-tui-direct-join-test/hypertuna-electron-dev-phase9"
NODE_VERSION="23.11.0"
SKIP_INSTALL="0"
ALLOW_UNPUSHED="0"
BRANCH=""
PRESERVE_PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --repo)
      REMOTE_REPO="${2:-}"
      shift 2
      ;;
    --node-version)
      NODE_VERSION="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL="1"
      shift
      ;;
    --preserve-path)
      PRESERVE_PATHS+=("${2:-}")
      shift 2
      ;;
    --allow-unpushed)
      ALLOW_UNPUSHED="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this script from inside your local git repo." >&2
  exit 1
fi

if [[ -z "${BRANCH}" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

echo "== Local checks =="
echo "Branch: ${BRANCH}"
LOCAL_HEAD="$(git rev-parse "${BRANCH}")"
echo "Local HEAD: ${LOCAL_HEAD}"

git fetch origin "${BRANCH}" >/dev/null 2>&1 || {
  echo "Failed to fetch origin/${BRANCH}. Push branch first?" >&2
  exit 1
}
ORIGIN_HEAD="$(git rev-parse "origin/${BRANCH}")"
echo "Origin HEAD: ${ORIGIN_HEAD}"

if [[ "${ALLOW_UNPUSHED}" != "1" && "${LOCAL_HEAD}" != "${ORIGIN_HEAD}" ]]; then
  echo "Local HEAD does not match origin/${BRANCH}." >&2
  echo "Push your branch first, or rerun with --allow-unpushed." >&2
  exit 1
fi

echo
echo "== Remote sync =="
echo "Host: ${HOST}"
echo "Repo: ${REMOTE_REPO}"
echo "Install deps: $([[ "${SKIP_INSTALL}" == "1" ]] && echo no || echo yes)"
if [[ ${#PRESERVE_PATHS[@]} -gt 0 ]]; then
  echo "Preserve paths (${#PRESERVE_PATHS[@]}):"
  for preserve_path in "${PRESERVE_PATHS[@]}"; do
    echo "  - ${preserve_path}"
  done
fi

ssh "${HOST}" bash -s -- "${REMOTE_REPO}" "${BRANCH}" "${NODE_VERSION}" "${SKIP_INSTALL}" "${PRESERVE_PATHS[@]}" <<'REMOTE'
set -euo pipefail

REMOTE_REPO="${1}"
BRANCH="${2}"
NODE_VERSION="${3}"
SKIP_INSTALL="${4}"
shift 4
PRESERVE_PATHS=("$@")

cd "${REMOTE_REPO}"
if [[ ! -d .git ]]; then
  echo "Remote path is not a git repo: ${REMOTE_REPO}" >&2
  exit 1
fi

PRESERVE_STASH_REF=""
if [[ ${#PRESERVE_PATHS[@]} -gt 0 ]]; then
  echo "Preparing preserve stash for selected remote paths..."
  for preserve_path in "${PRESERVE_PATHS[@]}"; do
    echo "  - ${preserve_path}"
  done

  PRESERVE_STASH_MSG="sync-preserve:${BRANCH}:$(date +%s):$$"
  set +e
  STASH_OUTPUT="$(git stash push --include-untracked -m "${PRESERVE_STASH_MSG}" -- "${PRESERVE_PATHS[@]}" 2>&1)"
  STASH_EXIT=$?
  set -e

  if [[ ${STASH_EXIT} -ne 0 ]]; then
    echo "Failed to stash preserve paths." >&2
    echo "${STASH_OUTPUT}" >&2
    exit 1
  fi

  PRESERVE_STASH_REF="$(git stash list --format='%gd %gs' | awk -v msg="${PRESERVE_STASH_MSG}" '$0 ~ msg { print $1; exit }')"
  if [[ -n "${PRESERVE_STASH_REF}" ]]; then
    echo "Preserve stash created: ${PRESERVE_STASH_REF}"
  else
    echo "No local changes found for preserve paths."
  fi
fi

git fetch origin --prune "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"

if ! git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  echo "Remote branch not found on origin: ${BRANCH}" >&2
  exit 1
fi

# Robust for single-branch clones: always recreate/reset local branch from
# the explicit remote-tracking ref we just fetched.
git checkout -B "${BRANCH}" "refs/remotes/origin/${BRANCH}"
# Best effort: wire upstream for ergonomics.
git branch --set-upstream-to "origin/${BRANCH}" "${BRANCH}" >/dev/null 2>&1 || true

# Force exact parity with origin branch.
git reset --hard "origin/${BRANCH}"
git clean -fd

if [[ -n "${PRESERVE_STASH_REF}" ]]; then
  echo "Restoring preserved paths from ${PRESERVE_STASH_REF}..."
  git restore --source "${PRESERVE_STASH_REF}" -- "${PRESERVE_PATHS[@]}"
  git stash drop "${PRESERVE_STASH_REF}" >/dev/null 2>&1 || true
fi

if [[ "${SKIP_INSTALL}" != "1" ]]; then
  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "${HOME}/.nvm/nvm.sh"
    nvm use "${NODE_VERSION}" >/dev/null
  else
    echo "Warning: nvm not found at ${HOME}/.nvm/nvm.sh; using system node." >&2
  fi

  if [[ -d hypertuna-worker ]]; then
    cd hypertuna-worker
    if [[ -f package-lock.json ]]; then
      npm ci --no-audit --no-fund
    else
      npm install --no-audit --no-fund
    fi
    cd ..
  fi

  if [[ -d hypertuna-tui ]]; then
    cd hypertuna-tui
    if [[ -f package-lock.json ]]; then
      npm ci --no-audit --no-fund
    else
      npm install --no-audit --no-fund
    fi
    cd ..
  fi
fi

echo "FINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)"
echo "FINAL_HEAD=$(git rev-parse HEAD)"
echo "FINAL_STATUS=$(git status --porcelain | wc -l | tr -d ' ')"
REMOTE

echo
echo "Sync complete."
