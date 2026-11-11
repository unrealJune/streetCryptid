#!/usr/bin/env bash

# Exercise scripts/next-version.sh and scripts/apply-version.sh against a throwaway repository.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-version-test.XXXXXX")"

cleanup() {
  if [[ -d "$test_root" ]]; then
    chmod -R u+w "$test_root" 2>/dev/null || true
    rm -rf "$test_root"
  fi
}
trap cleanup EXIT

work="$test_root/repo"
mkdir -p "$work/scripts/lib"
cp "$repo_root/scripts/next-version.sh" "$repo_root/scripts/apply-version.sh" "$work/scripts/"
cp "$repo_root/scripts/lib/conventional-commits.sh" "$work/scripts/lib/"

write_manifests() {
  local version="$1"
  cat > "$work/app.json" <<EOF
{
  "expo": {
    "name": "streetCryptid",
    "version": "$version",
    "ios": {
      "bundleIdentifier": "com.unrealjune.streetcryptid"
    }
  }
}
EOF
  cat > "$work/package.json" <<EOF
{
  "name": "streetcryptid",
  "version": "$version",
  "private": true
}
EOF
}

# Every commit touches a file: next-version.sh scopes its range by path, and git prunes a commit
# that changes nothing from a path-limited log.
commit() {
  local message="$1"
  echo "$message" >> "$work/CHANGES"
  git -C "$work" add -A
  git -C "$work" commit --quiet -m "$message"
}

field() {
  local key="$1" output="$2"
  sed -n "s/^$key=//p" <<<"$output"
}

expect() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

next_version() {
  (cd "$work" && bash scripts/next-version.sh "$@")
}

assert_bump() {
  local label="$1" expected_release="$2" expected_bump="$3" expected_version="$4"
  shift 4
  local output
  output="$(next_version "$@")"
  expect "$label release" "$expected_release" "$(field release "$output")"
  expect "$label bump" "$expected_bump" "$(field bump "$output")"
  expect "$label version" "$expected_version" "$(field version "$output")"
}

git -C "$work" init --quiet
git -C "$work" config user.email "release-test@example.com"
git -C "$work" config user.name "Release Test"
write_manifests 1.0.0
git -C "$work" add -A
commit "chore: initial commit"

assert_bump "untagged repository" true initial 1.0.0
git -C "$work" tag v1.0.0

assert_bump "no releasable commits" false none 1.0.0
commit "docs: describe the release workflow"
commit "chore(deps): bump a dependency"
commit "ci: pin an action"
commit "refactor(map): rename a helper"
assert_bump "housekeeping only" false none 1.0.0

commit "move map controls above the island"
assert_bump "freeform subject" true patch 1.0.1

commit "fix(map): stop dropping tiles"
assert_bump "fix commit" true patch 1.0.1

commit "feat(social): add pairing dance"
assert_bump "feat outranks fix" true minor 1.1.0

assert_bump "forced major" true forced-major 2.0.0 --force major
assert_bump "forced patch" true forced-patch 1.0.1 --force patch

commit "refactor(net)!: drop the legacy relay handshake"
assert_bump "exclamation mark breaking change" true major 2.0.0

git -C "$work" tag v1.1.0
assert_bump "range starts at the newest tag" false none 1.0.0

commit "$(printf 'fix(net): retry relay dials\n\nBREAKING CHANGE: relay URLs must include a port.')"
assert_bump "breaking change footer" true major 2.0.0

# Merge commits carry a branch description rather than a Conventional Commit subject, so a merge
# must not be able to promote a release on its own.
git -C "$work" tag v1.2.0
git -C "$work" checkout --quiet -b topic
commit "chore: shuffle comments"
git -C "$work" checkout --quiet -
git -C "$work" merge --quiet --no-ff -m "feat: merge the topic branch" topic
assert_bump "merge subject ignored" false none 1.0.0

