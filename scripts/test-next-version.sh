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
mkdir -p "$work/scripts"
cp "$repo_root/scripts/next-version.sh" "$repo_root/scripts/apply-version.sh" "$work/scripts/"

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

commit() {
  local message="$1"
  git -C "$work" commit --quiet --allow-empty -m "$message"
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

assert_unreleased() {
  local label="$1" expected="$2"
  expect "$label unreleased" "$expected" "$(field unreleased "$(next_version)")"
}

# What the version job does: rewrite both manifests, commit the bump, then tag it.
commit_bump() {
  local version="$1"
  (cd "$work" && bash scripts/apply-version.sh "$version" >/dev/null)
  git -C "$work" add app.json package.json
  commit "chore(release): v$version"
}

release() {
  commit_bump "$1"
  git -C "$work" tag "v$1"
}

git -C "$work" init --quiet
git -C "$work" config user.email "release-test@example.com"
git -C "$work" config user.name "Release Test"
write_manifests 1.0.0
git -C "$work" add -A
commit "chore: initial commit"

assert_bump "untagged repository" true initial 1.0.0
assert_unreleased "untagged repository" ''
git -C "$work" tag v1.0.0

assert_bump "no releasable commits" false none 1.0.0
assert_unreleased "app.json matches the tag" ''
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

release 2.0.0
assert_bump "range starts at the newest tag" false none 2.0.0

commit "$(printf 'fix(net): retry relay dials\n\nBREAKING CHANGE: relay URLs must include a port.')"
assert_bump "breaking change footer" true major 3.0.0

# A run that commits its bump and then fails to push the tag leaves app.json ahead of every
# release. The next run must finish that version, not bump again from it (2026-11-10: v3.0.0 was
# committed, never tagged, and the next push would have released 4.0.0).
commit_bump 3.0.0
assert_unreleased "bump committed, tag missing" 3.0.0
assert_bump "unfinished major is finished, not re-bumped" true major 3.0.0
assert_bump "forced bump starts from the last tag" true forced-minor 2.1.0 --force minor
commit "fix(map): keep labels upright"
assert_bump "newer commits keep the unfinished major" true major 3.0.0
# The resumed run finds app.json already at 3.0.0 and tags without a second bump commit.
git -C "$work" tag v3.0.0
assert_unreleased "unfinished release tagged" ''
assert_bump "nothing left after the resumed release" false none 3.0.0

commit "fix(net): retry relay dials once more"
commit_bump 3.0.1
commit "fix(net): and once more"
assert_bump "a fix after an unfinished patch stays on it" true patch 3.0.1
commit "feat(map): draw ferries"
assert_bump "a feat after an unfinished patch" true minor 3.1.0
release 3.1.0

# Merge commits carry a branch description rather than a Conventional Commit subject, so a merge
# must not be able to promote a release on its own.
git -C "$work" checkout --quiet -b topic
commit "chore: shuffle comments"
git -C "$work" checkout --quiet -
git -C "$work" merge --quiet --no-ff -m "feat: merge the topic branch" topic
assert_bump "merge subject ignored" false none 3.1.0

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
