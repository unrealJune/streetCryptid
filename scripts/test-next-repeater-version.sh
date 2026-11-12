#!/usr/bin/env bash

# Exercise scripts/next-repeater-version.sh against a throwaway repository shaped like this one: an
# app history, the repeater server's history merged in beside it, and commits to every product
# afterwards. The server half runs first; the Windows half reuses the same history.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-repeater-version-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

new_repo() {
  git init --quiet "$1"
  git -C "$1" config user.email "release-test@example.com"
  git -C "$1" config user.name "Release Test"
  git -C "$1" config core.autocrlf false
}

work="$test_root/repo"
new_repo "$work"
mkdir -p "$work/scripts/lib"
cp "$repo_root/scripts/next-repeater-version.sh" "$work/scripts/"
cp "$repo_root/scripts/lib/conventional-commits.sh" "$work/scripts/lib/"

commit_in() {
  local repo="$1" path="$2" message="$3"
  mkdir -p "$repo/$(dirname "$path")"
  echo "$message" >> "$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" commit --quiet -m "$message"
}

field() {
  sed -n "s/^$1=//p" <<<"$2"
}

expect() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

next() {
  (cd "$work" && bash scripts/next-repeater-version.sh server "$@")
}

assert_bump() {
  local label="$1" release="$2" bump="$3" version="$4"
  shift 4
  local output
  output="$(next "$@")"
  expect "$label release" "$release" "$(field release "$output")"
  expect "$label bump" "$bump" "$(field bump "$output")"
  expect "$label version" "$version" "$(field version "$output")"
  expect "$label tag" "server-v$version" "$(field tag "$output")"
}

# The app, with a release of its own and plenty of history touching the shared workspace files.
commit_in "$work" src/app.ts "feat: the app"
commit_in "$work" Cargo.lock "fix(native): an app dependency"
git -C "$work" tag v1.0.0

assert_bump "no server tag yet" true initial 0.1.0

# The server's own history, tagged in its old repository, imported beside the app.
server="$test_root/server"
new_repo "$server"
commit_in "$server" repeater/server/src/main.rs "feat: the stash"
git -C "$server" tag server-v0.3.0
commit_in "$server" repeater/protocol/src/lib.rs "feat(repeater): claim by camera"
git -C "$work" fetch --quiet "$server" HEAD 'refs/tags/*:refs/tags/*'
git -C "$work" merge --quiet --allow-unrelated-histories --no-edit -m "import the server" FETCH_HEAD

# The app's past touched Cargo.lock, but it was never the server's: only the unreleased server
# commit counts.
assert_bump "the app's history is not the server's" true minor 0.4.0
git -C "$work" tag server-v0.4.0
assert_bump "nothing since the tag" false none 0.4.0

commit_in "$work" src/map.ts "feat(map): an app feature"
commit_in "$work" modules/iroh-location/rust/src/lib.rs "fix(native): an app fix"
commit_in "$work" repeater/windows/app/App.cs "feat(windows): a desktop feature"
assert_bump "app and windows commits" false none 0.4.0

commit_in "$work" repeater/server/charts/trail-stash/values.yaml "docs(chart): explain a value"
commit_in "$work" repeater/server/src/main.rs "refactor(server): rename"
assert_bump "housekeeping only" false none 0.4.0

commit_in "$work" repeater/server/charts/trail-stash/values.yaml "fix(chart): a probe timeout"
assert_bump "the chart ships too" true patch 0.4.1

for path in Cargo.lock Cargo.toml rust-toolchain.toml third_party/noq/src/lib.rs .dockerignore; do
  git -C "$work" tag -f server-v0.4.1 >/dev/null
  commit_in "$work" "$path" "fix(build): $path"
  assert_bump "workspace input $path" true patch 0.4.2
done

commit_in "$work" repeater/protocol/src/lib.rs "feat(protocol): a new op"
assert_bump "the protocol is linked" true minor 0.5.0

commit_in "$work" repeater/server/src/main.rs "$(printf 'fix(server): drop the v0 API\n\nBREAKING CHANGE: v0 clients must upgrade.')"
assert_bump "breaking change" true major 1.0.0

assert_bump "forced patch" true forced-patch 0.4.2 --force patch
if next --force sideways >/dev/null 2>&1; then
  echo "An unknown --force level was accepted." >&2
  exit 1
fi

# An app tag is never the server's previous release.
git -C "$work" tag v9.9.9
expect "previous tag ignores app tags" server-v0.4.1 "$(field previous_tag "$(next)")"

# --- Windows --------------------------------------------------------------------------------

next_windows() {
  (cd "$work" && bash scripts/next-repeater-version.sh windows "$@")
}

assert_windows() {
  local label="$1" release="$2" bump="$3" version="$4"
  shift 4
  local output
  output="$(next_windows "$@")"
  expect "windows $label release" "$release" "$(field release "$output")"
  expect "windows $label bump" "$bump" "$(field bump "$output")"
  expect "windows $label version" "$version" "$(field version "$output")"
  expect "windows $label tag" "windows-v$version" "$(field tag "$output")"
}

assert_windows "no windows tag yet" true initial 0.1.0-preview.1
git -C "$work" tag windows-v0.1.0-preview.3
assert_windows "nothing since the tag" false none 0.1.0-preview.3

commit_in "$work" src/app.ts "feat: an app feature"
commit_in "$work" repeater/server/charts/trail-stash/values.yaml "fix(chart): only the image ships this"
commit_in "$work" .dockerignore "fix(build): only the image reads this"
assert_windows "app, chart and image-only commits" false none 0.1.0-preview.3

commit_in "$work" repeater/windows/app/MainWindow.xaml.cs "fix(windows): a desktop fix"
assert_windows "a desktop fix" true patch 0.1.1-preview.1

git -C "$work" tag windows-v0.1.1-preview.1
commit_in "$work" repeater/server/src/node.rs "feat(server): the host links this"
assert_windows "the server crate is linked" true minor 0.2.0-preview.1

git -C "$work" tag windows-v0.2.0-preview.1
commit_in "$work" assets/images/mothman-logo.svg "fix: the sigil the icon is drawn from"
assert_windows "the icon's source" true patch 0.2.1-preview.1

assert_windows "forced minor" true forced-minor 0.3.0-preview.1 --force minor
expect "windows previous tag" windows-v0.2.0-preview.1 "$(field previous_tag "$(next_windows)")"

if (cd "$work" && bash scripts/next-repeater-version.sh desktop >/dev/null 2>&1); then
  echo "An unknown product was accepted." >&2
  exit 1
fi

echo "Repeater versioning resolved every release scenario, for the server and for Windows."