# The repeater products release under their own tags. A server tag is never the app's previous
# release, and a commit confined to repeater/server or repeater/windows never cuts a store release.
git -C "$work" tag v1.3.0
git -C "$work" tag server-v9.9.9
commit_in() {
  local path="$1" message="$2"
  mkdir -p "$work/$(dirname "$path")"
  echo "$message" >> "$work/$path"
  git -C "$work" add -A
  git -C "$work" commit --quiet -m "$message"
}
commit_in repeater/server/src/lib.rs "feat(server): a repeater feature"
commit_in repeater/windows/app/App.cs "fix(windows): a desktop fix"
assert_bump "server tags are not app releases" false none 1.0.0
expect "previous tag skips server-v" v1.3.0 "$(field previous_tag "$(next_version)")"

commit_in repeater/protocol/src/roster.rs "fix(protocol): the phone links this"
assert_bump "protocol changes still release the app" true patch 1.0.1

git -C "$work" tag v1.4.0
commit_in repeater/server/README.md "$(printf 'feat(server)!: drop the v0 API

BREAKING CHANGE: server only.')"
assert_bump "a breaking server change is not an app major" false none 1.0.0

# Another repository's history merged in with --allow-unrelated-histories is not the app's, even
# where it touches a path the app links (repeater/protocol): it never sat behind an app tag, so it
# would otherwise all land in one range. What is built on top of it afterwards still counts.
git -C "$work" tag v1.6.0
imported="$test_root/imported"
git init --quiet "$imported"
git -C "$imported" config user.email "import-test@example.com"
git -C "$imported" config user.name "Import Test"
git -C "$imported" config core.autocrlf false
mkdir -p "$imported/repeater/protocol/src"
echo 'pub fn roster() {}' > "$imported/repeater/protocol/src/lib.rs"
git -C "$imported" add -A
git -C "$imported" commit --quiet -m "feat(repeater)!: a whole other product's history"
git -C "$work" fetch --quiet "$imported" HEAD
git -C "$work" merge --quiet --allow-unrelated-histories --no-edit -m "chore: import" FETCH_HEAD
assert_bump "imported history is not an app release" false none 1.0.0

# A branch made BEFORE the previous tag and merged after it still counts.
git -C "$work" checkout --quiet -b old-branch v1.4.0
commit_in src/old.ts "feat(map): finished on a branch older than the last release"
git -C "$work" checkout --quiet -
git -C "$work" merge --quiet --no-ff --no-edit -m "merge an old branch" old-branch
assert_bump "a branch older than the previous tag still counts" true minor 1.1.0

git -C "$work" tag v1.7.0
commit_in repeater/protocol/src/lib.rs "fix(protocol): built on the imported crate"
assert_bump "work on imported code after the import counts" true patch 1.0.1

# Version bookkeeping is only trustworthy when both manifests agree.
write_manifests 1.0.0
sed -i.bak 's/"version": "1.0.0"/"version": "1.4.0"/' "$work/package.json"
rm -f "$work/package.json.bak"
if next_version >/dev/null 2>&1; then
  echo "Mismatched app.json and package.json versions were accepted." >&2
  exit 1
fi

write_manifests 1.0.0
app_before="$(cat "$work/app.json")"
(cd "$work" && bash scripts/apply-version.sh 2.3.4 >/dev/null)
expect "app.json version" 2.3.4 "$(jq -er '.expo.version' "$work/app.json")"
expect "package.json version" 2.3.4 "$(jq -er '.version' "$work/package.json")"
expect "bundle identifier preserved" com.unrealjune.streetcryptid \
  "$(jq -er '.expo.ios.bundleIdentifier' "$work/app.json")"
changed_lines="$(diff <(printf '%s\n' "$app_before") "$work/app.json" | grep -c '^[<>]' || true)"
expect "app.json touched lines" 2 "$changed_lines"

if (cd "$work" && bash scripts/apply-version.sh 2.3 >/dev/null 2>&1); then
  echo "A malformed version was accepted." >&2
  exit 1
fi

echo "Conventional-commit versioning resolved every release scenario."
