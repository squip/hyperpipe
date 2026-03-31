#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sync-public-mirror.sh --prefix <workspace-dir> --target <owner/repo|remote-url|local-path> [options]

Options:
  --branch <name>     Target branch name. Defaults to "main".
  --ref <git-ref>     Source ref in the monorepo. Defaults to "HEAD".
  --token <token>     GitHub token used when --target is an owner/repo slug.
  --dry-run           Prepare the mirror tree but do not push.
  -h, --help          Show this help text.

Environment:
  MIRROR_PUSH_TOKEN   Default token value when --token is not provided.
  GIT_USER_NAME       Commit author name for synthetic overlay commits.
  GIT_USER_EMAIL      Commit author email for synthetic overlay commits.
EOF
}

PREFIX=""
TARGET=""
BRANCH="main"
REF="HEAD"
TOKEN="${MIRROR_PUSH_TOKEN:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PREFIX" || -z "$TARGET" ]]; then
  usage >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_USER_NAME="${GIT_USER_NAME:-github-actions[bot]}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

WORKTREE_DIR=""
TMP_ROOT=""

cleanup() {
  if [[ -n "$WORKTREE_DIR" && -d "$WORKTREE_DIR" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

sync_overlay_file() {
  local source_path="$1"
  local destination_path="$2"

  if [[ -f "$source_path" ]]; then
    mkdir -p "$(dirname "$destination_path")"
    cp "$source_path" "$destination_path"
  else
    rm -f "$destination_path"
  fi
}

resolve_target_url() {
  if [[ "$TARGET" == http://* || "$TARGET" == https://* || "$TARGET" == git@* || "$TARGET" == file:* || "$TARGET" == /* || "$TARGET" == ./* || "$TARGET" == ../* ]]; then
    printf '%s\n' "$TARGET"
    return
  fi

  if [[ "$TARGET" == */* ]]; then
    if [[ -z "$TOKEN" ]]; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        printf 'https://github.com/%s.git\n' "$TARGET"
        return
      fi
      printf 'Mirror target %s requires --token or MIRROR_PUSH_TOKEN\n' "$TARGET" >&2
      exit 1
    fi
    printf 'https://x-access-token:%s@github.com/%s.git\n' "$TOKEN" "$TARGET"
    return
  fi

  printf 'Unsupported mirror target: %s\n' "$TARGET" >&2
  exit 1
}

printf '[mirror] splitting %s from %s at ref %s\n' "$PREFIX" "$REPO_ROOT" "$REF"
SPLIT_SHA="$(git -C "$REPO_ROOT" subtree split --prefix="$PREFIX" "$REF" 2>/dev/null)"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hyperpipe-mirror.XXXXXX")"
WORKTREE_DIR="$TMP_ROOT/worktree"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE_DIR" "$SPLIT_SHA" >/dev/null 2>&1

sync_overlay_file "$REPO_ROOT/SECURITY.md" "$WORKTREE_DIR/SECURITY.md"
sync_overlay_file "$REPO_ROOT/CODE_OF_CONDUCT.md" "$WORKTREE_DIR/CODE_OF_CONDUCT.md"
sync_overlay_file "$REPO_ROOT/CONTRIBUTING.md" "$WORKTREE_DIR/CONTRIBUTING.md"
sync_overlay_file "$REPO_ROOT/.github/ISSUE_TEMPLATE/bug_report.yml" "$WORKTREE_DIR/.github/ISSUE_TEMPLATE/bug_report.yml"
sync_overlay_file "$REPO_ROOT/.github/ISSUE_TEMPLATE/feature_request.yml" "$WORKTREE_DIR/.github/ISSUE_TEMPLATE/feature_request.yml"
sync_overlay_file "$REPO_ROOT/.github/ISSUE_TEMPLATE/config.yml" "$WORKTREE_DIR/.github/ISSUE_TEMPLATE/config.yml"
sync_overlay_file "$REPO_ROOT/.github/pull_request_template.md" "$WORKTREE_DIR/.github/pull_request_template.md"

if [[ -n "$(git -C "$WORKTREE_DIR" status --porcelain --untracked-files=all)" ]]; then
  git -C "$WORKTREE_DIR" add -A
  git -C "$WORKTREE_DIR" \
    -c user.name="$GIT_USER_NAME" \
    -c user.email="$GIT_USER_EMAIL" \
    commit -m "Sync shared repo policy files from monorepo"
fi

REMOTE_URL="$(resolve_target_url)"
FINAL_SHA="$(git -C "$WORKTREE_DIR" rev-parse HEAD)"

printf '[mirror] prepared %s -> %s (%s)\n' "$PREFIX" "$TARGET" "$FINAL_SHA"

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '[mirror] dry-run enabled; skipping push to %s\n' "$TARGET"
  exit 0
fi

# actions/checkout configures a GitHub auth extraheader for the workflow token.
# Clear it so the explicit mirror push token in the remote URL is the credential
# used for cross-repo pushes.
git -C "$WORKTREE_DIR" config --local --unset-all http.https://github.com/.extraheader >/dev/null 2>&1 || true

git -C "$WORKTREE_DIR" push --force "$REMOTE_URL" "HEAD:refs/heads/$BRANCH"
printf '[mirror] pushed %s to %s@%s\n' "$PREFIX" "$TARGET" "$BRANCH"
