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
# The bump is applied to the last release TAG, not to app.json. The two agree after every release
# that finished, but a run that commits its bump and then fails to push the tag leaves app.json
# ahead of anything shipped: v3.0.0 was committed that way on 2026-11-10, and bumping from app.json
# would have made the next push release 4.0.0. `unreleased` reports that state so the workflow can
# stop and let someone choose, rather than ship a version nobody confirmed.
#
# Prints `key=value` lines on stdout:
#   release=true|false     whether a release should happen at all
#   bump=<reason>          major | minor | patch | initial | forced-<level> | none
#   version=<x.y.z>        the version to release (unchanged from app.json when bump=initial)
#   previous_version       the last released version (app.json's when nothing is tagged yet)
#   previous_tag           the tag the commit range started from (empty on the first release)
#   unreleased=<x.y.z>     app.json's version when it differs from the last tag, otherwise empty
#   tag=v<x.y.z>
#
# Requires the full git history and tags (actions/checkout with fetch-depth: 0). Only `v*` tags are
# app releases; the imported trail-stash tags were renamed to `server-v*` so `--match` skips them.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/conventional-commits.sh
source "$repo_root/scripts/lib/conventional-commits.sh"
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
if [[ ! "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "app.json expo.version must be a plain MAJOR.MINOR.PATCH version, found: $current" >&2
  exit 1
fi

package_version="$(jq -er '.version | strings' "$repo_root/package.json")"
if [[ "$package_version" != "$current" ]]; then
  echo "package.json version ($package_version) and app.json expo.version ($current) disagree." >&2
  exit 1
fi

previous_tag="$(git -C "$repo_root" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"

base="$current"
unreleased=''
if [[ -n "$previous_tag" ]]; then
  base="${previous_tag#v}"
  if [[ "$current" != "$base" ]]; then
    unreleased="$current"
  fi
fi
if [[ ! "$base" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "The last release tag must be a plain vMAJOR.MINOR.PATCH, found: $previous_tag" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"

emit() {
  local release="$1" bump="$2" version="$3"
  printf 'release=%s\n' "$release"
  printf 'bump=%s\n' "$bump"
  printf 'version=%s\n' "$version"
  printf 'previous_version=%s\n' "$base"
  printf 'previous_tag=%s\n' "$previous_tag"
  printf 'unreleased=%s\n' "$unreleased"
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

# The repeater server and the Windows repeater release under their own tags (`server-v*`,
# `windows-v*`), so a commit confined to them must not cut a store release. `repeater/protocol/`
# still counts: the phone links it. Which commits count, and how far they bump, is shared with the
# repeaters' releases (scripts/lib/conventional-commits.sh).
#
# Nor does a commit confined to what never ships in the app: CI and release workflows, docs, the
# justfile and the repository's ignore/attribute files. `apps/repeater` is the Windows client's
# home before it moved to repeater/windows -- a path filter does not follow a rename, and its
# history arrived in one merge (#192).
app_commits=()
while IFS= read -r commit; do
  app_commits+=("$commit")
done < <(release_commits "$repo_root" "$previous_tag" . \
  ':!repeater/server' ':!repeater/windows' ':!apps/repeater' \
  ':!.github' ':!docs' ':!justfile' ':!.gitattributes' ':!.prettierignore')

level="$(bump_level "$repo_root" ${app_commits[@]+"${app_commits[@]}"})"

if [[ "$level" == 'none' ]]; then
  emit false none "$base"
  exit 0
fi

emit true "$level" "$(apply_bump "$level")"
