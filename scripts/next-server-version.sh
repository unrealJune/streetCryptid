#!/usr/bin/env bash

# Decide the repeater server's next release from the commits since its last `server-v*` tag, by
# the same Conventional Commit rules as the app (scripts/lib/conventional-commits.sh).
#
# What counts is what goes into the image or the chart: the server crate and its chart, the
# protocol it links, and what the root Cargo workspace feeds every build. A commit that touches
# only the app never releases the server, and vice versa.
#
# The tag is the version of record. `version` in repeater/server/Cargo.toml is not read: nothing
# in the server reports it, and keeping it in step would mean a release commit on main.
#
# Usage:
#   scripts/next-server-version.sh [--force auto|patch|minor|major]
#
# Prints `key=value` lines on stdout:
#   release=true|false     whether a release should happen at all
#   bump=<reason>          major | minor | patch | initial | forced-<level> | none
#   version=<x.y.z>        the version to release (the previous one when release=false)
#   previous_tag           the tag the commit range started from (empty on the first release)
#   tag=server-v<x.y.z>
#
# Requires the full git history and tags (actions/checkout with fetch-depth: 0).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/conventional-commits.sh
source "$repo_root/scripts/lib/conventional-commits.sh"

prefix='server-v'
initial='0.1.0'
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
  auto | patch | minor | major) ;;
  '') force='auto' ;;
  *)
    echo "--force expects auto, patch, minor, or major." >&2
    exit 2
    ;;
esac

# Everything the published image and chart are built from.
server_paths=(
  repeater/server
  repeater/protocol
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  third_party
  .dockerignore
)

previous_tag="$(git -C "$repo_root" describe --tags --abbrev=0 --match "${prefix}[0-9]*.[0-9]*.[0-9]*" 2>/dev/null || true)"
previous="${previous_tag#"$prefix"}"

emit() {
  local release="$1" bump="$2" version="$3"
  printf 'release=%s\n' "$release"
  printf 'bump=%s\n' "$bump"
  printf 'version=%s\n' "$version"
  printf 'previous_tag=%s\n' "$previous_tag"
  printf 'tag=%s%s\n' "$prefix" "$version"
}

if [[ -z "$previous_tag" ]]; then
  emit true initial "$initial"
  exit 0
fi

if [[ "$force" != 'auto' ]]; then
  emit true "forced-$force" "$(bump_version "$previous" "$force")"
  exit 0
fi

commits=()
while IFS= read -r commit; do
  commits+=("$commit")
done < <(release_commits "$repo_root" "$previous_tag" "${server_paths[@]}")

level="$(bump_level "$repo_root" ${commits[@]+"${commits[@]}"})"
if [[ "$level" == none ]]; then
  emit false none "$previous"
  exit 0
fi

emit true "$level" "$(bump_version "$previous" "$level")"
