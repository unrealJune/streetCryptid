#!/usr/bin/env bash

# Decide which CI lanes a change needs: the app, the repeater server, the Windows repeater.
#
# A path-filtered workflow that does not run leaves a required check pending forever, so `ci.yml`
# always runs and asks this script instead. The rules (docs/MONOREPO.md, "CI"):
#
#   repeater/server/**, .dockerignore (the server image's)   -> server
#   repeater/windows/**                                      -> windows
#   repeater/protocol/**, Cargo.toml, Cargo.lock,
#   rust-toolchain.toml, third_party/**, .github/**,
#   this script, any other repeater/ path                    -> every lane
#   anything else                                            -> app
#
# "Anything else" is deliberately the app: Prettier checks Markdown and YAML wherever they live,
# so a docs-only change still needs the app lane's Format job. Only a change confined to one
# repeater product skips the mobile suite.
#
# Usage:
#   scripts/ci-changes.sh <base-sha> [<head-sha>]   diff from the merge base of base and head
#   scripts/ci-changes.sh --paths                   read changed paths from stdin (tests)
#
# A base that is empty, all zeros (a new branch) or not in the local history runs every lane:
# not knowing what changed must never skip a check.
#
# Prints `app=`, `server=`, `windows=` (true|false) on stdout, for $GITHUB_OUTPUT.

set -euo pipefail

all() {
  printf 'app=true\nserver=true\nwindows=true\n'
}

classify() {
  local app=false server=false windows=false path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      repeater/server/* | .dockerignore) server=true ;;
      repeater/windows/*) windows=true ;;
      repeater/protocol/* | Cargo.toml | Cargo.lock | rust-toolchain.toml | third_party/* | \
        .github/* | scripts/ci-changes.sh | repeater/*)
        app=true
        server=true
        windows=true
        ;;
      *) app=true ;;
    esac
  done
  printf 'app=%s\nserver=%s\nwindows=%s\n' "$app" "$server" "$windows"
}

if [[ "${1:-}" == '--paths' ]]; then
  classify
  exit 0
fi

base="${1:-}"
head="${2:-HEAD}"

if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "No usable base ('$base'); running every lane." >&2
  all
  exit 0
fi

if ! merge_base="$(git merge-base "$base" "$head" 2>/dev/null)"; then
  echo "No merge base between $base and $head; running every lane." >&2
  all
  exit 0
fi

git diff --name-only --no-renames "$merge_base" "$head" | classify
