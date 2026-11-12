#!/usr/bin/env bash

# Exercise scripts/ci-changes.sh: the path rules, and the fallbacks that must run every lane.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/ci-changes.sh"

expect() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf '%s: expected\n%s\ngot\n%s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

lanes() {
  printf 'app=%s\nserver=%s\nwindows=%s' "$1" "$2" "$3"
}

paths() {
  printf '%s\n' "$@" | bash "$script" --paths
}

expect "nothing changed" "$(lanes false false false)" "$(printf '' | bash "$script" --paths)"
expect "app source" "$(lanes true false false)" "$(paths src/app/index.tsx)"
expect "mobile crate" "$(lanes true false false)" "$(paths modules/iroh-location/rust/src/lib.rs)"
expect "docs still format-checked" "$(lanes true false false)" "$(paths docs/MONOREPO.md)"
expect "server only" "$(lanes false true false)" "$(paths repeater/server/src/lib.rs repeater/server/charts/trail-stash/values.yaml)"
expect "the image's ignore file" "$(lanes false true false)" "$(paths .dockerignore)"
expect "the Windows icon's source" "$(lanes true false true)" "$(paths assets/images/mothman-logo.svg)"
expect "windows only" "$(lanes false false true)" "$(paths repeater/windows/app/App.xaml.cs)"
expect "server and windows" "$(lanes false true true)" "$(paths repeater/server/Dockerfile repeater/windows/justfile)"
expect "protocol" "$(lanes true true true)" "$(paths repeater/protocol/src/roster.rs)"
expect "root lockfile" "$(lanes true true true)" "$(paths Cargo.lock)"
expect "toolchain" "$(lanes true true true)" "$(paths rust-toolchain.toml)"
expect "shared third_party" "$(lanes true true true)" "$(paths third_party/noq/src/lib.rs)"
expect "workflows" "$(lanes true true true)" "$(paths .github/workflows/ci-repeater-server.yml)"
expect "the gate itself" "$(lanes true true true)" "$(paths scripts/ci-changes.sh)"
expect "unknown repeater path" "$(lanes true true true)" "$(paths repeater/README.md)"
expect "mixed" "$(lanes true true false)" "$(paths repeater/server/src/lib.rs package.json)"

# Against a real history: the merge base decides, and an unknown base runs everything.
work="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-ci-changes.XXXXXX")"
trap 'rm -rf "$work"' EXIT
git -C "$work" init --quiet
git -C "$work" config user.email "ci-test@example.com"
git -C "$work" config user.name "CI Test"
git -C "$work" config core.autocrlf false
mkdir -p "$work/src" "$work/repeater/server"
echo a > "$work/src/a.ts"
git -C "$work" add -A && git -C "$work" commit --quiet -m base
base="$(git -C "$work" rev-parse HEAD)"
git -C "$work" checkout --quiet -b topic
echo b > "$work/repeater/server/b.rs"
git -C "$work" add -A && git -C "$work" commit --quiet -m server
git -C "$work" checkout --quiet -
# main moves on after the branch point; its change must not leak into the branch's lanes.
echo c > "$work/src/c.ts"
git -C "$work" add -A && git -C "$work" commit --quiet -m main
main="$(git -C "$work" rev-parse HEAD)"

run() { (cd "$work" && bash "$script" "$@" 2>/dev/null); }
expect "branch diffs from the merge base" "$(lanes false true false)" "$(run "$main" topic)"
expect "push diffs from before" "$(lanes true false false)" "$(run "$base" "$main")"
expect "new branch" "$(lanes true true true)" "$(run 0000000000000000000000000000000000000000 topic)"
expect "empty base" "$(lanes true true true)" "$(run '' topic)"
expect "unknown base" "$(lanes true true true)" "$(run 1234567890abcdef1234567890abcdef12345678 topic)"

echo "CI lane selection resolved every scenario."
