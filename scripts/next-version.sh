#!/usr/bin/env bash

# Decide the next release version from the commits since the last release tag.
#
# Conventional Commit markers steer the bump, but most of this repository's history is freeform, so
# an unrecognized subject counts as a shipping change (patch) rather than nothing at all:
#
#   `!` after the type, or a `BREAKING CHANGE:` footer  -> major
#   `feat:`                                             -> minor
#   anything else that is not housekeeping              -> patch
#   only docs/chore/ci/test/style/build/refactor        -> no release
#
# The user-facing version (`expo.version` in app.json) is ours to manage; the developer-facing
# build versions (ios.buildNumber / android.versionCode) stay on EAS's remote version source, so
# this script deliberately never touches them.
#
# Usage:
#   scripts/next-version.sh [--force auto|patch|minor|major]
#
# Prints `key=value` lines on stdout:
#   release=true|false     whether a release should happen at all
#   bump=<reason>          major | minor | patch | initial | forced-<level> | none
#   version=<x.y.z>        the version to release (unchanged from app.json when bump=initial)
#   previous_version       the version currently in app.json
#   previous_tag           the tag the commit range started from (empty on the first release)
#   tag=v<x.y.z>
#
# Requires the full git history and tags (actions/checkout with fetch-depth: 0). Only `v*` tags are
# app releases; the imported trail-stash tags were renamed to `server-v*` so `--match` skips them.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
force='auto'

while (($#)); do
  case "$1" in
    --force)
      shift
      force="${1:-}"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$force" in
  auto | patch | minor | major | '') ;;
  *)
    echo "--force expects auto, patch, minor, or major." >&2
    exit 2
    ;;
esac
if [[ -z "$force" ]]; then
  force='auto'
fi

current="$(jq -er '.expo.version | strings' "$repo_root/app.json")"
if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "app.json expo.version must be a plain MAJOR.MINOR.PATCH version, found: $current" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"

package_version="$(jq -er '.version | strings' "$repo_root/package.json")"
if [[ "$package_version" != "$current" ]]; then
  echo "package.json version ($package_version) and app.json expo.version ($current) disagree." >&2
  exit 1
fi

previous_tag="$(git -C "$repo_root" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"

emit() {
  local release="$1" bump="$2" version="$3"
  printf 'release=%s\n' "$release"
  printf 'bump=%s\n' "$bump"
  printf 'version=%s\n' "$version"
  printf 'previous_version=%s\n' "$current"
  printf 'previous_tag=%s\n' "$previous_tag"
  printf 'tag=v%s\n' "$version"
}

apply_bump() {
  case "$1" in
    major) printf '%s.0.0\n' "$((major + 1))" ;;
    minor) printf '%s.%s.0\n' "$major" "$((minor + 1))" ;;
    patch) printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))" ;;
    *)
      echo "Unsupported bump: $1" >&2
      exit 2
      ;;
  esac
}

if [[ "$force" != 'auto' ]]; then
  emit true "forced-$force" "$(apply_bump "$force")"
  exit 0
fi

# No release tag yet: ship whatever app.json already declares rather than replaying the entire
# history of the repository through the Conventional Commit rules.
if [[ -z "$previous_tag" ]]; then
  emit true initial "$current"
  exit 0
fi

# Merge commits carry the branch name, not a Conventional Commit subject, so they never decide a
# bump. Squash-merged pull requests keep their subject and do.
#
# The repeater server and the Windows repeater release under their own tags (`server-v*`,
# `windows-v*`), so a commit confined to them must not cut a store release. `repeater/protocol/`
# still counts: the phone links it.
app_paths=(-- . ':!repeater/server' ':!repeater/windows')
subjects="$(git -C "$repo_root" log --no-merges --format='%s' "$previous_tag..HEAD" "${app_paths[@]}")"
bodies="$(git -C "$repo_root" log --no-merges --format='%B' "$previous_tag..HEAD" "${app_paths[@]}")"

# Most of this repository's history predates Conventional Commits, so an unrecognized subject is
# treated as a shipping change and earns a patch. Only commits that are explicitly housekeeping
# are ignored, and a push made up entirely of them releases nothing.
housekeeping='^(docs|chore|ci|test|style|build|refactor)(\([^)]*\))?:'

level='none'
if [[ -n "$subjects" ]] && grep -Evq "$housekeeping" <<<"$subjects"; then
  level='patch'
fi
if [[ "$level" != 'none' ]] && grep -Eq '^feat(\([^)]*\))?:' <<<"$subjects"; then
  level='minor'
fi
if [[ -n "$subjects" ]] &&
  { grep -Eq '^[a-zA-Z]+(\([^)]*\))?!:' <<<"$subjects" ||
    grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; }; then
  level='major'
fi

if [[ "$level" == 'none' ]]; then
  emit false none "$current"
  exit 0
fi

emit true "$level" "$(apply_bump "$level")"
